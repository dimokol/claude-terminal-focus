// lib/stage-dedup.js — notification dedup: exactly one notification per
// attention point. Each (sessionId) has a stageId that advances on a user
// prompt or on a genuinely new attention point. shouldNotify returns
// {notify:false} when the current event is a trailer or re-fire of a point
// that already notified.
//
// The key distinction is PRIMARY vs TRAILER (by hookEventName): a `Stop`
// (completion) or `PermissionRequest`/`PreToolUse` (a question / tool request)
// is a primary attention point and notifies; a bare `Notification` is always a
// trailer/re-fire ("Claude is waiting…", "Claude needs your permission…") and
// is suppressed. Claude Code emits Stop("completed") then a trailing
// Notification("waiting") — and re-emits "still waiting" Notifications minutes
// later — for ONE logical point; treating those as new stages was the source of
// duplicate/late banners. See STAGE_ESCAPE_VALVE_MS below for the full rule.
//
// CONCURRENCY: Claude Code fires Stop and Notification (and sometimes
// PermissionRequest) as SEPARATE hook processes that race. Without a
// critical section around the read-modify-write of sessions.json, two
// processes can both read the pre-write state, both decide "notify",
// and (under a separate race in lib/signals.js#claimHandled around the
// stale-recovery branch) both end up firing — the user sees a double.
// As of v3.5.3 we wrap shouldNotify/advanceOnPrompt/markResolved in an
// O_EXCL lock-file critical section that serializes per-workspace
// dedup state mutations. Sessions writes are temp+rename atomic so a
// crash mid-write never leaves a half-file behind.
const fs = require('fs');
const path = require('path');
const { getStateDir, getSessionsPath } = require('./state-paths');

const SESSIONS_PRUNE_MS = 60 * 60 * 1000; // 1h

// Burst window for same-stage suppression. Claude Code emits the events for a
// single attention point in a short burst — Stop then a trailing Notification,
// or PermissionRequest then a trailing Notification — within ~100ms-to-~2s of
// each other. Anything arriving inside this window collapses into the
// notification that already fired (this also absorbs the race where the two
// hook processes acquire the lock out of order).
//
// PRIMARY vs TRAILER (the rule that makes "exactly one notification per
// attention point" hold — see the empirical finding in the 2026-05-29 debug
// session): every distinct attention point is announced by a PRIMARY event —
// `Stop` (a completion) or `PermissionRequest`/`PreToolUse` (a new question /
// tool request, e.g. each AskUserQuestion). A bare `Notification` is ALWAYS a
// trailer or a "still waiting" re-fire of the primary that already notified
// ("Claude is waiting for your input", "Claude needs your permission"). So:
//   - After the burst window, a PRIMARY event is a genuinely new point → notify
//     (this is how back-to-back AskUserQuestions each fire, since answering one
//     does NOT emit UserPromptSubmit — confirmed empirically).
//   - A `Notification` NEVER escapes the window; it is always suppressed as a
//     trailer. Letting it escape was the source of the duplicate / late
//     re-fire notifications (a Stop, then a "waiting" Notification 60s later
//     firing a second time).
// This sidesteps the #15872 limitation (no PostToolUse for AskUserQuestion)
// without a timing guess about "new question vs re-fire": the PermissionRequest
// IS the new-question signal.
//
// 3s is comfortably larger than every burst observed historically (≤200ms
// typical, ~1-2s worst case) and well under the seconds a user takes to answer
// one question before the next — so distinct questions land outside it.
const STAGE_ESCAPE_VALVE_MS = 3000;

// AskUserQuestion (and similar permission-gated tools) fires the platform
// burst over a MUCH longer window than the Stop+Notification ~100ms case:
// PermissionRequest first, then Notification anywhere from ~1s to many
// seconds later, depending on how long Claude Code's tool-permission UI
// sits before continuing. The 3s STAGE_ESCAPE_VALVE_MS isn't enough to
// keep these two events glued to the same attention point — once the gap
// exceeds 3s, the escape valve fires and we get a duplicate notification.
// This longer window catches the PR→Notification pair specifically. We
// don't extend the generic escape valve because that would suppress
// genuinely new attention points arriving within 30s.
const PR_NOTIFICATION_BURST_MS = 30000;

// Lock-file constants. The acquire loop waits up to LOCK_WAIT_MS with
// LOCK_SLEEP_MS between retries; if a held lock is older than
// LOCK_STALE_MS we steal it (process crashed mid-section). The lock
// protects a critical section measured in microseconds (one fs.readFile
// + a few comparisons + one rename), so even under high concurrency
// nobody waits more than a few tens of ms.
const LOCK_WAIT_MS = 1000;
const LOCK_SLEEP_MS = 5;
const LOCK_STALE_MS = 2000;

