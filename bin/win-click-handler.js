#!/usr/bin/env node
// bin/win-click-handler.js — invoked by the claude-notif:// URI handler
// registered in HKCU\Software\Classes. argv[2] is the full URI string
// Windows shell passes via "%1". Decode the embedded marker payload,
// write it to the workspace's `clicked` state file (so the running
// extension's polling loop runs handleClickedSignal exactly like the
// macOS path does), then spawn `code <workspaceRoot>` to focus the
// existing VS Code window. The `code` CLI does NOT trigger
// security.promptForLocalFileProtocolHandling — only vscode:// does.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseLaunchUri } = require('../lib/win-protocol');
const { getClickedPath } = require('../lib/state-paths');

function extractPayload(uri) {
  if (typeof uri !== 'string' || uri === '') return null;
  const payload = parseLaunchUri(uri);
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.workspaceRoot !== 'string' || payload.workspaceRoot === '') return null;
  return payload;
}

function main() {
  const payload = extractPayload(process.argv[2]);
  if (!payload) process.exit(0);

  // Refresh timestamp so parseClickMarker doesn't stale-reject if the
  // toast sat on screen for a while before the user clicked.
  payload.timestamp = Date.now();

  try {
    const clickedPath = getClickedPath(payload.workspaceRoot);
    fs.mkdirSync(path.dirname(clickedPath), { recursive: true });
    fs.writeFileSync(clickedPath, JSON.stringify(payload));
  } catch (_) {
    // Without the marker the extension can't switch terminals, but
    // `code <path>` below still focuses VS Code.
  }

  try {
    // `code` is a .cmd shim on Windows so we need shell:true to find it,
    // BUT spawn(prog, [args], { shell: true }) joins args with literal
    // spaces — no quoting — which mangles any workspaceRoot containing
    // a space ("D:\SilvWeb Studio\silvweb.studio" → 3 bogus args, VS Code
    // opens untitled placeholders for each, no folder gets focused).
    // Build a single fully-quoted command string instead.
    const quotedPath = '"' + payload.workspaceRoot.replace(/"/g, '\\"') + '"';
    const child = spawn('code ' + quotedPath, {
      detached: true, stdio: 'ignore', shell: true, windowsHide: true
    });
    child.unref();
  } catch (_) {}

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { extractPayload };
