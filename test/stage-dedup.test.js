const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shouldNotify, advanceOnPrompt, markResolved, _readSessions, STAGE_ESCAPE_VALVE_MS, PR_NOTIFICATION_BURST_MS } = require('../lib/stage-dedup');
const { stateDir } = require('./helpers');

function backdateLastNotified(root, sessionId, msAgo) {
  const map = _readSessions(root);
  map[sessionId].lastNotifiedAt = Date.now() - msAgo;
  fs.writeFileSync(path.join(stateDir(root), 'sessions'), JSON.stringify(map));
}

let tmpRoot;
function tmpWorkspace() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  return tmpRoot;
}

beforeEach(() => { tmpRoot = null; });

test('first hook for a session notifies and records stage 1', () => {
  const root = tmpWorkspace();
  const res = shouldNotify(root, 'sess-a', 'completed');
  assert.strictEqual(res.notify, true);
  assert.strictEqual(res.stageId, 1);
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.stageId, 1);
  assert.strictEqual(entry.lastEvent, 'completed');
  assert.strictEqual(entry.resolved, false);
});

test('same event type on unresolved stage is suppressed', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  const res = shouldNotify(root, 'sess-a', 'completed');
  assert.strictEqual(res.notify, false);
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.stageId, 1, 'stage must not advance on suppression');
});

test('different event type on unresolved stage is suppressed (Stop→waiting dedup)', () => {
  // Claude Code often emits Stop("completed") immediately followed by
  // Notification("waiting") for the same attention point. They must
  // collapse to a single notification.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  const res = shouldNotify(root, 'sess-a', 'waiting');
  assert.strictEqual(res.notify, false);
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.stageId, 1, 'stage must not advance across event-type change');
  assert.strictEqual(entry.lastEvent, 'waiting', 'lastEvent should track the latest signal');
});

test('different event type after resolve advances stage and notifies (post-burst-window)', () => {
  // Post v3.5.4 burst-after-ack guard: an ack inside the burst window
  // suppresses the immediate follow-up. We backdate lastNotifiedAt so this
  // test exercises the "ack happened long enough ago to be a real new
  // attention point, not a platform burst" path.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  markResolved(root, 'sess-a');
  backdateLastNotified(root, 'sess-a', STAGE_ESCAPE_VALVE_MS + 100);
  const res = shouldNotify(root, 'sess-a', 'waiting');
  assert.strictEqual(res.notify, true);
  assert.strictEqual(res.stageId, 2);
});

test('resolved stage advances on next event even if same type (post-burst-window)', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  markResolved(root, 'sess-a');
  backdateLastNotified(root, 'sess-a', STAGE_ESCAPE_VALVE_MS + 100);
  const res = shouldNotify(root, 'sess-a', 'completed');
  assert.strictEqual(res.notify, true);
  assert.strictEqual(res.stageId, 2);
});

test('burst-after-ack guard: resolve INSIDE burst window suppresses immediate follow-up', () => {
  // Real-world scenario: AskUserQuestion fires PR + Notification ~1s apart.
  // User clicks the OS banner after PR → markResolved fires before
  // Notification arrives. Pre-fix, Notification hit the resolved=true
  // branch and fired a duplicate sound. Fix: while still inside
  // STAGE_ESCAPE_VALVE_MS of the last fired notification, treat the new
  // event as part of the prior stage's platform burst and suppress.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'waiting');   // PR fires
  markResolved(root, 'sess-a');              // user clicks banner
  // No backdating — markResolved happened essentially now, well within
  // the 3s burst window of the just-fired PR.
  const res = shouldNotify(root, 'sess-a', 'waiting');  // Notification arrives
  assert.strictEqual(res.notify, false, 'in-burst follow-up must be suppressed');
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.stageId, 1, 'stage must not advance — still the same attention point');
  assert.strictEqual(entry.resolved, true, 'resolved must remain true; we did not advance');
});

test('burst-after-ack guard: same logic applies regardless of event type pair', () => {
  // Stop→waiting and waiting→completed bursts are both platform pairs;
  // the suppression must collapse either combination.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed'); // Stop
  markResolved(root, 'sess-a');              // fast ack
  const res = shouldNotify(root, 'sess-a', 'waiting'); // Notification arrives
  assert.strictEqual(res.notify, false);
});

