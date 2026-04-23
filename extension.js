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
  getSignalPath,
  getClickedPath,
  getClaimedPath,
  claimHandled,
  parseSignal,
  CLAIM_STALE_MS
} = require('./lib/signals');
const { checkHookStatus, installHooks, uninstallHooks } = require('./lib/hooks-installer');
const { checkGitignoreStatus, setupGitignore } = require('./lib/gitignore-setup');
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
    vscode.commands.registerCommand('claudeNotifications.setupGitignore', () => cmdSetupGitignore(log)),
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
    vscode.commands.registerCommand('claudeNotifications.setupMacNotifier', () => cmdSetupMacNotifier(context, log))
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
  autoFixHookPaths(context, log).then(() => {
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
  const activeTerminal = vscode.window.activeTerminal;
  if (activeTerminal) {
    try {
      const activePid = await activeTerminal.processId;
      if (activePid && signal.pids.includes(activePid)) {
        log.appendLine('Already on correct terminal — sound only (if enabled)');
        const soundWhenFocused = vscode.workspace.getConfiguration('claudeNotifications').get('soundWhenFocused', 'sound');
        if (soundWhenFocused === 'sound' && wantSound) {
          playEventSound(signal.event, config);
        }
        return;
      }
    } catch (_) {}
  }

  // Case B: focused + wrong terminal → sound + "Focus Terminal" toast.
  if (wantSound) playEventSound(signal.event, config);

  if (wantToast) {
    const action = await vscode.window.showInformationMessage(
      signal.event === 'completed'
        ? `Task completed in: ${signal.project}`
        : `Waiting for your response in: ${signal.project}`,
      'Focus Terminal'
    );

    if (action === 'Focus Terminal') {
      log.appendLine('User clicked Focus Terminal');
      await focusMatchingTerminal(signal.pids, log);
    }
  }
}

/**
 * Handle the case where the user clicked an OS banner. hook.js already
 * fired the notification and terminal-notifier dropped the clicked marker.
 * Focus the matching terminal and clean up — no toast (user's intent is
 * already clear).
 */
async function handleClickedSignal(workspaceRoot, log) {
  const clickedPath = getClickedPath(workspaceRoot);
  const signalPath = getSignalPath(workspaceRoot);

  let signal = null;
  try {
    const content = fs.readFileSync(signalPath, 'utf8');
    signal = parseSignal(content);
  } catch (_) {}

  // Cleanup regardless
  try { fs.unlinkSync(clickedPath); } catch (_) {}
  try { fs.unlinkSync(signalPath); } catch (_) {}
  try { fs.unlinkSync(getClaimedPath(workspaceRoot)); } catch (_) {}

  if (signal && signal.pids.length > 0) {
    const rawEvent = signal.hookEventName || '?';
    const sessionTag = signal.sessionId ? signal.sessionId.slice(0, 8) : '?';
    log.appendLine(`Click-to-focus — event=${signal.event}(${rawEvent}), session=${sessionTag}, project=${signal.project}, pids=[${signal.pids.join(',')}]`);
    await focusMatchingTerminal(signal.pids, log);
  }
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

async function focusMatchingTerminal(pids, log) {
  const terminals = vscode.window.terminals;
  const descriptions = await Promise.all(terminals.map((t, i) => describeTerminal(t, i)));
  log.appendLine(`Open terminals (${terminals.length}): ${descriptions.join(', ')}`);

  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];
    try {
      const termPid = await terminal.processId;
      if (termPid && pids.includes(termPid)) {
        log.appendLine(`PID match: ${await describeTerminal(terminal, i)}`);
        await showTerminal(terminal, log);
        return;
      }
    } catch (_) {}
  }

  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];
    const name = terminal.name.toLowerCase();
    if (name.includes('claude') || name.includes('node')) {
      log.appendLine(`Name match: ${await describeTerminal(terminal, i)}`);
      await showTerminal(terminal, log);
      return;
    }
  }

  if (terminals.length > 0) {
    const lastIndex = terminals.length - 1;
    const lastTerminal = terminals[lastIndex];
    log.appendLine(`Fallback: last terminal ${await describeTerminal(lastTerminal, lastIndex)}`);
    await showTerminal(lastTerminal, log);
    return;
  }

  log.appendLine('No terminals found to focus');
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
  const { status } = checkHookStatus(extensionPath);

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
  const { status } = checkHookStatus(context.extensionPath);

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

  const result = installHooks(context.extensionPath, { replaceLegacy });

  if (result.success) {
    log.appendLine(`Hooks installed. Backup: ${result.backupPath}`);
    vscode.window.showInformationMessage(result.message);
    updateStatusBar(_statusBarItem, context.extensionPath);
    syncSettingsToConfig(context.extensionPath, log);

    const gitStatus = checkGitignoreStatus();
    if (!gitStatus.configured) {
      const gitChoice = await vscode.window.showInformationMessage(
        'Add signal files to global gitignore?',
        'Yes', 'No'
      );
      if (gitChoice === 'Yes') {
        const gitResult = setupGitignore();
        vscode.window.showInformationMessage(gitResult.message);
      }
    }
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

async function cmdSetupGitignore(log) {
  const result = setupGitignore();
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
  const fs = require('fs');
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

// --- Auto-fix stale hook paths ---

async function autoFixHookPaths(context, log) {
  const { status, installedPath } = checkHookStatus(context.extensionPath);
  if (status !== 'stale-path') return;

  log.appendLine(`Hook path stale: ${installedPath} -> ${context.extensionPath}`);
  const result = installHooks(context.extensionPath, {});
  if (result.success) {
    log.appendLine('Hook paths updated automatically');
    updateStatusBar(_statusBarItem, context.extensionPath);
  } else {
    log.appendLine(`Failed to update hook paths: ${result.message}`);
  }
}

// --- First-run checks ---
//
// Semantics of `autoSetupHooks`:
//   true  (default) — install/upgrade silently; show a confirmation toast
//                     so the user knows what happened.
//   false           — prompt before any modification of ~/.claude/settings.json.

async function runFirstRunChecks(context, log, statusBarItem) {
  const { status } = checkHookStatus(context.extensionPath);
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
    const result = installHooks(context.extensionPath, {});
    if (result.success) {
      log.appendLine('Hooks installed on first run');
      vscode.window.showInformationMessage(
        'Claude Notifications: Hooks installed. You\'ll now get notified when Claude needs attention.'
      );
      const gitStatus = checkGitignoreStatus();
      if (!gitStatus.configured) setupGitignore();
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
      const result = installHooks(context.extensionPath, { replaceLegacy: true });
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
