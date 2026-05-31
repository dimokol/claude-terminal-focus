// lib/process-tree.js — cross-platform process tree snapshot.
//
// Used by hook.js to build a reliable PID ancestor chain on Windows.
// The previous per-PID `wmic` approach was slow (one subprocess per
// ancestor), silent on failure, and on newer Windows installs (23H2+)
// `wmic` may be absent entirely. This module:
//   1. Snapshots every running process in one subprocess call.
//   2. Walks parents/descendants in JS using the snapshot.
//   3. Returns process *names*, so the caller can identify shells.
//
// `snapshot()` is impure (spawns a subprocess); `walkUp` and `walkDown`
// are pure functions over a snapshot map and are trivially testable.

const { execSync } = require('child_process');

const WALK_UP_LIMIT = 30;

/**
 * Take a snapshot of every running process. Returns:
 *   { procs: Map<pid, { pid, ppid, name }>, source: 'powershell'|'wmic'|'ps'|'failed' }
 *
 * On any platform, returning `source: 'failed'` is the documented
 * degradation path: callers should still write the signal but the
 * ancestor chain will only contain `process.pid`.
 */
function snapshot() {
  if (process.platform === 'win32') {
    return snapshotWindows();
  }
  return snapshotPosix();
}

function snapshotWindows() {
  // PowerShell + Get-CimInstance is the modern, reliable path. One
  // subprocess (cold start ~150 ms), structured JSON output.
  try {
    const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const procs = parsePowerShellJson(out);
    if (procs.size > 0) return { procs, source: 'powershell' };
  } catch (_) {}

  // wmic fallback for older Windows. CSV format is more parseable than
  // the default table output. May not exist on Windows 11 23H2+.
  try {
    const out = execSync(
      `wmic process get ProcessId,ParentProcessId,Name /format:csv`,
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const procs = parseWmicCsv(out);
    if (procs.size > 0) return { procs, source: 'wmic' };
  } catch (_) {}

  return { procs: new Map(), source: 'failed' };
}

function snapshotPosix() {
  try {
    const out = execSync('ps -A -o pid=,ppid=,comm=', {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const procs = parsePsOutput(out);
    if (procs.size > 0) return { procs, source: 'ps' };
  } catch (_) {}
  return { procs: new Map(), source: 'failed' };
}

function parsePowerShellJson(text) {
  const procs = new Map();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return procs;
  }
  // Single-object case when there's only one process (rare in practice).
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const pid = toInt(row.ProcessId);
    const ppid = toInt(row.ParentProcessId);
    const name = typeof row.Name === 'string' ? row.Name : '';
    if (pid > 0) procs.set(pid, { pid, ppid, name });
  }
  return procs;
}

function parseWmicCsv(text) {
  // CSV columns vary by Windows version, but the header line names them.
  // Typical: Node,Name,ParentProcessId,ProcessId
  const procs = new Map();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return procs;
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const pidIdx = header.indexOf('processid');
  const ppidIdx = header.indexOf('parentprocessid');
  if (pidIdx < 0 || ppidIdx < 0) return procs;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const pid = toInt(cols[pidIdx]);
    const ppid = toInt(cols[ppidIdx]);
    const name = nameIdx >= 0 ? (cols[nameIdx] || '').trim() : '';
    if (pid > 0) procs.set(pid, { pid, ppid, name });
  }
  return procs;
}

function parsePsOutput(text) {
  const procs = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = toInt(m[1]);
    const ppid = toInt(m[2]);
    const name = m[3].trim();
    if (pid > 0) procs.set(pid, { pid, ppid, name });
  }
  return procs;
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Walk up the parent chain starting at `pid`. Pure over the snapshot.
 * Stops at the root, at a cycle, or at `limit` (defensive — process trees
 * are normally shallow). Returns the chain including `pid` itself.
 */
function walkUp(snapshotResult, pid, limit = WALK_UP_LIMIT) {
  const { procs } = snapshotResult;
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (current && current > 0 && chain.length < limit) {
    if (seen.has(current)) break;
    seen.add(current);
    const node = procs.get(current);
    if (!node) {
      // The starting pid itself may not be in the snapshot if it spawned
      // after the snapshot. Record what we know (pid only) and stop.
      chain.push({ pid: current, ppid: 0, name: '' });
      break;
    }
    chain.push(node);
    if (!node.ppid || node.ppid === current) break;
    current = node.ppid;
  }
  return chain;
}

/**
 * Return the set of `rootPid` and all transitive descendants. Pure.
 */
function walkDown(snapshotResult, rootPid) {
  const { procs } = snapshotResult;
  const childIndex = new Map(); // ppid -> [pid, ...]
  for (const node of procs.values()) {
    if (!node.ppid) continue;
    if (!childIndex.has(node.ppid)) childIndex.set(node.ppid, []);
    childIndex.get(node.ppid).push(node.pid);
  }
  const result = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (result.has(pid)) continue;
    result.add(pid);
    const children = childIndex.get(pid);
    if (children) stack.push(...children);
  }
  return result;
}

module.exports = {
  snapshot,
  walkUp,
  walkDown,
  // Exposed for tests:
  parsePowerShellJson,
  parseWmicCsv,
  parsePsOutput,
  WALK_UP_LIMIT
};
