// lib/code-instance-resolver.js — given a click marker's PID chain plus a
// process-tree snapshot, returns the PID of the specific VS Code instance
// (its renderer Code.exe) that owns those processes.
//
// Why: when an OS-banner click fires the launcher, we have the original
// Claude session's process ancestor chain (captured by hook.js at hook-fire
// time and round-tripped through the toast's claude-notif:// URI). Walking
// up that chain locates a Code.exe ancestor that uniquely identifies the
// VS Code window the Claude session lives in — even when the user has
// multiple VS Code instances open. The launcher then uses Win32
// SetForegroundWindow on that specific HWND instead of routing through
// `code <workspace>` (which goes to a per-user CLI pipe and lands on
// whichever instance was most recently focused — wrong-instance bug).
//
// Pure logic, no spawns — testable on any platform with synthetic fixtures.

'use strict';

// Matches the renderer/main Code.exe binary across stable, insiders, and
// common forks. Matches against the executable basename only — the
// snapshot's `name` field already strips the path.
//   Code.exe                       (stable)
//   Code - Insiders.exe            (insiders, with the space-dash-space)
//   VSCodium.exe / Codium.exe      (forks)
//   Cursor.exe                     (Cursor fork)
//   Windsurf.exe                   (Windsurf fork)
const VS_CODE_BINARY_PATTERN = /^(Code( - Insiders)?|VSCodium|Codium|Cursor|Windsurf)\.exe$/i;

const DEFAULT_MAX_DEPTH = 30;

function isVsCodeBinary(name) {
  if (typeof name !== 'string') return false;
  return VS_CODE_BINARY_PATTERN.test(name);
}

/**
 * Walk up from a single PID, return the first Code.exe-flavored ancestor's
 * PID, or 0 if not found within `maxDepth` hops.
 *
 * @param {number} startPid
 * @param {Map<number, {pid:number, ppid:number, name:string}>} procs
 * @param {number} [maxDepth]
 * @returns {number}
 */
function findCodeAncestorPid(startPid, procs, maxDepth = DEFAULT_MAX_DEPTH) {
  if (!procs || typeof procs.get !== 'function') return 0;
  if (!Number.isInteger(startPid) || startPid <= 0) return 0;

  let current = startPid;
  const seen = new Set();
  for (let i = 0; i < maxDepth; i++) {
    if (seen.has(current)) return 0;
    seen.add(current);
    const node = procs.get(current);
    if (!node) return 0;
    if (isVsCodeBinary(node.name)) return node.pid;
    if (!node.ppid || node.ppid === current) return 0;
    current = node.ppid;
  }
  return 0;
}

/**
 * Resolve the renderer-Code.exe PID owning a click marker's PID chain.
 *
 * Strategy:
 *   1. Try each PID in the marker's chain, walking up to find the first
 *      Code.exe-flavored ancestor. The first match wins.
 *   2. If multiple PIDs in the chain resolve to different Code.exe
 *      ancestors (which can happen if the chain spans process spawns
 *      across instances — rare but possible), prefer the one with the
 *      shortest walk: that's the renderer most directly owning the
 *      Claude session.
 *
 * Returns 0 if no Code.exe ancestor can be found anywhere in the chain.
 * The caller should fall back to `code <workspace>` in that case.
 *
 * @param {number[]} pids - the click marker's `pids` array
 * @param {{procs: Map<number, {pid, ppid, name}>}} snapshot
 * @param {number} [maxDepth]
 * @returns {number}
 */
function resolveCodeInstancePid(pids, snapshot, maxDepth = DEFAULT_MAX_DEPTH) {
  if (!Array.isArray(pids) || pids.length === 0) return 0;
  if (!snapshot || !snapshot.procs) return 0;

  let bestPid = 0;
  let bestDepth = Infinity;

  for (const startPid of pids) {
    if (!Number.isInteger(startPid) || startPid <= 0) continue;
    // Inline the walk so we can track depth.
    let current = startPid;
    let depth = 0;
    const seen = new Set();
    while (depth < maxDepth) {
      if (seen.has(current)) break;
      seen.add(current);
      const node = snapshot.procs.get(current);
      if (!node) break;
      if (isVsCodeBinary(node.name)) {
        if (depth < bestDepth) {
          bestPid = node.pid;
          bestDepth = depth;
        }
        break;
      }
      if (!node.ppid || node.ppid === current) break;
      current = node.ppid;
      depth++;
    }
  }

  return bestPid;
}

/**
 * Collect EVERY Code.exe-flavored ancestor PID reachable from the marker's
 * PID chain, ordered closest-walk first and de-duplicated.
 *
 * Why plural: `resolveCodeInstancePid` returns the SHORTEST-walk Code.exe,
 * which on Windows is the terminal's ptyHost utility process (parent of the
 * shell) — and that process owns NO visible window. The window is owned by
 * the renderer Code.exe one hop further up. So for foreground/HWND work we
 * need all the Code.exe candidates and let the Win32 layer pick whichever
 * actually owns a top-level visible window (only the renderer does).
 *
 * @param {number[]} pids
 * @param {{procs: Map<number, {pid, ppid, name}>}} snapshot
 * @param {number} [maxDepth]
 * @returns {number[]} ordered, de-duplicated Code.exe ancestor PIDs
 */
function resolveCodeInstancePids(pids, snapshot, maxDepth = DEFAULT_MAX_DEPTH) {
  if (!Array.isArray(pids) || pids.length === 0) return [];
  if (!snapshot || !snapshot.procs) return [];

  const found = [];
  const pushUnique = (p) => { if (!found.includes(p)) found.push(p); };

  for (const startPid of pids) {
    if (!Number.isInteger(startPid) || startPid <= 0) continue;
    let current = startPid;
    let depth = 0;
    const seen = new Set();
    while (depth < maxDepth) {
      if (seen.has(current)) break;
      seen.add(current);
      const node = snapshot.procs.get(current);
      if (!node) break;
      if (isVsCodeBinary(node.name)) {
        pushUnique(node.pid);
        // Keep walking up — the renderer that owns the window may be a
        // further-up Code.exe ancestor of this one (ptyHost → renderer).
      }
      if (!node.ppid || node.ppid === current) break;
      current = node.ppid;
      depth++;
    }
  }

  return found;
}

module.exports = {
  VS_CODE_BINARY_PATTERN,
  isVsCodeBinary,
  findCodeAncestorPid,
  resolveCodeInstancePid,
  resolveCodeInstancePids,
  DEFAULT_MAX_DEPTH
};
