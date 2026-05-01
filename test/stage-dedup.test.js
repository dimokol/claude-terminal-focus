const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shouldNotify, advanceOnPrompt, markResolved, _readSessions } = require('../lib/stage-dedup');

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

test('different event type after resolve advances stage and notifies', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  markResolved(root, 'sess-a');
  const res = shouldNotify(root, 'sess-a', 'waiting');
  assert.strictEqual(res.notify, true);
  assert.strictEqual(res.stageId, 2);
});

test('resolved stage advances on next event even if same type', () => {
  const root = tmpWorkspace();
  shouldNotify(root, 'sess-a', 'completed');
  markResolved(root, 'sess-a');
  const res = shouldNotify(root, 'sess-a', 'completed');
  assert.strictEqual(res.notify, true);
  assert.strictEqual(res.stageId, 2);
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

test('missing session_id treats as unique per call', () => {
  const root = tmpWorkspace();
  // Empty string session: we still notify (defensive — we don't dedup without a key)
  const r1 = shouldNotify(root, '', 'completed');
  const r2 = shouldNotify(root, '', 'completed');
  assert.strictEqual(r1.notify, true);
  assert.strictEqual(r2.notify, true);
});
