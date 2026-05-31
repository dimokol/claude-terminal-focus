#!/usr/bin/env node
// bin/hook-wrapper.cjs — stable-location wrapper that Claude Code's hook
// subsystem invokes (settings.json points here, not at the extension dir).
//
// Why this exists: VS Code provides no uninstall hook, so when the user
// uninstalls the extension, `~/.claude/settings.json` keeps referencing
// the now-deleted dist/hook.js inside the extension dir. Claude Code
// then fires MODULE_NOT_FOUND on every message until the user manually
// edits settings.json. With this wrapper in the middle, the FIRST hook
// fire after uninstall detects the missing target and performs a full
// self-destruct across all Claude profiles.
//
// This file is installed TWICE under ~/.claude/claude-notifications/:
// once as hook.cjs (for Stop/Notification/PermissionRequest) and once
// as hook-user-prompt.cjs (for UserPromptSubmit). Same source — it
// self-routes via __filename.
//
// MUST stay dependency-free (only node: builtins).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function pathExistsSync(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function discoverProfiles(home) {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(home, { withFileTypes: true }); }
  catch (_) { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name !== '.claude' && !name.startsWith('.claude-')) continue;
    if (name.toLowerCase().startsWith('.claude-backup')) continue;
    const sp = path.join(home, name, 'settings.json');
    if (pathExistsSync(sp)) result.push(sp);
  }
  return result;
}

function stripFromSettings(settingsPath, identifierSubstrings) {
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch (_) { return false; }
  let s;
  try { s = JSON.parse(raw); } catch (_) { return false; }
  if (!s.hooks || typeof s.hooks !== 'object') return false;

  let changed = false;
  for (const ev of Object.keys(s.hooks)) {
    const groups = s.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const g of groups) {
      const hooks = Array.isArray(g.hooks)
        ? g.hooks.filter(h => {
            const matches = h && typeof h.command === 'string' &&
              identifierSubstrings.some(sub => h.command.includes(sub));
            if (matches) changed = true;
            return !matches;
          })
        : [];
      if (hooks.length) keptGroups.push(Object.assign({}, g, { hooks }));
    }
    if (keptGroups.length) s.hooks[ev] = keptGroups;
    else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;

  if (changed) {
    const tmp = settingsPath + '.cn-cleanup-tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, settingsPath);
  }
  return changed;
}

// Identifiers covering BOTH new wrapper-style commands AND legacy
// direct-to-extension commands, so cleanup catches any era of install.
const SELF_IDENTIFIERS = [
  'claude-notifications/hook.cjs',
  'claude-notifications\\hook.cjs',
  'claude-notifications/hook-user-prompt.cjs',
  'claude-notifications\\hook-user-prompt.cjs',
  'dimokol.claude-notifications',
  'dimokol.claude-terminal-focus'
];

function selfDestruct({ home = os.homedir(), wrapperDir = __dirname } = {}) {
  // 1. Strip hook entries from every Claude profile's settings.json and
  //    remove the .backup files installHooks leaves behind.
  for (const sp of discoverProfiles(home)) {
    try { stripFromSettings(sp, SELF_IDENTIFIERS); } catch (_) {}
    try { fs.rmSync(sp + '.backup', { force: true }); } catch (_) {}
  }

  // 2. Focus-state cache.
  try { fs.rmSync(path.join(home, '.claude', 'focus-state'), { recursive: true, force: true }); } catch (_) {}

  // 3. Windows: protocol handler + bundled click launcher.
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('child_process');
      spawnSync('reg.exe', ['DELETE', 'HKCU\\Software\\Classes\\claude-notif', '/f'], {
        windowsHide: true, stdio: 'ignore'
      });
    } catch (_) {}
    try {
      const lad = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      fs.rmSync(path.join(lad, 'claude-notifications'), { recursive: true, force: true });
    } catch (_) {}
  }

  // 4. Our own wrapper directory.
  // POSIX can rm a dir whose script is currently executing; Windows can't,
  // so we schedule detached cleanup. If anything fails, the next hook fire
  // re-runs this whole flow — idempotent.
  if (process.platform === 'win32') {
    try {
      const { spawn } = require('child_process');
      const c = spawn('cmd.exe', [
        '/c', 'timeout', '/t', '2', '/nobreak', '>nul', '&',
        'rmdir', '/s', '/q', `"${wrapperDir}"`
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
    } catch (_) {}
  } else {
    try { fs.rmSync(wrapperDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function main() {
  const stateFile = path.join(__dirname, 'state.json');
  const isUserPrompt = path.basename(__filename) === 'hook-user-prompt.cjs';

  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (_) { process.exit(0); }

  const target = isUserPrompt
    ? state.extensionUserPromptHookPath
    : state.extensionHookPath;

  if (!target || !pathExistsSync(target)) {
    try { selfDestruct(); } catch (_) {}
    process.exit(0);
  }

  // require() runs the target's IIFE in-process; stdin, argv, and
  // process.exit all behave as if Claude Code invoked target directly.
  // Overhead is one fs.readFile + JSON.parse + require — under 10 ms.
  try {
    require(target);
  } catch (e) {
    try {
      fs.appendFileSync(
        path.join(__dirname, 'errors.log'),
        `[${new Date().toISOString()}] ${isUserPrompt ? 'user-prompt' : 'hook'}: ${e.stack || e.message}\n`
      );
    } catch (_) {}
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  pathExistsSync,
  discoverProfiles,
  stripFromSettings,
  selfDestruct,
  SELF_IDENTIFIERS,
  main
};
