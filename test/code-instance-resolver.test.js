const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isVsCodeBinary,
  findCodeAncestorPid,
  resolveCodeInstancePid
} = require('../lib/code-instance-resolver');

function mkSnapshot(procs) {
  return { procs: new Map(procs.map(p => [p.pid, p])) };
}

test('isVsCodeBinary matches stable, insiders, and common forks', () => {
  assert.equal(isVsCodeBinary('Code.exe'), true);
  assert.equal(isVsCodeBinary('Code - Insiders.exe'), true);
  assert.equal(isVsCodeBinary('VSCodium.exe'), true);
  assert.equal(isVsCodeBinary('Codium.exe'), true);
  assert.equal(isVsCodeBinary('Cursor.exe'), true);
  assert.equal(isVsCodeBinary('Windsurf.exe'), true);
});

test('isVsCodeBinary is case-insensitive', () => {
  assert.equal(isVsCodeBinary('CODE.EXE'), true);
  assert.equal(isVsCodeBinary('code.exe'), true);
  assert.equal(isVsCodeBinary('cursor.EXE'), true);
});

test('isVsCodeBinary rejects unrelated executables', () => {
  assert.equal(isVsCodeBinary('powershell.exe'), false);
  assert.equal(isVsCodeBinary('node.exe'), false);
  assert.equal(isVsCodeBinary('bash.exe'), false);
  assert.equal(isVsCodeBinary('NotCode.exe'), false);
  assert.equal(isVsCodeBinary('Codecov.exe'), false);
  assert.equal(isVsCodeBinary(''), false);
  assert.equal(isVsCodeBinary(undefined), false);
  assert.equal(isVsCodeBinary(null), false);
});

test('findCodeAncestorPid returns the renderer PID for a single Claude session', () => {
  // Realistic chain: claude → pwsh → conhost helper → renderer Code.exe → main Code.exe
  const snap = mkSnapshot([
    { pid: 100, ppid: 0,   name: 'Code.exe' },              // main
    { pid: 101, ppid: 100, name: 'Code.exe' },              // renderer
    { pid: 102, ppid: 101, name: 'WindowsTerminal.exe' },   // terminal helper
    { pid: 103, ppid: 102, name: 'pwsh.exe' },              // shell
    { pid: 104, ppid: 103, name: 'node.exe' },              // claude
    { pid: 105, ppid: 104, name: 'node.exe' }               // hook.js (start point)
  ]);
  // First Code.exe ancestor of pid 105 is the renderer at depth 4.
  assert.equal(findCodeAncestorPid(105, snap.procs), 101);
});

test('findCodeAncestorPid returns 0 when no ancestor is Code.exe', () => {
  const snap = mkSnapshot([
    { pid: 1, ppid: 0, name: 'init' },
    { pid: 2, ppid: 1, name: 'bash' },
    { pid: 3, ppid: 2, name: 'node' }
  ]);
  assert.equal(findCodeAncestorPid(3, snap.procs), 0);
});

test('findCodeAncestorPid handles a cycle without infinite loop', () => {
  // Pathological: pid 5 claims pid 5 as parent. Should not loop.
  const snap = mkSnapshot([
    { pid: 5, ppid: 5, name: 'bash' }
  ]);
  assert.equal(findCodeAncestorPid(5, snap.procs), 0);
});

test('findCodeAncestorPid stops at maxDepth', () => {
  // Build a 50-deep chain of non-Code.exe processes; with maxDepth=10
  // we should give up early.
  const procs = [];
  for (let i = 1; i <= 50; i++) {
    procs.push({ pid: i, ppid: i - 1, name: 'shell.exe' });
  }
  const snap = mkSnapshot(procs);
  assert.equal(findCodeAncestorPid(50, snap.procs, 10), 0);
});