test('advanceOnPrompt bumps stageId and clears lastEvent without notifying', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  advanceOnPrompt(root, 'sess-a');
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.stageId, 2);
  assert.strictEqual(entry.lastEvent, null);
  assert.strictEqual(entry.resolved, false);
  // The next Stop/Notification hook should notify.
  const res = shouldNotify(root, 'sess-a', 'completed');
  assert.strictEqual(res.notify, true);
  assert.strictEqual(res.stageId, 2);
});

test('markResolved is a no-op when session has no entry', () => {
  const root = tmpWorkspace();
  markResolved(root, 'nonexistent');
  assert.deepStrictEqual(_readSessions(root), {});
});

test('sessions older than 1h are pruned on write', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'old', 'completed');
  // Backdate
  const map = _readSessions(root);
  map['old'].updatedAt = Date.now() - (60 * 60 * 1000 + 5000);
  fs.writeFileSync(path.join(require('./helpers').stateDir(root), 'sessions'), JSON.stringify(map));
  // Trigger a write
  shouldNotify(root, 'new', 'completed');
  const after = _readSessions(root);
  assert.ok(!('old' in after), 'old session should be pruned');
  assert.ok('new' in after);
});

test('different sessions do not interfere', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'a', 'completed');
  const b = shouldNotify(root, 'b', 'completed');
  assert.strictEqual(b.notify, true);
  assert.strictEqual(b.stageId, 1);
});

test('escape valve: same-stage event within window stays suppressed', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  // Simulate the next event arriving well inside the burst window.
  backdateLastNotified(root, 'sess-a', 200);
  const res = shouldNotify(root, 'sess-a', 'waiting');
  assert.strictEqual(res.notify, false, 'fresh-burst dupe must still be suppressed');
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.stageId, 1, 'stage must not advance inside the burst window');
});

test('escape valve fires for a PRIMARY event after the window (new question)', () => {
  // A real AskUserQuestion fires PermissionRequest (a primary attention
  // point). After the burst window, a primary must escape and notify even
  // with no upstream ack — this is how question 2+ in a sequence fires.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  backdateLastNotified(root, 'sess-a', STAGE_ESCAPE_VALVE_MS + 500);
  const res = shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  assert.strictEqual(res.notify, true, 'a new PermissionRequest after the window must fire');
  assert.strictEqual(res.stageId, 2, 'must bump stageId so the click payload tracks the new request');
});

test('escape valve does NOT fire for a bare Notification after the window (re-fire suppressed)', () => {
  // The core fix: a Stop notifies, then Claude re-emits a bare "waiting"
  // Notification 60s later for the SAME attention point. The old time-based
  // escape valve let this through as a second notification (the user's
  // "double"). A Notification is a trailer/re-fire, never a new primary, so
  // it must be suppressed regardless of how long ago the last notify was.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed', 'Stop');
  backdateLastNotified(root, 'sess-a', STAGE_ESCAPE_VALVE_MS + 60000);
  const res = shouldNotify(root, 'sess-a', 'waiting', 'Notification');
  assert.strictEqual(res.notify, false, 'a bare Notification re-fire must be suppressed even long after the window');
  assert.strictEqual(_readSessions(root)['sess-a'].stageId, 1, 'stage must not advance on a trailer');
});

test('a completion (Stop) after the window still notifies (finish after a question)', () => {
  // After an AskUserQuestion (PR notified), the user answers (no UPS) and
  // Claude finishes. The Stop is a distinct attention point — it must fire.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  backdateLastNotified(root, 'sess-a', STAGE_ESCAPE_VALVE_MS + 5000);
  const res = shouldNotify(root, 'sess-a', 'completed', 'Stop');
  assert.strictEqual(res.notify, true, 'a completion after the window must fire');
  assert.strictEqual(res.stageId, 2);
});

test('missing session_id treats as unique per call', () => {
  const root = tmpWorkspace();
  // Empty string session: we still notify (defensive — we don't dedup without a key)
  const r1 = shouldNotify(root, '', 'completed');
  const r2 = shouldNotify(root, '', 'completed');
  assert.strictEqual(r1.notify, true);
  assert.strictEqual(r2.notify, true);
});

