// Concurrency regression test for lib/stage-dedup.js. Forks N worker
// processes that all call shouldNotify(workspaceRoot, sameSessionId,
// 'completed') simultaneously, then asserts exactly ONE returns
// {notify:true}. Without the O_EXCL lock around the read-modify-write
// of sessions.json, multiple workers can see "no prior entry" and all
// return notify:true — the user's duplicate-notification bug at
// session start.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const WORKER_SCRIPT = path.join(__dirname, 'fixtures', 'shouldnotify-worker.js');

function ensureWorker() {
  fs.mkdirSync(path.dirname(WORKER_SCRIPT), { recursive: true });
  fs.writeFileSync(WORKER_SCRIPT, `
const { shouldNotify, advanceOnPrompt } = require('${path.join(__dirname, '..', 'lib', 'stage-dedup').replace(/\\\\/g, '/')}');
const [workspaceRoot, sessionId, event, mode] = process.argv.slice(2);
if (mode === 'prompt') {
  advanceOnPrompt(workspaceRoot, sessionId);
  process.send({ notify: null });
} else {
  const result = shouldNotify(workspaceRoot, sessionId, event);
  process.send(result);
}
`);
}

function mkTmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sd-conc-'));
}

function runConcurrent(workspaceRoot, sessionId, event, count) {
  return new Promise((resolve) => {
    const results = [];
    let done = 0;
    const workers = [];
    for (let i = 0; i < count; i++) {
      const w = fork(WORKER_SCRIPT, [workspaceRoot, sessionId, event], { silent: true });
      workers.push(w);
      w.on('message', (msg) => results.push(msg));
      w.on('exit', () => {
        done++;
        if (done === count) resolve(results);
      });
    }
  });
}

test('CONCURRENCY: 50 simultaneous shouldNotify calls for a new session yield exactly ONE notify=true', async () => {
  ensureWorker();
  const root = mkTmpWorkspace();
  const sessionId = 'concurrent-new-session';
  const results = await runConcurrent(root, sessionId, 'completed', 50);

  const notifyTrueCount = results.filter(r => r && r.notify === true).length;
  const notifyFalseCount = results.filter(r => r && r.notify === false).length;

  assert.equal(results.length, 50, 'all workers returned a result');
  assert.equal(notifyTrueCount, 1, `exactly one notify=true, got ${notifyTrueCount}`);
  assert.equal(notifyFalseCount, 49, `the other 49 should be notify=false, got ${notifyFalseCount}`);
});

test('CONCURRENCY: post-prompt burst — advanceOnPrompt then 20 shouldNotify calls yield exactly ONE notify=true', async () => {
  ensureWorker();
  const root = mkTmpWorkspace();
  const sessionId = 'concurrent-post-prompt';

  // First seed the session by running advanceOnPrompt to completion.
  await new Promise((resolve) => {
    const w = fork(WORKER_SCRIPT, [root, sessionId, 'completed', 'prompt'], { silent: true });
    w.on('exit', resolve);
  });

  // Now race 20 shouldNotify calls — they all see lastEvent===null
  // (post-prompt fresh stage). Without the lock all 20 would notify;
  // with the lock the first wins and updates lastEvent=current, then
  // the rest see lastEvent!==null and follow the burst-suppression path.
  const results = await runConcurrent(root, sessionId, 'completed', 20);
  const notifyTrueCount = results.filter(r => r && r.notify === true).length;
  assert.equal(notifyTrueCount, 1, `exactly one notify=true after post-prompt burst, got ${notifyTrueCount}`);
});

test('CONCURRENCY: mixed Stop+Notification burst — only ONE notify=true', async () => {
  ensureWorker();
  const root = mkTmpWorkspace();
  const sessionId = 'concurrent-stop-notification-mix';

  // Pre-seed with advanceOnPrompt so we exercise the post-prompt branch.
  await new Promise((resolve) => {
    const w = fork(WORKER_SCRIPT, [root, sessionId, 'completed', 'prompt'], { silent: true });
    w.on('exit', resolve);
  });

  // 10 Stop and 10 Notification workers in parallel — the realistic
  // worst case for Claude Code's Stop+Notification burst.
  const events = [...Array(10).fill('completed'), ...Array(10).fill('waiting')];
  const results = await new Promise((resolve) => {
    const out = [];
    let done = 0;
    for (const ev of events) {
      const w = fork(WORKER_SCRIPT, [root, sessionId, ev], { silent: true });
      w.on('message', (msg) => out.push(msg));
      w.on('exit', () => { done++; if (done === events.length) resolve(out); });
    }
  });

  const notifyTrueCount = results.filter(r => r && r.notify === true).length;
  assert.equal(notifyTrueCount, 1, `mixed Stop/Notification burst should yield exactly one notify=true, got ${notifyTrueCount}`);
});

test('CONCURRENCY: AskUserQuestion escape valve still fires (3-second gap)', { timeout: 15000 }, async () => {
  ensureWorker();
  const root = mkTmpWorkspace();
  const sessionId = 'concurrent-escape-valve';

  // First burst: post-prompt, then one shouldNotify creates the stage.
  await new Promise((resolve) => {
    const w = fork(WORKER_SCRIPT, [root, sessionId, 'completed', 'prompt'], { silent: true });
    w.on('exit', resolve);
  });
  const first = await runConcurrent(root, sessionId, 'completed', 1);
  assert.equal(first[0].notify, true, 'first event after prompt must notify');

  // Wait 3.5 seconds (> STAGE_ESCAPE_VALVE_MS), then fire another
  // event. The escape valve must trigger a fresh-stage notification.
  await new Promise(r => setTimeout(r, 3500));
  const second = await runConcurrent(root, sessionId, 'waiting', 1);
  assert.equal(second[0].notify, true, 'event arriving 3.5s later must trigger escape-valve notify=true');
});
