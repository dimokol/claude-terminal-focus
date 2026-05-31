// lib/click-marker.js — parse the OS-banner click marker.
//
// terminal-notifier's -execute payload writes a JSON document into
// ~/.claude/focus-state/<hash>/clicked when the user clicks an OS banner.
// We embed the originating session's data (pids/sessionId/event/project)
// directly in the marker so the click handler never has to fall back to
// the per-workspace `signal` file — that file is shared across all Claude
// sessions in the workspace and gets overwritten by the next hook firing,
// which used to make us focus the wrong terminal when multiple Claude
// sessions ran side-by-side.
//
// Legacy markers (pre-v3.3.1) were created by `touch` and are empty. For
// those we return { legacy: true } and the caller falls back to the
// signal file as a best-effort second source of truth.

const CLICK_MARKER_STALE_MS = 5 * 60 * 1000; // 5 minutes — alerts can sit on screen for a while

function parseClickMarker(content) {
  if (typeof content !== 'string' || content.trim() === '') {
    return { legacy: true };
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch (_) {
    // Not JSON — treat like legacy. Could be a partial write under a race;
    // the caller should fall back to the signal file.
    return { legacy: true };
  }
  if (!data || typeof data !== 'object') return { legacy: true };

  if (typeof data.timestamp === 'number' && Date.now() - data.timestamp > CLICK_MARKER_STALE_MS) {
    return { stale: true };
  }

  return {
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
    event: data.event === 'completed' ? 'completed' : 'waiting',
    project: typeof data.project === 'string' ? data.project : 'Unknown',
    pids: Array.isArray(data.pids) ? data.pids.filter(p => Number.isInteger(p) && p > 0) : [],
    shellPid: Number.isInteger(data.shellPid) && data.shellPid > 0 ? data.shellPid : 0,
    workspaceRoot: typeof data.workspaceRoot === 'string' ? data.workspaceRoot : '',
    projectDir: typeof data.projectDir === 'string' ? data.projectDir : '',
    aiTitle: typeof data.aiTitle === 'string' ? data.aiTitle : '',
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now()
  };
}

function buildClickMarkerPayload({ sessionId, pids, shellPid, workspaceRoot, projectDir, event, project, aiTitle }) {
  return JSON.stringify({
    sessionId: sessionId || '',
    event: event === 'completed' ? 'completed' : 'waiting',
    project: project || 'Unknown',
    pids: Array.isArray(pids) ? pids : [],
    shellPid: Number.isInteger(shellPid) && shellPid > 0 ? shellPid : 0,
    workspaceRoot: workspaceRoot || '',
    projectDir: projectDir || '',
    aiTitle: typeof aiTitle === 'string' ? aiTitle : '',
    timestamp: Date.now()
  });
}

module.exports = { parseClickMarker, buildClickMarkerPayload, CLICK_MARKER_STALE_MS };
