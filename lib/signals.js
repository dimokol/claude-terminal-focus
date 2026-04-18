// lib/signals.js
const fs = require('fs');
const path = require('path');

const SIGNAL_DIR = '.vscode';
const SIGNAL_FILE = '.claude-focus';
const CLICKED_FILE = '.claude-focus-clicked';
const CLAIMED_FILE = '.claude-focus-claimed';
const SIGNAL_VERSION = 2;
const STALE_THRESHOLD_MS = 30000; // ignore signals older than 30s
const CLAIM_STALE_MS = 5000;      // handled-marker lifespan

// Event priority: higher = more important. Used to pick which event wins
// when multiple hook.js invocations fire close together (e.g., Stop +
// Notification at end of a plan phase).
const EVENT_PRIORITY = { completed: 1, waiting: 2 };

function getSignalPath(workspaceRoot) {
  return path.join(workspaceRoot, SIGNAL_DIR, SIGNAL_FILE);
}

function getClickedPath(workspaceRoot) {
  return path.join(workspaceRoot, SIGNAL_DIR, CLICKED_FILE);
}

function getClaimedPath(workspaceRoot) {
  return path.join(workspaceRoot, SIGNAL_DIR, CLAIMED_FILE);
}

function eventPriority(event) {
  return EVENT_PRIORITY[event] || 0;
}

/**
 * Normalize event types to two-type model: 'waiting' | 'completed'.
 * Legacy: 'stop' → 'completed', 'notification'/'permission' → 'waiting'.
 */
function normalizeEvent(event) {
  if (event === 'completed') return 'completed';
  if (event === 'stop') return 'completed';
  return 'waiting'; // notification, permission, or anything else
}

/**
 * Try to atomically claim the "handled" marker file. Returns true if this
 * process now owns the right to fire a notification; false if another party
 * (extension or sibling hook.js) already claimed it.
 *
 * Uses O_CREAT | O_EXCL under the hood (Node's 'wx' flag) which is atomic
 * on POSIX and Windows filesystems. If a stale marker exists beyond
 * staleMs, it is reset.
 */
function claimHandled(handledPath, staleMs = CLAIM_STALE_MS) {
  try {
    fs.writeFileSync(handledPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }
  // Marker exists. Is it stale?
  try {
    const stat = fs.statSync(handledPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      fs.unlinkSync(handledPath);
      fs.writeFileSync(handledPath, String(Date.now()), { flag: 'wx' });
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Parse a signal file. Handles both v1 (plain PID list) and v2 (JSON).
 * Returns a normalized object or null if unparseable/stale.
 */
function parseSignal(content) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Try JSON (v2) first
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (data.version === 2) {
        if (data.timestamp && Date.now() - data.timestamp > STALE_THRESHOLD_MS) {
          return null;
        }
        return {
          version: 2,
          event: normalizeEvent(data.event || 'notification'),
          project: data.project || 'Unknown',
          projectDir: data.projectDir || '',
          pids: Array.isArray(data.pids) ? data.pids : [],
          state: data.state === 'fired' ? 'fired' : 'pending',
          timestamp: data.timestamp || Date.now()
        };
      }
    } catch (_) {}
  }

  // v1 format: plain PID list, one per line
  const pids = trimmed
    .split(/\r?\n/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

  return {
    version: 1,
    event: 'waiting',
    project: 'Claude Code',
    projectDir: '',
    pids,
    state: 'pending',
    timestamp: Date.now()
  };
}

module.exports = {
  SIGNAL_DIR,
  SIGNAL_FILE,
  CLICKED_FILE,
  CLAIMED_FILE,
  SIGNAL_VERSION,
  STALE_THRESHOLD_MS,
  CLAIM_STALE_MS,
  getSignalPath,
  getClickedPath,
  getClaimedPath,
  claimHandled,
  eventPriority,
  normalizeEvent,
  parseSignal
};
