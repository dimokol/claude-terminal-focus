// lib/stage-dedup.js — acknowledgment-based notification dedup.
// Each (sessionId) has a stageId that advances on: user prompt, or
// previous stage resolved. shouldNotify returns {notify:false} when
// the current event is a re-fire of an already-notified-and-unresolved
// stage. Event type is *not* a stage boundary: Claude Code commonly
// emits Stop("completed") and Notification("waiting") seconds apart for
// the same logical attention point, and treating them as separate
// stages causes a duplicate banner.
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

// Escape valve for same-stage suppression. Claude Code emits Stop+Notification
// pairs ~100ms apart for the same attention point — we want those to collapse.
// But AskUserQuestion (and other delayed Notifications) currently land inside
// the same unresolved stage with no upstream ack hook (anthropics/claude-code
// #15872), so they get silently swallowed. If more than STAGE_ESCAPE_VALVE_MS
// has elapsed since the last notification for this stage, treat the event as
// the start of a new stage and notify. 3s is comfortably larger than every
// duplicate burst observed historically (≤200ms typical, ~1–2s worst case in
// the dafb73f-era notes) while still well under the time Claude needs to do
// any real work before the next genuine wait.
//
// **Revert path:** when issue #15872 ships and PostToolUse fires for
// AskUserQuestion, drop this constant and the escape branch in shouldNotify;
// instead install a PostToolUse hook that calls advanceOnPrompt on tool
// completion. See CLAUDE.md "Known limitations" for the full revert plan.
const STAGE_ESCAPE_VALVE_MS = 3000;

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

function shouldNotify(workspaceRoot, sessionId, currentEvent) {
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
      entry = { stageId: 1, lastEvent: currentEvent, resolved: false, lastNotifiedAt: now, updatedAt: now };
      map[sessionId] = entry;
      writeSessions(workspaceRoot, map);
      return { notify: true, stageId: 1 };
    }

    // Fresh stage from a UserPromptSubmit: lastEvent===null means no notification has been fired yet for this stage.
    if (entry.lastEvent === null) {
      entry.lastEvent = currentEvent;
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
      const lastAt = entry.lastNotifiedAt || 0;
      if (now - lastAt < STAGE_ESCAPE_VALVE_MS) {
        entry.lastEvent = currentEvent;
        entry.updatedAt = now;
        writeSessions(workspaceRoot, map);
        return { notify: false, stageId: entry.stageId };
      }
      entry.stageId = (entry.stageId || 0) + 1;
      entry.lastEvent = currentEvent;
      entry.resolved = false;
      entry.lastNotifiedAt = now;
      entry.updatedAt = now;
      writeSessions(workspaceRoot, map);
      return { notify: true, stageId: entry.stageId };
    }

    // Escape valve: if the last notification for this stage was long enough
    // ago, this event can't be part of the original Stop/Notification burst —
    // it's a genuinely new wait (typically AskUserQuestion arriving after
    // Claude finished a tool call). Treat as a new stage.
    const lastAt = entry.lastNotifiedAt || 0;
    if (now - lastAt > STAGE_ESCAPE_VALVE_MS) {
      entry.stageId = (entry.stageId || 0) + 1;
      entry.lastEvent = currentEvent;
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
    const entry = map[sessionId] || { stageId: 0, lastEvent: null, resolved: false, lastNotifiedAt: 0, updatedAt: now };
    entry.stageId = (entry.stageId || 0) + 1;
    entry.lastEvent = null;
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
