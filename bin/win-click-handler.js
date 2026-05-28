#!/usr/bin/env node
// bin/win-click-handler.js — invoked by Windows shell when the user clicks
// our OS-banner toast (registered as the claude-notif:// URI handler).
//
// What it does, in order:
//   1. Decode the click marker payload (sessionId, pids, workspaceRoot, …).
//   2. Write the marker to the per-workspace `clicked` state file so the
//      extension's polling loop picks it up and runs focusMatchingTerminal.
//   3. Focus the SPECIFIC VS Code window that produced the notification.
//      - Default ("hwnd"): take a process-tree snapshot, walk up the
//        marker's PID chain to find that instance's renderer Code.exe,
//        then SetForegroundWindow on its HWND via PowerShell P/Invoke.
//        Multi-instance-safe — never lands on the wrong window.
//      - Fallback / "cli" setting: spawn `code "<workspace>"` and let
//        VS Code's CLI pick (per-user pipe → most-recently-focused). This
//        is the pre-3.5.2 path, retained as an escape hatch + as the
//        automatic fallback when the HWND path fails for any reason.
//
// `code` does NOT trigger VS Code's security.promptForLocalFileProtocolHandling
// (only vscode:// URIs do), so either path stays prompt-free.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parseLaunchUri } = require('../lib/win-protocol');
const { getClickedPath } = require('../lib/state-paths');
const { snapshot } = require('../lib/process-tree');
const { resolveCodeInstancePid } = require('../lib/code-instance-resolver');

const FOCUS_BUDGET_MS = 3000;
const CONFIG_PATH = path.join(os.homedir(), '.claude', 'claude-notifications-config.json');

function extractPayload(uri) {
  if (typeof uri !== 'string' || uri === '') return null;
  const payload = parseLaunchUri(uri);
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.workspaceRoot !== 'string' || payload.workspaceRoot === '') return null;
  return payload;
}

function readWindowsClickBehavior() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.windowsClickBehavior === 'cli' || cfg.windowsClickBehavior === 'hwnd') {
      return cfg.windowsClickBehavior;
    }
  } catch (_) {}
  return 'hwnd';
}

function writeClickMarker(payload) {
  // Refresh timestamp so parseClickMarker doesn't stale-reject if the
  // toast sat on screen for a while before the user clicked.
  payload.timestamp = Date.now();
  try {
    const clickedPath = getClickedPath(payload.workspaceRoot);
    fs.mkdirSync(path.dirname(clickedPath), { recursive: true });
    fs.writeFileSync(clickedPath, JSON.stringify(payload));
  } catch (_) {
    // Without the marker the extension can't switch terminals, but
    // focus paths below still bring VS Code forward.
  }
}

/**
 * Focus the exact VS Code window owning the click marker's PID chain.
 * Returns true on success, false on any failure (caller falls back).
 *
 * Implementation: shells out to PowerShell with inline Add-Type Win32
 * P/Invoke. Spawned with windowsHide:true so the PS process never
 * allocates a visible console.
 */
function focusHwndByPid(targetPid, budgetMs) {
  // Delegated to lib/win-focus.js so extension.js's UriHandler can re-use
  // the same AttachThreadInput-based foreground-steal logic when the click
  // flow goes through `vscode://dimokol.claude-notifications/` instead of
  // through this launcher.
  const { focusHwndByPid: shared } = require('../lib/win-focus');
  return shared(targetPid, budgetMs);
}

function spawnCodeFallback(workspaceRoot) {
  try {
    const quotedPath = '"' + workspaceRoot.replace(/"/g, '\\"') + '"';
    const child = spawn('code ' + quotedPath, {
      detached: true, stdio: 'ignore', shell: true, windowsHide: true
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function focusInstance(payload) {
  const behavior = readWindowsClickBehavior();
  if (behavior === 'cli') {
    spawnCodeFallback(payload.workspaceRoot);
    return;
  }

  // HWND path with belt-and-braces fallback. Any failure (snapshot
  // throws, no Code.exe ancestor, P/Invoke errors, PS hangs past budget)
  // falls through to the CLI path so we never end up worse than 3.5.1.
  try {
    const startedAt = Date.now();
    const snap = snapshot();
    if (snap && snap.procs && Array.isArray(payload.pids)) {
      const targetPid = resolveCodeInstancePid(payload.pids, snap);
      if (targetPid > 0) {
        const remaining = Math.max(500, FOCUS_BUDGET_MS - (Date.now() - startedAt));
        if (focusHwndByPid(targetPid, remaining)) return;
      }
    }
  } catch (_) {}

  spawnCodeFallback(payload.workspaceRoot);
}

function main() {
  const payload = extractPayload(process.argv[2]);
  if (!payload) process.exit(0);

  writeClickMarker(payload);
  focusInstance(payload);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  extractPayload,
  readWindowsClickBehavior,
  writeClickMarker,
  focusHwndByPid,
  spawnCodeFallback,
  focusInstance,
  CONFIG_PATH,
  FOCUS_BUDGET_MS
};