function ensureDir(workspaceRoot) {
  const dir = getStateDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleepSync(ms) {
  // Synchronous sleep for short waits inside the lock-acquire loop.
  // Atomics.wait on a fresh SharedArrayBuffer is the cleanest cross-platform
  // sync sleep available in Node without a busy spin. If SAB is unavailable
  // for any reason, fall back to a tight loop.
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

/**
 * Acquire an O_EXCL lock-file inside the workspace's state dir.
 * Returns the lock path on success, or null on timeout (caller should
 * proceed anyway — better to risk a rare race than to drop a dedup
 * decision entirely).
 */
function acquireLock(workspaceRoot) {
  const dir = ensureDir(workspaceRoot);
  const lockPath = path.join(dir, 'dedup.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
    }
    // Lock held. If stale, steal it; otherwise sleep and retry.
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        continue; // retry the wx write immediately
      }
    } catch (_) {
      // Lock disappeared between EEXIST and stat — retry immediately.
      continue;
    }
    sleepSync(LOCK_SLEEP_MS);
  }
  return null;
}

function releaseLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

function readSessions(workspaceRoot) {
  const p = getSessionsPath(workspaceRoot);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch (_) {
    return {};
  }
}

function writeSessions(workspaceRoot, map) {
  ensureDir(workspaceRoot);
  const now = Date.now();
  for (const key of Object.keys(map)) {
    const u = map[key] && map[key].updatedAt;
    if (typeof u === 'number' && now - u > SESSIONS_PRUNE_MS) delete map[key];
  }
  // Atomic write: temp + rename. fs.renameSync is atomic on POSIX and
  // (since Node 14 / Windows 10 1607) on Windows too, so concurrent
  // readers never see a half-written file.
  const finalPath = getSessionsPath(workspaceRoot);
  const tmpPath = finalPath + '.tmp.' + process.pid + '.' + now;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(map));
    fs.renameSync(tmpPath, finalPath);
  } catch (_) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function shouldNotify(workspaceRoot, sessionId, currentEvent, currentHookEventName) {
  // No session id → can't dedup safely; always notify.
  if (!sessionId) return { notify: true, stageId: null };

  // Critical section: read-modify-write of sessions.json must be
  // serialized so concurrent Stop+Notification hooks don't both pass
  // a "no entry" check and both decide notify=true.
  const lock = acquireLock(workspaceRoot);
  try {
    const map = readSessions(workspaceRoot);
    const now = Date.now();
    let entry = map[sessionId];

    if (!entry) {
      entry = {
        stageId: 1,
        lastEvent: currentEvent,
        lastHookEventName: currentHookEventName || null,
        resolved: false,
        lastNotifiedAt: now,
        updatedAt: now
      };
      map[sessionId] = entry;
      writeSessions(workspaceRoot, map);
      return { notify: true, stageId: 1 };
    }

    // PR→Notification burst guard: AskUserQuestion (and similar
    // permission-gated tools) fires PermissionRequest first, then
    // Notification anywhere from ~1s to many seconds later. Both
    // events are for the SAME attention point. The generic 3s escape
    // valve isn't long enough to glue them together when the gap is
    // larger (focus changes, slow UI, etc.). Suppress with a 30s
    // window specifically for this pattern. Anything else falls
    // through to the existing rules. Pre-tool-use is the same pattern
    // (PreToolUse → Notification) for tools that opt into pre-hooks.
    const lastHook = entry.lastHookEventName;
    if ((lastHook === 'PermissionRequest' || lastHook === 'PreToolUse') &&
        currentHookEventName === 'Notification' &&
        now - (entry.lastNotifiedAt || 0) < PR_NOTIFICATION_BURST_MS) {
      entry.lastEvent = currentEvent;
      entry.lastHookEventName = currentHookEventName;
      entry.updatedAt = now;
      writeSessions(workspaceRoot, map);
      return { notify: false, stageId: entry.stageId };
    }

    // Fresh stage from a UserPromptSubmit: lastEvent===null means no notification has been fired yet for this stage.
    if (entry.lastEvent === null) {
      entry.lastEvent = currentEvent;
      entry.lastHookEventName = currentHookEventName || null;
      entry.resolved = false;
      entry.lastNotifiedAt = now;
      entry.updatedAt = now;
      writeSessions(workspaceRoot, map);
      return { notify: true, stageId: entry.stageId };
    }

    if (entry.resolved === true) {
      // Burst-after-ack guard: if the user's ack landed INSIDE the platform
      // PR/Notification burst window (e.g. they clicked the OS banner ~1s
      // after PR fired and before Claude Code's follow-up Notification
      // arrived ~1s later), the next event is still part of the prior
      // stage's burst — collapse it instead of advancing to a fresh stage.
      // Without this guard, fast banner-click users hear two sounds for
      // every AskUserQuestion: one from PR's hook.js OS-banner fire and
      // another when the immediately following Notification gets treated
      // as a new stage and plays the in-window sound. This is the banner-
      // click analogue of v3.3.1's correct-terminal sound-only fix; the
      // comment in extension.js#handleSignal#Case-A warned about the same
      // pattern but the fix was only applied to the sound-only path.
      // Suppress if we're still inside the burst window (the platform pair)
      // OR if this is a bare Notification (a trailer/re-fire — never a new
      // attention point on its own, even after an ack). Only a primary event
      // (Stop / PermissionRequest / PreToolUse) arriving after the window is a
      // genuinely new point that re-opens notification post-ack.
      const lastAt = entry.lastNotifiedAt || 0;
      if (now - lastAt < STAGE_ESCAPE_VALVE_MS || currentHookEventName === 'Notification') {
        entry.lastEvent = currentEvent;
        entry.lastHookEventName = currentHookEventName || entry.lastHookEventName || null;
        entry.updatedAt = now;
        writeSessions(workspaceRoot, map);
        return { notify: false, stageId: entry.stageId };
      }
      entry.stageId = (entry.stageId || 0) + 1;
      entry.lastEvent = currentEvent;
      entry.lastHookEventName = currentHookEventName || null;
      entry.resolved = false;
      entry.lastNotifiedAt = now;
      entry.updatedAt = now;
      writeSessions(workspaceRoot, map);
      return { notify: true, stageId: entry.stageId };
    }

    // Escape valve: if the last notification for this stage was long enough
    // ago, this event can't be part of the original Stop/Notification burst.
    // BUT only a PRIMARY event (Stop = completion, PermissionRequest /
    // PreToolUse = a new question/tool request) is a genuinely new attention
    // point worth a fresh notification. A bare `Notification` is always a
    // trailer or a "still waiting" re-fire of the primary that already
    // notified — letting it escape was the source of the duplicate/late
    // notifications (a Stop, then a "waiting" Notification 60s later firing
    // again). So a Notification never escapes; it falls through to suppress.
    // Every AskUserQuestion fires its own PermissionRequest, so questions
    // (including back-to-back ones) still notify exactly once via this path.
    const lastAt = entry.lastNotifiedAt || 0;
    if (now - lastAt > STAGE_ESCAPE_VALVE_MS && currentHookEventName !== 'Notification') {
      entry.stageId = (entry.stageId || 0) + 1;
      entry.lastEvent = currentEvent;
      entry.lastHookEventName = currentHookEventName || null;
      entry.resolved = false;
      entry.lastNotifiedAt = now;
      entry.updatedAt = now;
      writeSessions(workspaceRoot, map);
      return { notify: true, stageId: entry.stageId };
    }

    // Unresolved stage, fresh burst → re-fire of an already-notified stage.
    // Track the latest event type so the signal file/UI reflects current
    // state, but suppress the notification.
    entry.lastEvent = currentEvent;
    entry.lastHookEventName = currentHookEventName || entry.lastHookEventName || null;
    entry.updatedAt = now;
    writeSessions(workspaceRoot, map);
    return { notify: false, stageId: entry.stageId };
  } finally {
    releaseLock(lock);
  }
}

