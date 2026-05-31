const { test } = require('node:test');
const assert = require('node:assert');
const {
  walkUp,
  walkDown,
  parsePowerShellJson,
  parseWmicCsv,
  parsePsOutput
} = require('../lib/process-tree');

function fakeSnap(rows) {
  const procs = new Map();
  for (const r of rows) procs.set(r.pid, r);
  return { procs, source: 'test' };
}

test('walkUp returns single-element chain when ppid is 0', () => {
  const snap = fakeSnap([{ pid: 100, ppid: 0, name: 'init' }]);
  const chain = walkUp(snap, 100);
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].pid, 100);
});

test('walkUp climbs to root', () => {
  const snap = fakeSnap([
    { pid: 1, ppid: 0, name: 'init' },
    { pid: 10, ppid: 1, name: 'shell' },
    { pid: 100, ppid: 10, name: 'claude' },
    { pid: 1000, ppid: 100, name: 'node' }
  ]);
  const chain = walkUp(snap, 1000).map(n => n.pid);
  assert.deepStrictEqual(chain, [1000, 100, 10, 1]);
});

test('walkUp detects cycles', () => {
  const snap = fakeSnap([
    { pid: 10, ppid: 20, name: 'a' },
    { pid: 20, ppid: 10, name: 'b' }
  ]);
  const chain = walkUp(snap, 10);
  assert.ok(chain.length <= 2, 'cycle should not cause infinite walk');
});

test('walkUp respects limit', () => {
  const rows = [];
  for (let i = 1; i <= 50; i++) rows.push({ pid: i, ppid: i - 1, name: `p${i}` });
  const snap = fakeSnap(rows);
  const chain = walkUp(snap, 50, 5);
  assert.strictEqual(chain.length, 5);
});

test('walkUp records starting pid even when missing from snapshot', () => {
  const snap = fakeSnap([{ pid: 10, ppid: 0, name: 'a' }]);
  const chain = walkUp(snap, 9999);
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].pid, 9999);
  assert.strictEqual(chain[0].name, '');
});

test('walkDown returns root and all transitive descendants', () => {
  const snap = fakeSnap([
    { pid: 10, ppid: 0, name: 'root' },
    { pid: 11, ppid: 10, name: 'c1' },
    { pid: 12, ppid: 10, name: 'c2' },
    { pid: 111, ppid: 11, name: 'gc1' },
    { pid: 999, ppid: 0, name: 'unrelated' }
  ]);
  const set = walkDown(snap, 10);
  assert.deepStrictEqual([...set].sort((a, b) => a - b), [10, 11, 12, 111]);
});

test('walkDown returns just the root when it has no children', () => {
  const snap = fakeSnap([{ pid: 10, ppid: 0, name: 'root' }]);
  const set = walkDown(snap, 10);
  assert.deepStrictEqual([...set], [10]);
});

test('parsePowerShellJson handles array output', () => {
  const json = JSON.stringify([
    { ProcessId: 10, ParentProcessId: 1, Name: 'a.exe' },
    { ProcessId: 20, ParentProcessId: 10, Name: 'b.exe' }
  ]);
  const m = parsePowerShellJson(json);
  assert.strictEqual(m.get(10).name, 'a.exe');
  assert.strictEqual(m.get(20).ppid, 10);
});

test('parsePowerShellJson handles single-object output (1 process)', () => {
  const json = JSON.stringify({ ProcessId: 10, ParentProcessId: 1, Name: 'only.exe' });
  const m = parsePowerShellJson(json);
  assert.strictEqual(m.size, 1);
  assert.strictEqual(m.get(10).name, 'only.exe');
});

test('parsePowerShellJson returns empty map for garbage', () => {
  assert.strictEqual(parsePowerShellJson('not json').size, 0);
});

test('parseWmicCsv parses standard wmic output', () => {
  const csv = [
    'Node,Name,ParentProcessId,ProcessId',
    'WIN,explorer.exe,1000,1234',
    'WIN,bash.exe,1234,5678'
  ].join('\n');
  const m = parseWmicCsv(csv);
  assert.strictEqual(m.get(1234).name, 'explorer.exe');
  assert.strictEqual(m.get(5678).ppid, 1234);
});

test('parsePsOutput parses POSIX ps -o pid=,ppid=,comm= output', () => {
  const out = [
    '    1     0 launchd',
    '  100     1 -bash',
    ' 1234   100 node'
  ].join('\n');
  const m = parsePsOutput(out);
  assert.strictEqual(m.get(1).name, 'launchd');
  assert.strictEqual(m.get(100).name, '-bash');
  assert.strictEqual(m.get(1234).ppid, 100);
});
