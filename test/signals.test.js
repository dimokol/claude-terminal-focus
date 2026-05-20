const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { parseSignal, claimHandled, CLAIM_STALE_MS } = require('../lib/signals');

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

test('CONCURRENCY: 50 concurrent claimHandled on a STALE marker — exactly ONE wins', async () => {
  // The pre-3.5.3 stale-recovery branch had a subtle stat→unlink→write race
  // where two processes could both pass the staleness check, both unlink
  // (one ENOENTs silently), and both succeed on the final write. This is
  // the regression test for that fix — without it, multiple workers could
  // return true and we'd see the user's duplicate-notification bug.

  const workerScript = path.join(__dirname, 'fixtures', 'claim-worker.js');
  fs.mkdirSync(path.dirname(workerScript), { recursive: true });
  fs.writeFileSync(workerScript, `
const { claimHandled } = require('${path.join(__dirname, '..', 'lib', 'signals').replace(/\\\\/g, '/')}');
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
