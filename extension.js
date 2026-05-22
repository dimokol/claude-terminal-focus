// extension.js — Claude Notifications v3.1.3
// hook.js handles OS banner + sound as a fallback (runs outside VS Code).
// This extension handles: atomic claim-based dedup, terminal focusing,
// status bar, settings sync, and commands.
//
// FOCUS CONTRACT: This extension never changes terminal focus without an
// explicit user press — either the "Focus Terminal" button on an in-window
// toast or an OS banner click.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  SIGNAL_VERSION,
  STALE_THRESHOLD_MS,
  CLAIM_STALE_MS,
  claimHandled,
  eventPriority,
  parseSignal
} = require('./lib/signals');
const {
  getSignalPath,
  getClickedPath,
  getClaimedPath,
  getStateDir
} = require('./lib/state-paths');
const { markResolved } = require('./lib/stage-dedup');
const { parseClickMarker } = require('./lib/click-marker');
const { matchTerminal } = require('./lib/terminal-match');
const { checkHookStatus, checkAllProfiles, installHooks, uninstallHooks } = require('./lib/hooks-installer');
const { installHookRuntime, uninstallHookRuntime, getWrapperHookPath, getWrapperUserPromptPath } = require('./lib/hook-runtime');

let _wrapperPaths = null;
function getWrapperPaths() {
  // Even if installHookRuntime hasn't run (e.g. it failed), return the
  // expected paths so callers don't crash. The wrapper just won't exist
  // on disk in that degraded case.
  if (_wrapperPaths) return _wrapperPaths;
  return { hookPath: getWrapperHookPath(), userPromptHookPath: getWrapperUserPromptPath() };
}
const { playSound, playSoundFile, resolveSoundPath, discoverSystemSounds } = require('./lib/sounds');

const POLL_MS = 400;
const SWEEP_FIRED_MS = 8000;        // delete fired signal files older than this
const LEGACY_EXTENSION_ID = 'dimokol.claude-terminal-focus';
const CONFIG_FILE = 'claude-notifications-config.json';

// Module-level shared state (set during activate)
let _statusBarItem = null;
let _terminalNotifierCached = null;  // cached detection, invalidated on command

function activate(context) {
  const log = vscode.window.createOutputChannel('Claude Notifications');
  log.appendLine(`Claude Notifications v${context.extension.packageJSON.version} activated`);
  log.appendLine(`Workspace folders: ${(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).join(', ') || 'none'}`);

  // --- Detect legacy extension (primary cause of duplicate toasts) ---
  warnIfLegacyExtensionActive(context, log);

  // --- Install / refresh the stable-location hook wrapper ---
  // Hook entries in settings.json point at this wrapper rather than at
  // the extension's dist/, so the hook contract survives uninstalls and
  // upgrades. The wrapper self-destructs on its first fire after the
  // extension is gone, cleaning every profile + Windows registry + state.
  try {
    const runtimeResult = installHookRuntime(context.extensionPath, {
      extensionVersion: context.extension.packageJSON.version
    });
    if (runtimeResult.ok) {
      _wrapperPaths = {
        hookPath: runtimeResult.wrapperHookPath,
        userPromptHookPath: runtimeResult.wrapperUserPromptPath
      };
      log.appendLine(`Hook runtime ready: ${runtimeResult.wrapperDir}`);
    } else {
      log.appendLine(`Hook runtime install failed (extension may produce stale hooks after uninstall): ${runtimeResult.error}`);
    }
  } catch (e) {
    log.appendLine(`Hook runtime install threw: ${e.message}`);
  }

  // --- Windows: register claude-notif:// URI handler for OS-banner clicks ---
  // Self-healing — every activation rewrites the HKCU keys with the current
  // launcher and node paths, so reinstalls/updates don't leave orphans.
  if (process.platform === 'win32') {
    try {
      const { installWinProtocol } = require('./lib/win-protocol');
      const bundledLauncherPath = path.join(context.extensionPath, 'dist', 'win-click-handler.js');
      const result = installWinProtocol({ bundledLauncherPath });
      if (result.ok) {
        log.appendLine(`Windows click-handler registered: launcher=${result.launcherPath} node=${result.nodeExe}`);
      } else {
        log.appendLine(`Windows click-handler registration failed (OS-banner click will fall back to no-op): ${result.error}`);
      }
    } catch (e) {
      log.appendLine(`Windows click-handler registration threw: ${e.message}`);
    }
  }

  // --- Status bar ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _statusBarItem = statusBarItem;
  updateStatusBar(statusBarItem, context.extensionPath);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // --- Register commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNotifications.setupHooks', () => cmdSetupHooks(context, log)),
    vscode.commands.registerCommand('claudeNotifications.removeHooks', () => cmdRemoveHooks(log)),
vscode.commands.registerCommand('claudeNotifications.testNotification', () => cmdTestNotification(context, log)),
    vscode.commands.registerCommand('claudeNotifications.toggleMute', () => {
      const config = readConfig();
      config.muted = !config.muted;
      writeConfig(config);
      updateStatusBar(statusBarItem, context.extensionPath);
      const state = config.muted ? 'muted' : 'unmuted';
      log.appendLine(`Notifications ${state}`);
      vscode.window.showInformationMessage(`Claude Notifications: ${config.muted ? 'Muted' : 'Unmuted'}`);
    }),
    vscode.commands.registerCommand('claudeNotifications.chooseSound', (event) => cmdChooseSound(context, log, event)),
    vscode.commands.registerCommand('claudeNotifications.previewSound', () => cmdPreviewSound(context, log)),
    vscode.commands.registerCommand('claudeNotifications.setupMacNotifier', () => cmdSetupMacNotifier(context, log)),
    vscode.commands.registerCommand('claudeNotifications.uninstall', () => cmdUninstall(log))
  );

  // --- Signal file watcher (polling at 400ms) ---
  const timer = setInterval(() => {
    if (!vscode.workspace.workspaceFolders) return;

    for (const folder of vscode.workspace.workspaceFolders) {
      const workspaceRoot = folder.uri.fsPath;

      // Sweep stale claim markers
      sweepStaleFile(getClaimedPath(workspaceRoot), CLAIM_STALE_MS);
      // Sweep fired signal files (they outlive the claim marker but should
      // still be cleaned up eventually so they don't accumulate).
      sweepFiredSignal(workspaceRoot);

      // Click-to-focus: OS banner click produced a "clicked" marker via
      // terminal-notifier's -execute. Focus the terminal silently — the
      // user already gave explicit intent by clicking.
      const clickedPath = getClickedPath(workspaceRoot);
      if (fs.existsSync(clickedPath)) {
        log.appendLine(`Clicked marker found — ${folder.name}`);
        handleClickedSignal(workspaceRoot, log);
        return;
      }

      // Normal signal: only react when pending. Fired signals are ignored
      // here (hook.js already fired the OS banner).
      const signalPath = getSignalPath(workspaceRoot);
      if (fs.existsSync(signalPath)) {
        handleSignal(signalPath, workspaceRoot, log);
        return;
      }
    }
  }, POLL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // --- Window focus handler ---
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        checkAllSignalFiles(log);
      }
    })
  );

  // --- Auto-fix stale hook paths, then first-run checks (sequential) ---
  autoFixAllProfiles(context, log).then(() => {
    runFirstRunChecks(context, log, statusBarItem);
  });

  // --- Settings sync: VS Code settings → shared config file for hook.js ---
  syncSettingsToConfig(context.extensionPath, log);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeNotifications')) {
        syncSettingsToConfig(context.extensionPath, log);
        updateStatusBar(statusBarItem, context.extensionPath);
      }
    })
  );

  // --- macOS terminal-notifier setup prompt (one-time) ---
  promptMacNotifierSetup(context, log);

  log.appendLine(`Polling every ${POLL_MS}ms for signals`);
  log.appendLine('Ready');
}

