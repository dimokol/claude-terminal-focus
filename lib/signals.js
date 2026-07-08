// lib/signals.js — signal-file parsing + atomic claim marker.
// Path derivation moved to lib/state-paths.js.
const fs = require('fs');

const SIGNAL_VERSION = 2;
const STALE_THRESHOLD_MS = 30000; // ignore signals older than 30s
const CLAIM_STALE_MS = 5000;      // handled-marker lifespan (same-stage)

// Cross-stage steal threshold. A claim marker's only job after its
// notification fired (which happens within ms of creation) is to absorb
// same-attention-point stragglers — and those always carry the SAME
// sessionId:stageId tag. A claimant with a DIFFERENT tag is a genuinely
// new attention point that stage-dedup already approved, so it must not
// be swallowed by the previous stage's marker. Without this, any event
// the dedup approved 3–5s after the prior notification (STAGE_ESCAPE_VALVE_MS
// < gap < CLAIM_STALE_MS) was silently dropped — zero notifications for a
// real question/completion. 2s comfortably exceeds the extension-claim →
// hook-claim spread (≤1.2s handshake) plus mtime jitter.
const CLAIM_CROSS_STAGE_STEAL_MS = 2000;

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
 *
 * `opts.tag` identifies the attention point (sessionId:stageId). A held
 * marker with the SAME tag suppresses us until `staleMs` (crash recovery);
 * a marker with a DIFFERENT tag is a previous attention point whose
 * notification already fired, so we may steal it after the much shorter
 * `crossTagStealMs`. Markers or callers without a tag behave like the
 * pre-tag era (same-tag rules) — conservative for legacy signals.
 *
 * Back-compat: the second argument may be a bare number (legacy staleMs).
 */
function claimHandled(handledPath, opts = {}) {
  if (typeof opts === 'number') opts = { staleMs: opts };
  const staleMs = opts.staleMs != null ? opts.staleMs : CLAIM_STALE_MS;
  const crossTagStealMs = opts.crossTagStealMs != null ? opts.crossTagStealMs : CLAIM_CROSS_STAGE_STEAL_MS;
  const tag = typeof opts.tag === 'string' ? opts.tag : '';
  const markerContent = () => `${Date.now()}:${tag}`;

  // Fast path: marker doesn't exist yet, atomic create wins.
  try {
    fs.writeFileSync(handledPath, markerContent(), { flag: 'wx' });
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
      fs.writeFileSync(handledPath, markerContent(), { flag: 'wx' });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Decide which staleness rule applies. A marker whose tag differs from
  // ours guards a DIFFERENT attention point — steal it much sooner. A
  // marker with the same tag (or when either side lacks a tag) keeps the
  // long crash-recovery threshold.
  let effectiveStaleMs = staleMs;
  if (tag) {
    let markerTag = '';
    try {
      const raw = fs.readFileSync(handledPath, 'utf8');
      const sep = raw.indexOf(':');
      if (sep !== -1) markerTag = raw.slice(sep + 1);
    } catch (_) {}
    if (markerTag && markerTag !== tag) effectiveStaleMs = crossTagStealMs;
  }
  if (Date.now() - stat.mtimeMs <= effectiveStaleMs) return false;

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
    fs.writeFileSync(handledPath, markerContent(), { flag: 'wx' });
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
          question: typeof data.question === 'string' ? data.question : '',
          customName: typeof data.customName === 'string' ? data.customName : '',
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
          stageId: Number.isInteger(data.stageId) && data.stageId > 0 ? data.stageId : 0,
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

  // v1 fallback: a plain newline-separated PID list (pre-v2 hooks). Be
  // strict — EVERY non-empty line must be purely numeric. Anything else
  // (e.g. a torn half-written JSON document read mid-write) is treated as
  // unparseable rather than coerced into a bogus "pending waiting" signal,
  // which used to fire a wrong-content notification with timestamp=now.
  const lines = trimmed.split(/\r?\n/).map(s => s.trim()).filter(s => s !== '');
  if (lines.length === 0 || !lines.every(s => /^\d+$/.test(s))) return null;
  const pids = lines.map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n > 0);

  return {
    version: 1,
    event: 'waiting',
    hookEventName: '',
    hookMessage: '',
    question: '',
    customName: '',
    sessionId: '',
    stageId: 0,
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
  CLAIM_CROSS_STAGE_STEAL_MS,
  claimHandled,
  eventPriority,
  normalizeEvent,
  parseSignal
};