function advanceOnPrompt(workspaceRoot, sessionId) {
  if (!sessionId) return;
  const lock = acquireLock(workspaceRoot);
  try {
    const map = readSessions(workspaceRoot);
    const now = Date.now();
    const entry = map[sessionId] || { stageId: 0, lastEvent: null, lastHookEventName: null, resolved: false, lastNotifiedAt: 0, updatedAt: now };
    entry.stageId = (entry.stageId || 0) + 1;
    entry.lastEvent = null;
    entry.lastHookEventName = null;
    entry.resolved = false;
    entry.updatedAt = now;
    map[sessionId] = entry;
    writeSessions(workspaceRoot, map);
  } finally {
    releaseLock(lock);
  }
}

function markResolved(workspaceRoot, sessionId) {
  if (!sessionId) return;
  const lock = acquireLock(workspaceRoot);
  try {
    const map = readSessions(workspaceRoot);
    const entry = map[sessionId];
    if (!entry) return;
    entry.resolved = true;
    entry.updatedAt = Date.now();
    writeSessions(workspaceRoot, map);
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  SESSIONS_PRUNE_MS,
  STAGE_ESCAPE_VALVE_MS,
  PR_NOTIFICATION_BURST_MS,
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  shouldNotify,
  advanceOnPrompt,
  markResolved,
  _readSessions: readSessions,
  // Exposed for tests:
  acquireLock,
  releaseLock
};