// --- Signal handling (atomic claim-based) ---

async function handleSignal(signalPath, workspaceRoot, log) {
  let content;
  try {
    content = fs.readFileSync(signalPath, 'utf8').trim();
  } catch (err) {
    return; // signal file disappeared, nothing to do
  }

  const signal = parseSignal(content);
  if (!signal) {
    log.appendLine('Signal file was empty or stale — removing');
    try { fs.unlinkSync(signalPath); } catch (_) {}
    return;
  }

  // Already fired by hook.js — ignore. Cleanup happens in sweepFiredSignal.
  if (signal.state === 'fired') return;

  const rawEvent = signal.hookEventName || '?';
  const sessionTag = signal.sessionId ? signal.sessionId.slice(0, 8) : '?';
  log.appendLine(`Signal: event=${signal.event}(${rawEvent}), session=${sessionTag}, project=${signal.project}, pids=[${signal.pids.join(',')}], version=${signal.version}`);
  if (signal.aiTitle) log.appendLine(`  title: ${signal.aiTitle}`);
  if (signal.hookMessage) log.appendLine(`  message: ${signal.hookMessage}`);

  const config = readConfig();
  const eventSetting = (config.events && config.events[signal.event]) || 'Sound + Notification';

  // Only the focused VS Code window should claim. Otherwise leave the
  // signal for hook.js to fire its OS banner fallback.
  if (!vscode.window.state.focused) {
    log.appendLine('Window not focused — not claiming, leaving for hook.js fallback');
    return;
  }

  // Atomically claim. Whoever creates the handled-marker first wins.
  // If hook.js beat us to it, skip silently.
  if (!claimHandled(getClaimedPath(workspaceRoot))) {
    log.appendLine('Signal already claimed by hook.js — skipping');
    // Treat the signal as fired so the ignored state holds.
    markSignalFired(signalPath);
    return;
  }

  // We own the notification. Delete the signal file now; any stragglers
  // will exit silently because the claim marker is already set.
  try { fs.unlinkSync(signalPath); } catch (_) {}

  if (config.muted) {
    log.appendLine('Muted — claimed signal, no notification');
    return;
  }

  if (eventSetting === 'Nothing') {
    log.appendLine(`Event "${signal.event}" disabled — claimed, no notification`);
    return;
  }

  const wantSound = eventSetting === 'Sound + Notification' || eventSetting === 'Sound only';
  const wantToast = eventSetting === 'Sound + Notification' || eventSetting === 'Notification only';

  // Case A: focused + correct terminal → sound only (configurable).
  // We deliberately do NOT call markResolved here. The dedup state machine
  // in lib/stage-dedup.js already collapses the Stop→Notification pair
  // Claude fires for one logical attention point: the second event hits
  // the unresolved-stage branch and gets suppressed before hook.js writes
  // a signal. markResolved would set resolved=true and re-open the gate,
  // causing a duplicate sound for the very next event in the same stage.
  // markResolved stays reserved for explicit user acknowledgment (Focus
  // Terminal click, OS banner click).
  // Match against ALL terminals in this window, not just the active one.
  // The matcher's job is "which terminal does this signal belong to?" —
  // restricting to the active terminal causes false positives when the
  // user has multiple Claude sessions in the same workspace: tier=cwd
  // matches any terminal sharing the workspace dir, so an active sibling
  // terminal would erroneously be reported as "correct" and the user
  // would get sound-only instead of the visible Focus-Terminal toast
  // they expected. Running against all terminals and then comparing the
  // match's index to the active index gives us three distinct outcomes
  // (active matches → sound only, different terminal matches → toast,
  // no match → toast) instead of two (matches → sound only, doesn't →
  // toast).
  const activeTerminal = vscode.window.activeTerminal;
  try {
    const allTerminals = vscode.window.terminals;
    const allDescs = await Promise.all(
      allTerminals.map((t, i) => describeTerminalForMatch(t, i))
    );
    log.appendLine(`Open terminals (${allDescs.length}): ${allDescs.map(d => `[${d.index}]"${d.name}"(pid=${d.pid},cwd=${d.cwd || '?'})`).join(', ')}`);
    const m = matchTerminal(allDescs, signal);
    const activeIndex = activeTerminal ? allTerminals.indexOf(activeTerminal) : -1;
    if (m && m.index === activeIndex) {
      const cfg = vscode.workspace.getConfiguration('claudeNotifications');
      const soundWhenFocused = cfg.get('soundWhenFocused', 'sound');
      const toastWhenFocused = cfg.get('toastWhenFocused', false);
      log.appendLine(`Already on correct terminal — sound=${soundWhenFocused === 'sound' && wantSound ? 'on' : 'off'} toast=${toastWhenFocused && wantToast ? 'on' : 'off'} (tier=${m.tier}, ${m.reason})`);
      if (soundWhenFocused === 'sound' && wantSound) {
        playEventSound(signal.event, config);
      }
      if (toastWhenFocused && wantToast) {
        // Info-only toast. We deliberately do NOT include a "Focus
        // Terminal" action — the matcher already confirmed they're on
        // the right terminal, so the button would be a no-op. VS Code
        // auto-dismisses info popups without actions after a few
        // seconds. Same dedup invariant applies: do not call
        // markResolved here either; this is not an explicit user ack.
        const baseMsg = signal.event === 'completed'
          ? `Task completed in: ${signal.project}`
          : `Waiting for your response in: ${signal.project}`;
        const msg = signal.aiTitle ? `${baseMsg} — ${signal.aiTitle}` : baseMsg;
        vscode.window.showInformationMessage(msg);
      }
      return;
    }
    if (m) {
      log.appendLine(`Match found on a non-active terminal [${m.index}] — falling through to Focus Terminal toast (tier=${m.tier}, ${m.reason})`);
    } else {
      log.appendLine('No terminal in this window matched the signal — falling through to Focus Terminal toast');
    }
  } catch (e) {
    log.appendLine(`Terminal-match threw: ${e && e.message ? e.message : String(e)} — falling through to Focus Terminal toast`);
  }

  // Case B: focused + wrong terminal → sound + "Focus Terminal" toast.
  if (wantSound) playEventSound(signal.event, config);

  if (wantToast) {
    const baseMsg = signal.event === 'completed'
      ? `Task completed in: ${signal.project}`
      : `Waiting for your response in: ${signal.project}`;
    const msg = signal.aiTitle ? `${baseMsg} — ${signal.aiTitle}` : baseMsg;
    const action = await vscode.window.showInformationMessage(msg, 'Focus Terminal');

    if (action === 'Focus Terminal') {
      log.appendLine('User clicked Focus Terminal');
      await focusMatchingTerminal(signal, log);
      markResolved(workspaceRoot, signal.sessionId);
    }
  }
}

