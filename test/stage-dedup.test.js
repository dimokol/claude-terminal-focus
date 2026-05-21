const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shouldNotify, advanceOnPrompt, markResolved, _readSessions, STAGE_ESCAPE_VALVE_MS } = require('../lib/stage-dedup');
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

test('escape valve: same-stage event after window notifies and bumps stage', () => {
  // Models the AskUserQuestion case: an unresolved stage receives a new
  // Notification event seconds after the last one, with no upstream ack.
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  backdateLastNotified(root, 'sess-a', STAGE_ESCAPE_VALVE_MS + 500);
  const res = shouldNotify(root, 'sess-a', 'waiting');
  assert.strictEqual(res.notify, true, 'delayed same-stage event must fire');
  assert.strictEqual(res.stageId, 2, 'escape valve must bump stageId so click payload tracks the new wait');
  const entry = _readSessions(root)['sess-a'];
  assert.strictEqual(entry.lastEvent, 'waiting');
  assert.strictEqual(entry.resolved, false);
});

test('missing session_id treats as unique per call', () => {
  const root = tmpWorkspace();
  // Empty string session: we still notify (defensive — we don't dedup without a key)
  const r1 = shouldNotify(root, '', 'completed');
  const r2 = shouldNotify(root, '', 'completed');
  assert.strictEqual(r1.notify, true);
  assert.strictEqual(r2.notify, true);
});
