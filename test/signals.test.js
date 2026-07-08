const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { parseSignal, claimHandled, CLAIM_STALE_MS, CLAIM_CROSS_STAGE_STEAL_MS } = require('../lib/signals');

test('parseSignal v2 returns aiTitle when present', () => {
  const content = JSON.stringify({
    version: 2,
    event: 'completed',
    sessionId: 's1',
    project: 'demo',
    pids: [1234],
    aiTitle: 'Refactor router',
    timestamp: Date.now()
  });
  const parsed = parseSignal(content);
  assert.strictEqual(parsed.aiTitle, 'Refactor router');
});

test('parseSignal v2 returns aiTitle="" when missing', () => {
  const content = JSON.stringify({
    version: 2,
    event: 'completed',
    sessionId: 's1',
    project: 'demo',
    pids: [1234],
    timestamp: Date.now()
  });
  const parsed = parseSignal(content);
  assert.strictEqual(parsed.aiTitle, '');
});

test('parseSignal v2 coerces non-string aiTitle to ""', () => {
  const content = JSON.stringify({
    version: 2,
    event: 'completed',
    sessionId: 's1',
    project: 'demo',
    pids: [1234],
    aiTitle: 42,
    timestamp: Date.now()
  });
  const parsed = parseSignal(content);
  assert.strictEqual(parsed.aiTitle, '');
});

test('claimHandled: single caller succeeds on a fresh marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-'));
  const p = path.join(tmp, 'claimed');
  assert.equal(claimHandled(p), true);
  assert.equal(fs.existsSync(p), true);
});

test('claimHandled: second caller fails when marker is fresh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-'));
  const p = path.join(tmp, 'claimed');
  assert.equal(claimHandled(p), true);
  assert.equal(claimHandled(p), false);
});

test('claimHandled: second caller can steal a stale marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-'));
  const p = path.join(tmp, 'claimed');
  // Write a marker and backdate its mtime past CLAIM_STALE_MS.
  fs.writeFileSync(p, 'stale');
  const past = (Date.now() - (CLAIM_STALE_MS + 2000)) / 1000;
  fs.utimesSync(p, past, past);
  assert.equal(claimHandled(p), true);
});

// --- cross-stage claim tags (v3.6.0) ---
//
// Regression for the notification-swallow window: stage-dedup approves a
// genuinely new attention point 3s+ after the previous one, but the previous
// stage's claim marker only went stale at 5s — so events landing in the
// 3–5s gap were silently dropped (ZERO notifications, breaking the "never
// zero" invariant). Tagged claims fix it: a claimant carrying a different
// sessionId:stageId may steal after CLAIM_CROSS_STAGE_STEAL_MS.

function backdateFile(p, msAgo) {
  const past = (Date.now() - msAgo) / 1000;
  fs.utimesSync(p, past, past);
}

test('claim tags: same tag within staleMs is suppressed (same-point straggler)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-tag-'));
  const p = path.join(tmp, 'claimed');
  assert.equal(claimHandled(p, { tag: 'sess-a:3' }), true);
  backdateFile(p, CLAIM_CROSS_STAGE_STEAL_MS + 500); // past cross-tag, inside staleMs
  assert.equal(claimHandled(p, { tag: 'sess-a:3' }), false,
    'same attention point must stay suppressed until CLAIM_STALE_MS');
});

test('claim tags: different tag steals after CLAIM_CROSS_STAGE_STEAL_MS (3–5s window fix)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-tag-'));
  const p = path.join(tmp, 'claimed');
  assert.equal(claimHandled(p, { tag: 'sess-a:3' }), true);
  backdateFile(p, CLAIM_CROSS_STAGE_STEAL_MS + 500); // e.g. ~4s after the Q1 claim
  assert.equal(claimHandled(p, { tag: 'sess-a:4' }), true,
    'a NEW stage arriving 3–5s later must not be swallowed by the old claim');
});

test('claim tags: different tag within CLAIM_CROSS_STAGE_STEAL_MS is still suppressed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-tag-'));
  const p = path.join(tmp, 'claimed');
  assert.equal(claimHandled(p, { tag: 'sess-a:3' }), true);
  // Fresh marker — a different-tag claimant arriving inside the handshake
  // spread must not steal (could still be racing the same physical burst).
  assert.equal(claimHandled(p, { tag: 'sess-b:1' }), false);
});