test('REGRESSION: multi-instance — resolves to the SPECIFIC instance Claude is in, never the other', () => {
  // Two separate VS Code instances running. Same workspace open in both.
  // Claude is running in Instance B. The click marker carries B's PID
  // chain. The resolver must return B's renderer (PID 201), never A's.
  const snap = mkSnapshot([
    // --- Instance A ---
    { pid: 100, ppid: 0,   name: 'Code.exe' },              // A main
    { pid: 101, ppid: 100, name: 'Code.exe' },              // A renderer
    { pid: 102, ppid: 101, name: 'pwsh.exe' },              // A's shell
    { pid: 103, ppid: 102, name: 'node.exe' },              // A's idle claude (not the one that fired)
    // --- Instance B ---
    { pid: 200, ppid: 0,   name: 'Code.exe' },              // B main
    { pid: 201, ppid: 200, name: 'Code.exe' },              // B renderer
    { pid: 202, ppid: 201, name: 'pwsh.exe' },              // B's shell (where Claude fired)
    { pid: 203, ppid: 202, name: 'node.exe' },              // B's claude
    { pid: 204, ppid: 203, name: 'node.exe' }               // B's hook.js
  ]);

  // The click marker captured B's chain: pids = [204, 203, 202, 201, 200].
  const pidsFromMarker = [204, 203, 202, 201, 200];
  assert.equal(resolveCodeInstancePid(pidsFromMarker, snap), 201);

  // Sanity: if the marker had been A's chain instead, we'd resolve to A.
  const pidsFromA = [103, 102, 101, 100];
  assert.equal(resolveCodeInstancePid(pidsFromA, snap), 101);
});

test('resolveCodeInstancePid prefers the shortest-walk match across multiple PIDs', () => {
  // Marker has two PIDs: one walks 4 hops to renderer A (PID 101), the
  // other walks 1 hop to renderer B (PID 201). Prefer the closer match —
  // that's the Code.exe most directly owning the work.
  const snap = mkSnapshot([
    { pid: 100, ppid: 0,   name: 'Code.exe' },
    { pid: 101, ppid: 100, name: 'Code.exe' },              // renderer A — distant
    { pid: 102, ppid: 101, name: 'pwsh.exe' },
    { pid: 103, ppid: 102, name: 'node.exe' },
    { pid: 104, ppid: 103, name: 'node.exe' },              // 4 hops to renderer A
    { pid: 200, ppid: 0,   name: 'Code.exe' },
    { pid: 201, ppid: 200, name: 'Code.exe' },              // renderer B — closer
    { pid: 202, ppid: 201, name: 'pwsh.exe' }               // 1 hop to renderer B
  ]);
  assert.equal(resolveCodeInstancePid([104, 202], snap), 201);
});

test('resolveCodeInstancePid returns 0 for empty/invalid input', () => {
  const snap = mkSnapshot([]);
  assert.equal(resolveCodeInstancePid([], snap), 0);
  assert.equal(resolveCodeInstancePid(null, snap), 0);
  assert.equal(resolveCodeInstancePid([1, 2, 3], null), 0);
  assert.equal(resolveCodeInstancePid([0, -1, NaN], snap), 0);
});

test('resolveCodeInstancePid gracefully handles missing nodes mid-chain', () => {
  // Pid 5 references parent 99 which is not in the snapshot (e.g. process
  // exited between snapshot and lookup). Should return 0, not throw.
  const snap = mkSnapshot([
    { pid: 5, ppid: 99, name: 'bash.exe' }
  ]);
  assert.equal(resolveCodeInstancePid([5], snap), 0);
});

test('resolveCodeInstancePid works when the start PID itself IS the renderer', () => {
  // Edge case: marker somehow has the renderer PID directly.
  const snap = mkSnapshot([
    { pid: 100, ppid: 0,   name: 'Code.exe' },
    { pid: 101, ppid: 100, name: 'Code.exe' }
  ]);
  assert.equal(resolveCodeInstancePid([101], snap), 101);
});
