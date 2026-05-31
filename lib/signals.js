// lib/signals.js — signal-file parsing + atomic claim marker.
// Path derivation moved to lib/state-paths.js.
const fs = require('fs');

const SIGNAL_VERSION = 2;
const STALE_THRESHOLD_MS = 30000; // ignore signals older than 30s
const CLAIM_STALE_MS = 5000;      // handled-marker lifespan

// Event priority: higher = more important. Used to pick which event wins
// when multiple hook.js invocations fire close together (e.g., Stop +
// Notification at end of a plan phase).
const EVENT_PRIORITY = { completed: 1, waiting: 2 };

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
  return 'waiting';
}

/**
 * Try to atomically claim the "handled" marker file. Returns true if this
 * process now owns the right to fire a notification; false if another party
 * (extension or sibling hook.js) already claimed it.
 */
function claimHandled(handledPath, staleMs = CLAIM_STALE_MS) {
  // Fast path: marker doesn't exist yet, atomic create wins.
  try {
    fs.writeFileSync(handledPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }

  // Slow path: marker exists. If it's older than staleMs, try to steal it.
  //
  // The old version did { stat → unlink → writeFileSync(wx) }, which had a
  // subtle race: two processes could both see the same stale stat, both
  // attempt unlink (one ENOENTs silently), both attempt the final write,
  // and *both* succeed if the second write happens AFTER the first's
  // creation was undone by the second's unlink. The result was two
  // processes both believing they owned the claim — the user's
  // duplicate-notification bug at session start.
  //
  // The new version uses unlink itself as the contention point. Only ONE
  // process can successfully unlink a given inode (POSIX guarantees this,
  // and Windows ReplaceFile/MoveFile semantics are similarly serialized).
  // Whoever loses the unlink race returns false. Whoever wins then races
  // for the fresh write under O_EXCL — only one creator can succeed there
  // either. Two atomic steps, each with a single winner.
  let stat;
  try {
    stat = fs.statSync(handledPath);
  } catch (_) {
    // Marker disappeared between EEXIST and stat. Treat it as a successful
    // steal attempt — retry the fast path.
    try {
      fs.writeFileSync(handledPath, String(Date.now()), { flag: 'wx' });
      return true;
    } catch (_) {
      return false;
    }
  }
  if (Date.now() - stat.mtimeMs <= staleMs) return false;

  // Marker is genuinely stale. Try to unlink — exactly one process wins.
  try {
    fs.unlinkSync(handledPath);
  } catch (_) {
    // Lost the unlink race. Someone else cleaned it up or stole it; either
    // way we are not the claimer.
    return false;
  }

  // We won the unlink. Now race for the create — under high concurrency,
  // a sibling that ALSO won an unlink in a different sweep round could
  // beat us here, in which case O_EXCL on the create side guarantees one
  // winner.
  try {
    fs.writeFileSync(handledPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch (_) {
    return false;
  }
}

function parseSignal(content) {
  const trimmed = content.trim();
  if (!trimmed) return null;

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
          hookEventName: typeof data.hookEventName === 'string' ? data.hookEventName : '',
          hookMessage: typeof data.hookMessage === 'string' ? data.hookMessage : '',
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
          project: data.project || 'Unknown',
          projectDir: data.projectDir || '',
          workspaceRoot: typeof data.workspaceRoot === 'string' ? data.workspaceRoot : '',
          pids: Array.isArray(data.pids) ? data.pids : [],
          pidNames: (data.pidNames && typeof data.pidNames === 'object') ? data.pidNames : {},
          shellPid: Number.isInteger(data.shellPid) && data.shellPid > 0 ? data.shellPid : 0,
          pidChainSource: typeof data.pidChainSource === 'string' ? data.pidChainSource : '',
          state: data.state === 'fired' ? 'fired' : 'pending',
          aiTitle: typeof data.aiTitle === 'string' ? data.aiTitle : '',
          timestamp: data.timestamp || Date.now()
        };
      }
    } catch (_) {}
  }

  const pids = trimmed
    .split(/\r?\n/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

  return {
    version: 1,
    event: 'waiting',
    hookEventName: '',
    hookMessage: '',
    sessionId: '',
    project: 'Claude Code',
    projectDir: '',
    workspaceRoot: '',
    pids,
    pidNames: {},
    shellPid: 0,
    pidChainSource: '',
    state: 'pending',
    aiTitle: '',
    timestamp: Date.now()
  };
}

module.exports = {
  SIGNAL_VERSION,
  STALE_THRESHOLD_MS,
  CLAIM_STALE_MS,
  claimHandled,
  eventPriority,
  normalizeEvent,
  parseSignal
};