// PR→Notification burst guard (v3.5.4) — AskUserQuestion's PermissionRequest
// and Notification often fire MORE than 3s apart (focus shifts, slow tool UI,
// user reading the prompt before answering inline). The 3s escape valve was
// firing for Notification, producing two distinct sounds for one logical
// attention point. The PR_NOTIFICATION_BURST_MS=30s window catches this.

test('PR→Notification burst guard: same session, within 30s → Notification suppressed', () => {
  const root = tmpWorkspace();
  // PR fires first.
  const r1 = shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  assert.strictEqual(r1.notify, true);
  assert.strictEqual(r1.stageId, 1);

  // Backdate lastNotifiedAt to simulate 5s gap — past the 3s escape valve,
  // but still inside the PR_NOTIFICATION_BURST_MS=30s window.
  const map = _readSessions(root);
  map['sess-a'].lastNotifiedAt = Date.now() - 5000;
  const fs = require('fs');
  const { stateDir } = require('./helpers');
  fs.writeFileSync(path.join(stateDir(root), 'sessions'), JSON.stringify(map));

  // Notification follows. Pre-fix this hit the escape valve and notified again.
  const r2 = shouldNotify(root, 'sess-a', 'waiting', 'Notification');
  assert.strictEqual(r2.notify, false, 'PR→Notification within 30s must be suppressed as same attention point');
  assert.strictEqual(r2.stageId, 1, 'stage must not advance');

  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.lastHookEventName, 'Notification', 'lastHookEventName must track the latest');
});

test('PR→Notification outside 30s → still suppressed (Notification is always a trailer)', () => {
  // Post-fix: a bare Notification is never a primary attention point, so it
  // is suppressed no matter how long after the PR it arrives. (Previously the
  // escape valve re-fired it after 30s — that was the source of late
  // duplicate pings.) A genuinely new question fires its OWN PermissionRequest,
  // which is covered by the primary-escape test above.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  backdateLastNotified(root, 'sess-a', PR_NOTIFICATION_BURST_MS + 1000);

  const r2 = shouldNotify(root, 'sess-a', 'waiting', 'Notification');
  assert.strictEqual(r2.notify, false, 'a bare Notification trailer must stay suppressed even past 30s');
});

test('Stop→Notification at any gap is suppressed (the trailer/re-fire is not a new point)', () => {
  // This used to assert the OPPOSITE (that a Notification 5s after a Stop
  // fired a second time). That was the root of the user-reported "double":
  // a turn completes (Stop notifies), then Claude emits a bare "waiting"
  // Notification seconds-to-minutes later for the same point. It is a
  // trailer, so it must be suppressed. A genuinely new wait fires its own
  // PermissionRequest, which escapes via the primary path.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed', 'Stop');
  backdateLastNotified(root, 'sess-a', 5000);

  const r2 = shouldNotify(root, 'sess-a', 'waiting', 'Notification');
  assert.strictEqual(r2.notify, false, 'a Notification after a Stop is a trailer — suppress, no double');
});

test('PR→Notification guard does NOT suppress when current event is PR again (new tool call)', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  backdateLastNotified(root, 'sess-a', 5000);

  // A second PR fires (e.g., a different tool needing permission). Should NOT
  // be suppressed by the PR→Notification guard.
  const r2 = shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  assert.strictEqual(r2.notify, true, 'second PR after 5s gap must fire');
});

test('PreToolUse→Notification follows the same burst guard', () => {
  const root = tmpWorkspace();
  // PreToolUse fires for hookable tools other than AskUserQuestion.
  shouldNotify(root, 'sess-a', 'waiting', 'PreToolUse');
  backdateLastNotified(root, 'sess-a', 5000);

  const r2 = shouldNotify(root, 'sess-a', 'waiting', 'Notification');
  assert.strictEqual(r2.notify, false, 'PreToolUse→Notification within 30s must also collapse');
});

test('UserPromptSubmit clears lastHookEventName so next event starts fresh', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'waiting', 'PermissionRequest');
  advanceOnPrompt(root, 'sess-a');

  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.lastHookEventName, null, 'advanceOnPrompt clears lastHookEventName');

  // A Notification arriving now should not be suppressed by the PR guard
  // because the PR-context was cleared by the prompt.
  const r = shouldNotify(root, 'sess-a', 'waiting', 'Notification');
  assert.strictEqual(r.notify, true);
});