/**
 * Handle the case where the user clicked an OS banner. hook.js already
 * fired the notification; terminal-notifier's -execute payload wrote a
 * JSON click marker carrying the originating session's pids/sessionId/
 * event. Prefer that marker as the source of truth — the per-workspace
 * `signal` file is shared across all Claude sessions and may have been
 * overwritten by a sibling hook firing in the meantime, which previously
 * caused us to focus the wrong terminal.
 *
 * Legacy markers (empty file, pre-v3.3.1) and stale/corrupt JSON fall
 * back to the signal file as a best-effort second source of truth.
 */
async function handleClickedSignal(workspaceRoot, log) {
  const clickedPath = getClickedPath(workspaceRoot);
  const signalPath = getSignalPath(workspaceRoot);

  let clickPayload = null;
  try {
    const content = fs.readFileSync(clickedPath, 'utf8');
    clickPayload = parseClickMarker(content);
  } catch (_) {}

  let target = null; // pseudo-signal { sessionId, pids, shellPid, workspaceRoot, projectDir, event, project, source }
  if (clickPayload && !clickPayload.legacy && !clickPayload.stale && clickPayload.pids && clickPayload.pids.length > 0) {
    target = { ...clickPayload, source: 'marker' };
  } else {
    if (clickPayload && clickPayload.stale) {
      log.appendLine('Click marker is stale (>5min) — falling back to signal file');
    } else if (clickPayload && clickPayload.legacy) {
      log.appendLine('Click marker has legacy empty payload — falling back to signal file');
    }
    let signal = null;
    try {
      const content = fs.readFileSync(signalPath, 'utf8');
      signal = parseSignal(content);
    } catch (_) {}
    if (signal && signal.pids.length > 0) {
      target = {
        sessionId: signal.sessionId,
        pids: signal.pids,
        shellPid: signal.shellPid || 0,
        workspaceRoot: signal.workspaceRoot || '',
        projectDir: signal.projectDir || '',
        event: signal.event,
        project: signal.project,
        aiTitle: signal.aiTitle || '',
        source: 'signal-fallback'
      };
    }
  }

  // Cleanup regardless of whether we recovered a target.
  try { fs.unlinkSync(clickedPath); } catch (_) {}
  try { fs.unlinkSync(signalPath); } catch (_) {}
  try { fs.unlinkSync(getClaimedPath(workspaceRoot)); } catch (_) {}

  if (!target) {
    log.appendLine('Click-to-focus: no recoverable session payload (marker missing/stale and signal file gone) — opened workspace without switching terminal');
    return;
  }

  const sessionTag = target.sessionId ? target.sessionId.slice(0, 8) : '?';
  const titleSuffix = target.aiTitle ? `, title="${target.aiTitle}"` : '';
  log.appendLine(`Click-to-focus [${target.source}] — event=${target.event}, session=${sessionTag}, project=${target.project}, pids=[${target.pids.join(',')}]${titleSuffix}`);
  await focusMatchingTerminal(target, log);
  markResolved(workspaceRoot, target.sessionId);
}

function markSignalFired(signalPath) {
  try {
    const content = fs.readFileSync(signalPath, 'utf8');
    const data = JSON.parse(content);
    if (data.state !== 'fired') {
      data.state = 'fired';
      fs.writeFileSync(signalPath, JSON.stringify(data, null, 2));
    }
  } catch (_) {}
}

function playEventSound(event, config) {
  const soundPath = config.sounds && config.sounds[event];
  const volume = (config.sounds && config.sounds.volume != null) ? config.sounds.volume : 50;
  if (soundPath) {
    playSoundFile(soundPath, volume);
  } else {
    const soundName = event === 'completed' ? 'task-complete' : 'notification';
    playSound(soundName, volume / 100);
  }
}

