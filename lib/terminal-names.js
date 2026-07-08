// lib/terminal-names.js — user-custom terminal names for notification text.
//
// VS Code lets users rename a terminal tab (right-click → Rename). A name
// the user chose ("deploy-bot") identifies a session faster than the
// AI-generated title, so notifications prefer it when one exists.
//
// Two consumers with very different vantage points:
//   - extension.js sees live terminal names via the VS Code API and uses
//     them directly for in-window toasts. It also WRITES the per-workspace
//     cache file (<stateDir>/terminal-names) on its polling tick whenever
//     the pid→name map changes (plus a heartbeat rewrite so staleness can
//     be detected).
//   - hook.js runs OUTSIDE VS Code and cannot see terminal names; it READS
//     the cache at fire time and looks up its shell PID to pick the OS
//     banner subtitle.
//
// Detection is deliberately conservative: when unsure whether a name is
// user-custom, treat it as not custom and fall back to the AI title — a
// wrong fallback is invisible, a wrong swap is confusing.

const fs = require('fs');
const path = require('path');
const { getStateDir } = require('./state-paths');
const { isDefaultShellName, CLAUDE_TITLE_MARKERS } = require('./terminal-match');

// Rewrite even an unchanged cache this often, so readers can distinguish
// "VS Code is alive, names simply haven't changed" from "VS Code is gone
// and these names are fossils".
const NAME_CACHE_HEARTBEAT_MS = 60 * 1000;
// Readers reject a cache older than this. Must be comfortably larger than
// the heartbeat; a dead VS Code stops heartbeating and the cache expires.
const NAME_CACHE_STALE_MS = 5 * 60 * 1000;

const MAX_CUSTOM_NAME_LEN = 60; // same banner-width budget as aiTitle

/**
 * Is this terminal name something the USER typed, as opposed to a stock
 * shell name or a title Claude Code wrote via ANSI escapes?
 *
 * Claude-written titles are either glyph-prefixed ("✳ Refactor auth…",
 * "⚒ …") while busy, or exactly the project basename while idle. Renaming
 * a terminal pins the tab title, so a renamed tab shows only the user's
 * string.
 */
function isCustomTerminalName(name, { aiTitle = '', project = '' } = {}) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (isDefaultShellName(trimmed)) return false;
  for (const marker of CLAUDE_TITLE_MARKERS) {
    if (trimmed.includes(marker)) return false;
  }
  const lower = trimmed.toLowerCase();
  // "claude"-flavored names are more likely Claude-written than user-typed;
  // conservative fallback (a user's "claude-api-work" keeps the AI title).
  if (lower.includes('claude')) return false;
  if (aiTitle && lower.includes(String(aiTitle).trim().toLowerCase())) return false;
  // Claude's idle title is the project basename; VS Code may add " (2)".
  const deduped = lower.replace(/\s*\(\d+\)\s*$/, '');
  if (project && deduped === String(project).trim().toLowerCase()) return false;
  return true;
}

function getTerminalNamesPath(workspaceRoot) {
  return path.join(getStateDir(workspaceRoot), 'terminal-names');
}

/**
 * Atomically write the pid→name map for a workspace. `names` values are
 * RAW terminal names (custom-ness is decided at lookup time, since the
 * aiTitle/project context is per-signal). Last-writer-wins across VS Code
 * windows sharing a workspace — a missed window's entries return on its
 * next heartbeat; the cost is a temporary fallback to the AI title.
 */
function writeTerminalNamesCache(workspaceRoot, names) {
  try {
    const dir = getStateDir(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    const p = getTerminalNamesPath(workspaceRoot);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), names: names || {} }));
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Read the cache; returns null when missing, malformed, or stale.
 */
function readTerminalNamesCache(workspaceRoot, staleMs = NAME_CACHE_STALE_MS) {
  try {
    const raw = fs.readFileSync(getTerminalNamesPath(workspaceRoot), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.names || typeof data.names !== 'object') return null;
    if (typeof data.updatedAt !== 'number' || Date.now() - data.updatedAt > staleMs) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * Pick the custom name for a signal's process chain. shellPid is the
 * terminal's own process on POSIX so it gets priority; the rest of the
 * chain is a fallback. Returns '' when nothing matches or the matched
 * name isn't user-custom.
 */
function lookupCustomName(cache, { shellPid = 0, pids = [] } = {}, ctx = {}) {
  if (!cache || !cache.names) return '';
  const tryPid = (pid) => {
    if (!pid) return '';
    const name = cache.names[String(pid)];
    if (typeof name !== 'string' || !isCustomTerminalName(name, ctx)) return '';
    const trimmed = name.trim();
    return trimmed.length > MAX_CUSTOM_NAME_LEN
      ? trimmed.slice(0, MAX_CUSTOM_NAME_LEN - 1) + '…'
      : trimmed;
  };
  const fromShell = tryPid(shellPid);
  if (fromShell) return fromShell;
  for (const pid of Array.isArray(pids) ? pids : []) {
    const hit = tryPid(pid);
    if (hit) return hit;
  }
  return '';
}

module.exports = {
  isCustomTerminalName,
  getTerminalNamesPath,
  writeTerminalNamesCache,
  readTerminalNamesCache,
  lookupCustomName,
  NAME_CACHE_HEARTBEAT_MS,
  NAME_CACHE_STALE_MS,
  MAX_CUSTOM_NAME_LEN
};