test('claim tags: untagged legacy marker keeps conservative same-tag rules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-tag-'));
  const p = path.join(tmp, 'claimed');
  fs.writeFileSync(p, String(Date.now())); // legacy format, no tag
  backdateFile(p, CLAIM_CROSS_STAGE_STEAL_MS + 500);
  assert.equal(claimHandled(p, { tag: 'sess-a:2' }), false,
    'no tag on the marker → cannot prove different stage → keep 5s rule');
  backdateFile(p, CLAIM_STALE_MS + 500);
  assert.equal(claimHandled(p, { tag: 'sess-a:2' }), true, 'stale by the 5s rule → steal');
});

test('claim tags: legacy numeric staleMs argument still works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-tag-'));
  const p = path.join(tmp, 'claimed');
  fs.writeFileSync(p, 'x');
  backdateFile(p, 1500);
  assert.equal(claimHandled(p, 1000), true, 'number arg = staleMs, marker is stale');
});

// --- parseSignal hardening (v3.6.0) ---

test('parseSignal: torn/partial JSON returns null instead of a bogus v1 signal', () => {
  // A half-written pretty-printed JSON signal contains lines like
  // `  "pids": [` and `    1234,` — the old lenient v1 parser extracted
  // those digits as PIDs and fabricated a pending "waiting" signal with
  // timestamp=now. Must now be rejected outright.
  const torn = '{\n  "version": 2,\n  "event": "completed",\n  "pids": [\n    1234,\n    56';
  assert.strictEqual(parseSignal(torn), null);
});

test('parseSignal: genuine v1 pid-per-line content still parses', () => {
  const parsed = parseSignal('1234\n5678\n');
  assert.strictEqual(parsed.version, 1);
  assert.deepStrictEqual(parsed.pids, [1234, 5678]);
});

test('parseSignal: mixed numeric/non-numeric lines are rejected', () => {
  assert.strictEqual(parseSignal('1234\nhello\n5678'), null);
});

test('parseSignal v2 carries stageId when present, 0 otherwise', () => {
  const base = { version: 2, event: 'waiting', sessionId: 's1', project: 'p', pids: [1], timestamp: Date.now() };
  assert.strictEqual(parseSignal(JSON.stringify({ ...base, stageId: 7 })).stageId, 7);
  assert.strictEqual(parseSignal(JSON.stringify(base)).stageId, 0);
  assert.strictEqual(parseSignal(JSON.stringify({ ...base, stageId: 'x' })).stageId, 0);
});

test('parseSignal v2 carries question text when present', () => {
  const base = { version: 2, event: 'waiting', sessionId: 's1', project: 'p', pids: [1], timestamp: Date.now() };
  assert.strictEqual(parseSignal(JSON.stringify({ ...base, question: 'Deploy now?' })).question, 'Deploy now?');
  assert.strictEqual(parseSignal(JSON.stringify(base)).question, '');
});

test('CONCURRENCY: 50 concurrent claimHandled on a STALE marker — exactly ONE wins', async () => {
  // The pre-3.5.3 stale-recovery branch had a subtle stat→unlink→write race
  // where two processes could both pass the staleness check, both unlink
  // (one ENOENTs silently), and both succeed on the final write. This is
  // the regression test for that fix — without it, multiple workers could
  // return true and we'd see the user's duplicate-notification bug.

  // Relative require so the generated fixture is byte-identical on every
  // machine (an absolute path left the committed file dirty per-machine).
  const workerScript = path.join(__dirname, 'fixtures', 'claim-worker.js');
  fs.mkdirSync(path.dirname(workerScript), { recursive: true });
  fs.writeFileSync(workerScript, `
const { claimHandled } = require('../../lib/signals');
process.send({ ok: claimHandled(process.argv[2]) });
`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-claim-conc-'));
  const p = path.join(tmp, 'claimed');
  fs.writeFileSync(p, 'stale');
  const past = (Date.now() - (CLAIM_STALE_MS + 2000)) / 1000;
  fs.utimesSync(p, past, past);

  const results = await new Promise((resolve) => {
    const out = [];
    let done = 0;
    for (let i = 0; i < 50; i++) {
      const w = fork(workerScript, [p], { silent: true });
      w.on('message', (msg) => out.push(msg));
      w.on('exit', () => { done++; if (done === 50) resolve(out); });
    }
  });

  const winners = results.filter(r => r && r.ok === true).length;
  assert.strictEqual(winners, 1, `exactly one worker should claim a stale marker, got ${winners}`);
});