function sweepStaleFile(filePath, staleMs) {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > staleMs) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (_) {}
}

function sweepFiredSignal(workspaceRoot) {
  const signalPath = getSignalPath(workspaceRoot);
  try {
    if (!fs.existsSync(signalPath)) return;
    const stat = fs.statSync(signalPath);
    if (Date.now() - stat.mtimeMs < SWEEP_FIRED_MS) return;
    // Only delete if the file is in fired state (or un-parseable).
    const content = fs.readFileSync(signalPath, 'utf8');
    const signal = parseSignal(content);
    if (!signal || signal.state === 'fired') {
      fs.unlinkSync(signalPath);
    }
  } catch (_) {}
}

function checkAllSignalFiles(log) {
  if (!vscode.workspace.workspaceFolders) return;

  for (const folder of vscode.workspace.workspaceFolders) {
    const workspaceRoot = folder.uri.fsPath;
    const clickedPath = getClickedPath(workspaceRoot);
    if (fs.existsSync(clickedPath)) {
      handleClickedSignal(workspaceRoot, log);
      return;
    }
    const signalPath = getSignalPath(workspaceRoot);
    if (fs.existsSync(signalPath)) {
      handleSignal(signalPath, workspaceRoot, log);
      return;
    }
  }
}

// --- Terminal focusing ---

/**
 * Format a terminal for the output channel. Includes the index in
 * vscode.window.terminals so two tabs with the same display name can be
 * told apart. Resolves the shell PID asynchronously; logs `pid=?` if
 * the API throws (disposed terminal, platform quirk).
 */
async function describeTerminal(terminal, index) {
  let pid = '?';
  try {
    const resolved = await terminal.processId;
    if (resolved) pid = String(resolved);
  } catch (_) {}
  return `[${index}]"${terminal.name}"(pid=${pid})`;
}

/**
 * Build the normalized terminal descriptor consumed by lib/terminal-match.
 * Resolves processId and the shell-integration cwd (if available).
 */
async function describeTerminalForMatch(terminal, index) {
  let pid = null;
  try {
    const resolved = await terminal.processId;
    if (resolved) pid = resolved;
  } catch (_) {}
  let cwd = null;
  try {
    // shellIntegration is undefined when the user hasn't enabled it or the
    // shell has not handshaked yet. cwd may be a vscode.Uri or string.
    const si = terminal.shellIntegration;
    if (si && si.cwd) {
      cwd = typeof si.cwd === 'string' ? si.cwd : (si.cwd.fsPath || String(si.cwd));
    }
  } catch (_) {}
  return { index, name: terminal.name || '', pid, cwd };
}

/**
 * Pick a terminal and `show()` it. Uses lib/terminal-match's tiered
 * strategy (PID → cwd → Claude title markers → single non-default name).
 * If no tier matches, intentionally does nothing — the previous
 * "last terminal" fallback opened arbitrary shells (PowerShell when Claude
 * was in Git Bash) and was worse than no action.
 */
async function focusMatchingTerminal(signal, log) {
  const terminals = vscode.window.terminals;
  if (terminals.length === 0) {
    log.appendLine('No terminals open to focus');
    return;
  }
  const descs = await Promise.all(terminals.map((t, i) => describeTerminalForMatch(t, i)));
  const pretty = descs.map(d => `[${d.index}]"${d.name}"(pid=${d.pid || '?'}${d.cwd ? `,cwd=${d.cwd}` : ''})`);
  log.appendLine(`Open terminals (${terminals.length}): ${pretty.join(', ')}`);

  const m = matchTerminal(descs, signal);
  if (!m) {
    log.appendLine('No confident terminal match — leaving terminal focus alone (workspace opened, but no terminal switch).');
    return;
  }
  const terminal = terminals[m.index];
  log.appendLine(`Match tier=${m.tier} — ${m.reason} → ${pretty[m.index]}`);
  await showTerminal(terminal, log);
}

async function showTerminal(terminal, log) {
  terminal.show();
  setTimeout(async () => {
    const active = vscode.window.activeTerminal;
    if (!active) {
      log.appendLine('Active terminal after switch: none');
      return;
    }
    const index = vscode.window.terminals.indexOf(active);
    log.appendLine(`Active terminal after switch: ${await describeTerminal(active, index)}`);
  }, 300);
}

// --- Config file (shared with hook.js) ---

function getConfigPath() {
  return path.join(os.homedir(), '.claude', CONFIG_FILE);
}

function readConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (_) {}
  return { muted: false, soundEnabled: true, volume: 0.5 };
}

