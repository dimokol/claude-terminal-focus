// lib/state-paths.js — derive the per-workspace state directory.
// All ephemeral coordination state (signal, clicked, claimed, sessions)
// lives under ~/.claude/focus-state/<hash>/ so it never lands in a
// workspace's .vscode/ directory (and thus never shows up in git changes).
const crypto = require('crypto');
const os = require('os');
const path = require('path');

// Resolved lazily (not at require time) so the test suite can point HOME
// at a sandbox before exercising the state machine — a module-load-time
// constant made every `npm test` run scatter junk dirs into the REAL
// ~/.claude/focus-state/. Production behavior is identical: os.homedir()
// is stable for the life of a VS Code / hook process.
function getStateRoot() {
  return path.join(os.homedir(), '.claude', 'focus-state');
}

// Canonicalize a workspace path so that every layer hashing it lands on the
// same state directory regardless of slash style or drive-letter casing. On
// Windows, hook.js receives `CLAUDE_PROJECT_DIR` from Claude Code (often
// forward-slash, mixed case) while extension.js sees VS Code's
// `folder.uri.fsPath` (backslash, kernel-returned drive case). Without
// normalization the two SHA1 hashes diverge and the extension's polling
// loop never finds the signals hook.js writes — silently breaking
// in-window toasts and the claim race that prevents duplicate banners.
// On POSIX this is a no-op (no drive letter, native slashes already match).
function normalizeWorkspaceRoot(workspaceRoot) {
  let s = String(workspaceRoot).replace(/\\/g, '/');
  if (process.platform === 'win32') {
    s = s.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':');
  }
  // Strip a trailing slash but preserve "/" and "c:/" roots.
  if (s.length > 1 && s.endsWith('/') && !s.endsWith(':/')) {
    s = s.slice(0, -1);
  }
  return s;
}

function hashWorkspace(workspaceRoot) {
  return crypto.createHash('sha1').update(normalizeWorkspaceRoot(workspaceRoot)).digest('hex').slice(0, 12);
}

function getStateDir(workspaceRoot) {
  return path.join(getStateRoot(), hashWorkspace(workspaceRoot));
}

function getSignalPath(workspaceRoot)   { return path.join(getStateDir(workspaceRoot), 'signal'); }
function getClickedPath(workspaceRoot)  { return path.join(getStateDir(workspaceRoot), 'clicked'); }
function getClaimedPath(workspaceRoot)  { return path.join(getStateDir(workspaceRoot), 'claimed'); }
function getSessionsPath(workspaceRoot) { return path.join(getStateDir(workspaceRoot), 'sessions'); }

module.exports = {
  getStateRoot,
  hashWorkspace,
  normalizeWorkspaceRoot,
  getStateDir,
  getSignalPath,
  getClickedPath,
  getClaimedPath,
  getSessionsPath
};