function writeConfig(config) {
  try {
    const configPath = getConfigPath();
    const claudeDir = path.dirname(configPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (_) {}
}

function updateStatusBar(item, extensionPath) {
  const { status } = checkHookStatus(getWrapperPaths().hookPath);

  if (status === 'not-installed' || status === 'no-file') {
    item.text = '$(gear) Claude: Set Up';
    item.tooltip = 'Claude Notifications: Click to install hooks';
    item.command = 'claudeNotifications.setupHooks';
    return;
  }

  item.command = 'claudeNotifications.toggleMute';
  const config = readConfig();
  if (config.muted) {
    item.text = '$(bell-slash) Claude: Muted';
    item.tooltip = 'Claude Notifications: Muted (click to unmute)';
  } else {
    item.text = '$(bell) Claude: Notify';
    item.tooltip = 'Claude Notifications: Active (click to mute)';
  }
}

// --- Commands ---

async function cmdSetupHooks(context, log) {
  const wrapper = getWrapperPaths();
  const { status } = checkHookStatus(wrapper.hookPath);

  if (status === 'installed') {
    vscode.window.showInformationMessage('Claude Notifications hooks are already installed.');
    return;
  }

  let replaceLegacy = false;
  if (status === 'legacy') {
    const choice = await vscode.window.showInformationMessage(
      'Legacy Claude Notifications hooks detected (shell scripts). Replace with the new Node.js hooks?',
      'Replace', 'Keep Both', 'Cancel'
    );
    if (choice === 'Cancel' || !choice) return;
    replaceLegacy = choice === 'Replace';
  } else {
    const choice = await vscode.window.showInformationMessage(
      'Install Claude Code hooks for notifications and terminal focus? This will modify ~/.claude/settings.json (a backup will be created).',
      'Install', 'Cancel'
    );
    if (choice !== 'Install') return;
  }

  const result = installHooks(wrapper, { replaceLegacy });

  if (result.success) {
    log.appendLine(`Hooks installed. Backup: ${result.backupPath}`);
    vscode.window.showInformationMessage(result.message);
    updateStatusBar(_statusBarItem, context.extensionPath);
    syncSettingsToConfig(context.extensionPath, log);

  } else {
    vscode.window.showErrorMessage(result.message);
  }
}

async function cmdRemoveHooks(log) {
  const choice = await vscode.window.showWarningMessage(
    'Remove Claude Notifications hooks from ~/.claude/settings.json?',
    'Remove', 'Cancel'
  );
  if (choice !== 'Remove') return;

  const result = uninstallHooks();
  if (result.success) {
    log.appendLine(result.message);
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showErrorMessage(result.message);
  }
}


async function cmdTestNotification(context, log) {
  const hookPath = path.join(context.extensionPath, 'dist', 'hook.js');
  const { spawn } = require('child_process');
  const child = spawn('node', [hookPath], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir() },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.end('{"hook_event_name":"Notification"}');
  child.on('close', (code) => {
    if (code !== 0) log.appendLine(`Test notification exited with code ${code}`);
    else log.appendLine('Test notification sent via hook.js');
  });
}

// --- macOS terminal-notifier setup ---

// Common install locations for Homebrew-managed binaries on macOS.
// VS Code launched from Finder/Dock does not inherit the shell PATH, so we
// can't rely on `command -v` / `which` — probe known paths directly.
const MAC_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

function findMacBinary(name) {
  for (const dir of MAC_BIN_DIRS) {
    const p = `${dir}/${name}`;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {}
  }
  // Fallback: try the shell in case PATH is actually populated.
  try {
    const stdout = require('child_process').execSync(`command -v ${name}`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return stdout || null;
  } catch (_) {
    return null;
  }
}

function detectTerminalNotifier() {
  if (_terminalNotifierCached !== null) return _terminalNotifierCached;
  _terminalNotifierCached = findMacBinary('terminal-notifier');
  return _terminalNotifierCached;
}

async function promptMacNotifierSetup(context, log) {
  if (process.platform !== 'darwin') return;

  if (detectTerminalNotifier()) return; // already installed — nothing to prompt

  const prompted = context.globalState.get('macNotifierPromptAnswered', false);
  if (prompted) return;

  const choice = await vscode.window.showInformationMessage(
    'Claude Notifications: Install terminal-notifier for click-to-open OS banners? Recommended for best experience. Using osascript fallback otherwise.',
    'Install (Recommended)', 'Keep osascript', "Don't Ask Again"
  );

  if (choice === 'Install (Recommended)') {
    await installTerminalNotifier(context, log);
  } else if (choice === "Don't Ask Again" || choice === 'Keep osascript') {
    await context.globalState.update('macNotifierPromptAnswered', true);
  }
}

async function cmdUninstall(log) {
  const confirm = await vscode.window.showWarningMessage(
    'Uninstall Claude Notifications: remove Claude Code hooks, click-handler registry key (Windows), and per-workspace state directories?',
    { modal: true },
    'Uninstall'
  );
  if (confirm !== 'Uninstall') return;

  const { uninstallHooks } = require('./lib/hooks-installer');

  try {
    uninstallHooks();
    log.appendLine('Uninstall: hooks removed');
  } catch (e) {
    log.appendLine(`Uninstall: hooks removal failed — ${e.message}`);
  }

  try {
    const r = uninstallHookRuntime();
    log.appendLine(`Uninstall: hook runtime dir removed (${r.ok ? 'ok' : r.error})`);
  } catch (e) {
    log.appendLine(`Uninstall: hook runtime removal threw — ${e.message}`);
  }

  if (process.platform === 'win32') {
    try {
      const { uninstallWinProtocol, getLauncherDir } = require('./lib/win-protocol');
      const r = uninstallWinProtocol();
      log.appendLine(`Uninstall: registry key removed (${r.ok ? 'ok' : r.error})`);
      try {
        const dir = getLauncherDir();
        fs.rmSync(dir, { recursive: true, force: true });
        log.appendLine(`Uninstall: launcher dir removed (${dir})`);
      } catch (e) {
        log.appendLine(`Uninstall: launcher dir removal failed — ${e.message}`);
      }
    } catch (e) {
      log.appendLine(`Uninstall: registry cleanup threw — ${e.message}`);
    }
  }

  try {
    const stateDir = path.join(os.homedir(), '.claude', 'focus-state');
    fs.rmSync(stateDir, { recursive: true, force: true });
    log.appendLine(`Uninstall: state dir removed (${stateDir})`);
  } catch (e) {
    log.appendLine(`Uninstall: state dir removal failed — ${e.message}`);
  }

  vscode.window.showInformationMessage(
    'Claude Notifications: cleanup complete. You can now safely uninstall the extension from the Extensions view.'
  );
}

async function cmdSetupMacNotifier(context, log) {
  if (process.platform !== 'darwin') {
    vscode.window.showInformationMessage('terminal-notifier setup is only needed on macOS.');
    return;
  }

  _terminalNotifierCached = null; // force re-detect
  const tnPath = detectTerminalNotifier();

  if (tnPath) {
    const choice = await vscode.window.showInformationMessage(
      `terminal-notifier is already installed at: ${tnPath}`,
      'Open Notification Settings',
      'Test Banner',
      'Reinstall',
      'Cancel'
    );
    if (choice === 'Open Notification Settings') {
      openMacNotificationSettings();
      vscode.window.showInformationMessage(
        'Tip: For alerts that stay on screen until dismissed, set terminal-notifier to "Alerts" (instead of "Banners"). If you see duplicate entries, keep the one labeled with "Badges, Sounds, Alerts" and leave the other off — they come from past installs macOS still remembers.'
      );
    } else if (choice === 'Test Banner') {
      await cmdTestNotification(context, log);
    } else if (choice === 'Reinstall') {
      await installTerminalNotifier(context, log);
    }
    return;
  }

  await installTerminalNotifier(context, log);
}

function openMacNotificationSettings() {
  try {
    require('child_process').spawn(
      'open',
      ['x-apple.systempreferences:com.apple.preference.notifications'],
      { detached: true, stdio: 'ignore' }
    ).unref();
  } catch (_) {}
}

async function installTerminalNotifier(context, log) {
  const brewPath = findMacBinary('brew');
  if (!brewPath) {
    vscode.window.showInformationMessage(
      'Homebrew not found. Install terminal-notifier manually: https://github.com/julienXX/terminal-notifier#installation'
    );
    return;
  }

  const terminal = vscode.window.createTerminal('Claude Notifications Setup');
  terminal.show();
  terminal.sendText(`${brewPath} install terminal-notifier && echo "\\n✅ terminal-notifier installed! You can close this terminal."`);
  await context.globalState.update('macNotifierPromptAnswered', true);
  _terminalNotifierCached = null; // invalidate cache for next call
  log.appendLine('terminal-notifier install started via Homebrew');
}

// --- Legacy extension detection ---

function warnIfLegacyExtensionActive(context, log) {
  const legacy = vscode.extensions.getExtension(LEGACY_EXTENSION_ID);
  if (!legacy) return;

  log.appendLine(`LEGACY EXTENSION DETECTED: ${LEGACY_EXTENSION_ID} v${legacy.packageJSON.version} is installed and may be causing duplicate notifications`);

  const warned = context.globalState.get('legacyExtensionWarned', false);
  if (warned) return;

  // Defer to not overwhelm startup
  setTimeout(async () => {
    const choice = await vscode.window.showWarningMessage(
      `Claude Notifications: The older extension "${legacy.packageJSON.displayName || LEGACY_EXTENSION_ID}" is still installed and competing for notifications. Uninstall it to prevent duplicates.`,
      'Open Extensions',
      "Don't Show Again"
    );
    if (choice === 'Open Extensions') {
      vscode.commands.executeCommand('workbench.extensions.search', `@installed ${LEGACY_EXTENSION_ID}`);
    } else if (choice === "Don't Show Again") {
      await context.globalState.update('legacyExtensionWarned', true);
    }
  }, 3000);
}

// --- Auto-fix stale hook paths across every Claude config profile ---
//
// Scans ~/.claude/ plus every ~/.claude-* sibling that already has our hooks
// installed (CLAUDE_CONFIG_DIR profiles). Profiles with stale paths or a
// missing UserPromptSubmit hook get repaired in place when autoSetupHooks=true.
// When autoSetupHooks=false, the user is warned but nothing is touched.

async function autoFixAllProfiles(context, log) {
  const config = vscode.workspace.getConfiguration('claudeNotifications');
  const autoSetup = config.get('autoSetupHooks', true);

  const wrapper = getWrapperPaths();
  const results = checkAllProfiles(wrapper.hookPath);
  const needsFix = results.filter(r => r.status === 'stale-path' || r.status === 'partial');

  if (needsFix.length === 0) return;

  const fixed = [];
  const failed = [];
  for (const profile of needsFix) {
    log.appendLine(`Profile needs fix: ${profile.path} (status=${profile.status}, installed=${profile.installedPath || 'n/a'})`);
    if (!autoSetup) continue;
    const result = installHooks(wrapper, { settingsPath: profile.path });
    if (result.success) {
      fixed.push(profile.path);
    } else {
      failed.push({ path: profile.path, message: result.message });
    }
  }

  if (fixed.length > 0) {
    log.appendLine(`Auto-fixed hook paths in ${fixed.length} profile(s): ${fixed.join(', ')}`);
    updateStatusBar(_statusBarItem, context.extensionPath);
    const summary = fixed.length === 1
      ? `Claude Notifications: updated stale hook paths in ${path.basename(path.dirname(fixed[0]))}/settings.json.`
      : `Claude Notifications: updated stale hook paths in ${fixed.length} Claude profiles. Restart any active 'claude' sessions for the change to take effect.`;
    vscode.window.showInformationMessage(summary);
  }

  for (const f of failed) {
    log.appendLine(`Failed to update ${f.path}: ${f.message}`);
  }

  if (!autoSetup) {
    const profileNames = needsFix.map(p => path.basename(path.dirname(p.path))).join(', ');
    vscode.window.showWarningMessage(
      `Claude Notifications: stale or incomplete hooks detected in ${needsFix.length} Claude profile(s) (${profileNames}). Run "Claude Notifications: Set Up Hooks" or enable claudeNotifications.autoSetupHooks.`
    );
  }
}

// --- First-run checks ---
//
// Semantics of `autoSetupHooks`:
//   true  (default) — install/upgrade silently; show a confirmation toast
//                     so the user knows what happened.
//   false           — prompt before any modification of ~/.claude/settings.json.

async function runFirstRunChecks(context, log, statusBarItem) {
  const wrapper = getWrapperPaths();
  const { status } = checkHookStatus(wrapper.hookPath);
  log.appendLine(`Hook status: ${status}`);

  if (status === 'installed' || status === 'stale-path') return;

  const config = vscode.workspace.getConfiguration('claudeNotifications');
  const autoSetup = config.get('autoSetupHooks', true);

  if (status === 'not-installed' || status === 'no-file') {
    if (!autoSetup) {
      const choice = await vscode.window.showInformationMessage(
        'Claude Notifications: install the Claude Code hooks now? (Required for notifications to fire.)',
        'Install', 'Later', 'Always Auto-Install'
      );
      if (choice === 'Always Auto-Install') {
        await config.update('autoSetupHooks', true, vscode.ConfigurationTarget.Global);
      } else if (choice !== 'Install') {
        return;
      }
    }
    const result = installHooks(wrapper, {});
    if (result.success) {
      log.appendLine('Hooks installed on first run');
      vscode.window.showInformationMessage(
        'Claude Notifications: Hooks installed. You\'ll now get notified when Claude needs attention.'
      );
      updateStatusBar(statusBarItem, context.extensionPath);
      syncSettingsToConfig(context.extensionPath, log);
    } else {
      log.appendLine(`Install failed: ${result.message}`);
    }
    return;
  }

  if (status === 'legacy') {
    if (autoSetup) {
      // Auto-upgrade silently with a confirmation toast.
      const result = installHooks(wrapper, { replaceLegacy: true });
      if (result.success) {
        log.appendLine('Legacy shell-script hooks auto-upgraded to Node.js hooks');
        vscode.window.showInformationMessage(
          'Claude Notifications: upgraded legacy shell-script hooks to the new Node.js hooks.'
        );
        updateStatusBar(statusBarItem, context.extensionPath);
        syncSettingsToConfig(context.extensionPath, log);
      } else {
        log.appendLine(`Legacy upgrade failed: ${result.message}`);
      }
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'Claude Notifications: legacy shell-script hooks detected. Upgrade to the new Node.js hooks?',
      'Upgrade', 'Later', 'Always Auto-Upgrade'
    );
    if (choice === 'Always Auto-Upgrade') {
      await config.update('autoSetupHooks', true, vscode.ConfigurationTarget.Global);
      await cmdSetupHooks(context, log);
    } else if (choice === 'Upgrade') {
      await cmdSetupHooks(context, log);
    }
  }
}

// --- Settings sync: VS Code settings → shared config file ---

function syncSettingsToConfig(extensionPath, log) {
  const cfg = vscode.workspace.getConfiguration('claudeNotifications');
  const config = readConfig();

  // Read from the per-event keys (claudeNotifications.waiting.*,
  // claudeNotifications.completed.*) and the universal `volume` key, then
  // write the same { sounds, events } shape the hook reads from the shared
  // config file. Keeping that shape stable means hook.js doesn't need to
  // know about the VS Code key rename.
  config.sounds = {
    waiting: resolveSoundPath(
      cfg.get('waiting.sound', 'bundled:notification'),
      cfg.get('waiting.customSoundPath', ''),
      extensionPath
    ),
    completed: resolveSoundPath(
      cfg.get('completed.sound', 'bundled:task-complete'),
      cfg.get('completed.customSoundPath', ''),
      extensionPath
    ),
    volume: cfg.get('volume', 50)
  };

  config.events = {
    waiting: cfg.get('waiting.action', 'Sound + Notification'),
    completed: cfg.get('completed.action', 'Sound + Notification')
  };

  // Windows-only: read by bin/win-click-handler.js (the OS toast launcher) at
  // click time to decide between Win32 HWND focusing ("hwnd", default) and
  // the legacy `code <workspace>` CLI routing ("cli"). See README.
  config.windowsClickBehavior = cfg.get('windows.clickBehavior', 'hwnd');

  writeConfig(config);
  log.appendLine('Settings synced to shared config');
}

// --- Choose Sound / Preview Sound commands ---
//
// Both commands use createQuickPick (rather than showQuickPick) so each item
// can carry a speaker-icon button. Clicking the speaker previews that row's
// sound at the user's configured volume; arrow-keying does *not* play anything
// — playback is strictly opt-in per click.
//
// The sound list is platform-detected at invocation time via discoverSystemSounds,
// which reads /System/Library/Sounds on macOS, C:\Windows\Media on Windows, and
// /usr/share/sounds/freedesktop on Linux, so each OS sees only sounds that
// actually exist on the machine.

function platformLabel() {
  return { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || 'System';
}

/**
 * Build the QuickPick item list. `previewable` entries get a speaker button
 * so the user can click to hear them. The button object is frozen and shared
 * across items so the onDidTriggerItemButton handler can identify it by
 * reference — safer than tooltip-string comparison.
 */
function buildSoundItems({ includeCustom = true, includeNone = true, currentValue = null, previewButton } = {}) {
  const items = [];
  const mark = (val, label) => (val === currentValue ? `$(check) ${label}` : `       ${label}`);
  const withPreview = (item) => (previewButton ? { ...item, buttons: [previewButton] } : item);

  if (includeNone) {
    items.push({
      label: mark('none', '$(mute) Silent — no sound'),
      description: 'none',
      detail: 'Banner/toast still shows, no audio',
      value: 'none',
      previewable: false
    });
  }

  items.push(
    withPreview({
      label: mark('bundled:notification', '$(package) Bundled · Notification'),
      description: 'bundled:notification',
      detail: 'Cross-platform chime designed for "waiting" events',
      value: 'bundled:notification',
      previewable: true
    }),
    withPreview({
      label: mark('bundled:task-complete', '$(package) Bundled · Task Complete'),
      description: 'bundled:task-complete',
      detail: 'Cross-platform chime designed for "completed" events',
      value: 'bundled:task-complete',
      previewable: true
    })
  );

  const os = platformLabel();
  const systemSounds = discoverSystemSounds();
  if (systemSounds.length === 0) {
    items.push({
      label: '$(warning) No system sounds detected on this OS',
      kind: vscode.QuickPickItemKind.Separator
    });
  } else {
    items.push({
      label: `$(device-desktop) ${os} system sounds (${systemSounds.length})`,
      kind: vscode.QuickPickItemKind.Separator
    });
    for (const s of systemSounds) {
      const value = `system:${s.label}`;
      items.push(withPreview({
        label: mark(value, `$(device-desktop) ${os} · ${s.label}`),
        description: value,
        detail: s.path,
        value,
        previewable: true
      }));
    }
  }

  if (includeCustom) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: mark('custom', '$(file) Custom file…'),
      description: 'custom',
      detail: 'Pick a .wav / .mp3 / .aiff / .ogg file from disk',
      value: 'custom',
      previewable: false
    });
  }

  return items;
}

/**
 * Play the sound for a previewable item. Fire-and-forget; overlapping plays
 * are fine — each is a short (~1-2s) afplay/paplay process.
 */
function playPreview(item, extensionPath, volume) {
  if (!item || !item.previewable || !item.value) return;
  if (item.value === 'custom' || item.value === 'none') return;
  const filePath = resolveSoundPath(item.value, '', extensionPath);
  if (filePath) playSoundFile(filePath, volume);
}

/**
 * Construct the speaker button. Created per-picker so the reference identity
 * is stable for that picker's lifetime and can't leak across sessions.
 */
function createPreviewButton() {
  return {
    iconPath: new vscode.ThemeIcon('unmute'),
    tooltip: 'Preview this sound'
  };
}

// Per-event metadata. Settings keys live under claudeNotifications.waiting.*
// and claudeNotifications.completed.*; the `icon` / `defaultSoundLabel` pairs
// are used by the Preview picker to render a compact two-row display.
const EVENT_META = {
  waiting: {
    label: 'Waiting',
    detail: 'Fires when Claude needs your response',
    setting: 'waiting.sound',
    pathSetting: 'waiting.customSoundPath',
    icon: '$(bell)'
  },
  completed: {
    label: 'Completed',
    detail: 'Fires when Claude finishes a task',
    setting: 'completed.sound',
    pathSetting: 'completed.customSoundPath',
    icon: '$(check-all)'
  }
};

/**
 * Human-readable name for a sound-setting value, used by Preview Sound to
 * display "Currently: Bundled · Notification" / "macOS · Glass" / etc.
 */
function soundDisplayName(value, customPath) {
  if (!value || value === 'none') return 'Silent';
  if (value === 'bundled:notification') return 'Bundled · Notification';
  if (value === 'bundled:task-complete') return 'Bundled · Task Complete';
  if (value.startsWith('system:')) {
    const name = value.slice('system:'.length);
    return `${platformLabel()} · ${name}`;
  }
  if (value === 'custom') {
    const tail = customPath ? customPath.split('/').pop() : '(no file selected)';
    return `Custom file · ${tail}`;
  }
  return value;
}

async function cmdChooseSound(context, log, eventArg) {
  // When invoked from a setting's markdown link, VS Code passes the event
  // as a string argument ("waiting" / "completed"). When invoked from the
  // command palette, there's no argument and we need to ask.
  let eventKey = eventArg;
  if (eventKey !== 'waiting' && eventKey !== 'completed') {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Waiting', description: EVENT_META.waiting.detail, value: 'waiting' },
        { label: 'Completed', description: EVENT_META.completed.detail, value: 'completed' }
      ],
      { placeHolder: 'Configure sound for which event?' }
    );
    if (!choice) return;
    eventKey = choice.value;
  }

  const meta = EVENT_META[eventKey];
  const cfg = vscode.workspace.getConfiguration('claudeNotifications');
  const currentValue = cfg.get(meta.setting);
  // Volume is captured at picker-open time; it matches the real notification
  // path (hook.js also reads volume once when it fires).
  const volume = cfg.get('volume', 50);
  const previewButton = createPreviewButton();

  const picker = vscode.window.createQuickPick();
  picker.title = `Sound for "${meta.label}" event`;
  picker.placeholder = 'Click the $(unmute) speaker to preview. Enter to save, Escape to cancel.';
  picker.items = buildSoundItems({ currentValue, previewButton });
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.ignoreFocusOut = false;

  // Speaker button → preview. Reference-equality check keeps the handler
  // robust if new buttons are added later.
  picker.onDidTriggerItemButton(({ item, button }) => {
    if (button !== previewButton) return;
    playPreview(item, context.extensionPath, volume);
  });

  picker.onDidAccept(async () => {
    const pick = picker.selectedItems[0];
    picker.hide();
    if (!pick || !pick.value) return;

    if (pick.value === 'custom') {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        openLabel: 'Use this sound',
        filters: { 'Audio': ['wav', 'mp3', 'aiff', 'ogg'] }
      });
      if (!files || files.length === 0) return;
      await cfg.update(meta.pathSetting, files[0].fsPath, vscode.ConfigurationTarget.Global);
    }

    await cfg.update(meta.setting, pick.value, vscode.ConfigurationTarget.Global);
    log.appendLine(`Sound for "${meta.label}" set to: ${pick.value}`);
    vscode.window.showInformationMessage(`Claude Notifications: "${meta.label}" sound set to ${pick.value}`);
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}

/**
 * Preview Sound plays the user's currently-configured sounds for each event.
 * Two rows: Waiting / Completed, each showing the current sound name and a
 * speaker button. Click the speaker (or highlight + Enter) to hear that
 * row's sound at the configured volume.
 */
async function cmdPreviewSound(context, log) {
  const cfg = vscode.workspace.getConfiguration('claudeNotifications');
  const volume = cfg.get('volume', 50);
  const previewButton = createPreviewButton();

  const makeRow = (eventKey) => {
    const meta = EVENT_META[eventKey];
    const value = cfg.get(meta.setting);
    const customPath = cfg.get(meta.pathSetting, '');
    const name = soundDisplayName(value, customPath);
    const filePath = resolveSoundPath(value, customPath, context.extensionPath);
    return {
      label: `${meta.icon}  ${meta.label}`,
      description: `Currently: ${name}`,
      detail: filePath || '(no audio file — will be silent)',
      eventKey,
      filePath,
      buttons: filePath ? [previewButton] : []
    };
  };

  const picker = vscode.window.createQuickPick();
  picker.title = 'Preview Sound';
  picker.placeholder = 'Click the $(unmute) speaker (or press Enter) to hear that notification. Escape to close.';
  picker.items = [makeRow('waiting'), makeRow('completed')];
  picker.matchOnDescription = false;
  picker.matchOnDetail = false;

  const playRow = (item) => {
    if (!item || !item.filePath) {
      vscode.window.showInformationMessage(
        `Claude Notifications: "${item && item.label ? item.label.replace(/^\S+\s+/, '') : 'This event'}" has no sound configured.`
      );
      return;
    }
    playSoundFile(item.filePath, volume);
  };

  picker.onDidTriggerItemButton(({ item, button }) => {
    if (button !== previewButton) return;
    playRow(item);
  });

  // Enter plays the highlighted row (keyboard-only shortcut); picker stays
  // open so the user can preview both events without reopening.
  picker.onDidAccept(() => playRow(picker.selectedItems[0] || picker.activeItems[0]));

  picker.onDidHide(() => picker.dispose());
  picker.show();
  log.appendLine('Preview Sound picker opened');
}

function deactivate() {}

module.exports = { activate, deactivate };
