// extension.js — Claude Notifications v2.1
// The hook.js handles sound + OS notifications (runs outside VS Code).
// This extension handles: terminal focusing, status bar mute toggle, commands, first-run setup.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSignalPath, getClickedPath, parseSignal } = require('./lib/signals');
const { checkHookStatus, installHooks, uninstallHooks } = require('./lib/hooks-installer');
const { checkGitignoreStatus, setupGitignore } = require('./lib/gitignore-setup');
const { playSound } = require('./lib/sounds');

const POLL_MS = 800;
const CONFIG_FILE = 'claude-notifications-config.json';

function activate(context) {
  const log = vscode.window.createOutputChannel('Claude Notifications');
  log.appendLine('Claude Notifications v2.1 activated');
  log.appendLine(`Workspace folders: ${(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).join(', ') || 'none'}`);

  // --- Status bar mute toggle ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeNotifications.toggleMute';
  updateStatusBar(statusBarItem);
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
      updateStatusBar(statusBarItem);
      const state = config.muted ? 'muted' : 'unmuted';
      log.appendLine(`Notifications ${state}`);
      vscode.window.showInformationMessage(`Claude Notifications: ${config.muted ? 'Muted' : 'Unmuted'}`);
    })
  );

  // --- Signal file watcher (polling) ---
  // When signal detected: focus the correct terminal.
  // Sound + OS notification are already handled by hook.js (outside VS Code).

  const timer = setInterval(() => {
    if (!vscode.workspace.workspaceFolders) return;

    for (const folder of vscode.workspace.workspaceFolders) {
      // Check for v1-style clicked marker (backwards compat with terminal-notifier)
      const clickedPath = getClickedPath(folder.uri.fsPath);
      if (fs.existsSync(clickedPath)) {
        log.appendLine(`Clicked marker found (v1 compat) — ${folder.name}`);
        try { fs.unlinkSync(clickedPath); } catch (_) {}
        const signalPath = getSignalPath(folder.uri.fsPath);
        handleSignal(signalPath, log);
        return;
      }

      // Check for signal file
      const signalPath = getSignalPath(folder.uri.fsPath);
      if (fs.existsSync(signalPath)) {
        log.appendLine(`Signal file found — ${folder.name}`);
        handleSignal(signalPath, log);
        return;
      }
    }
  }, POLL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // --- Window focus handler ---
  // When user clicks the OS notification, VS Code gains focus → check for signal → focus terminal
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        checkAllSignalFiles(log);
      }
    })
  );

  // --- First-run checks ---
  runFirstRunChecks(context, log);

  log.appendLine(`Polling every ${POLL_MS}ms for signals`);
  log.appendLine('Ready');
}

// --- Signal handling ---

async function handleSignal(signalPath, log) {
  let content;
  try {
    content = fs.readFileSync(signalPath, 'utf8').trim();
  } catch (err) {
    log.appendLine(`Could not read signal file: ${err.message}`);
    return;
  }

  try { fs.unlinkSync(signalPath); } catch (_) {}

  const signal = parseSignal(content);
  if (!signal) {
    log.appendLine('Signal file was empty or stale — ignoring');
    return;
  }

  log.appendLine(`Signal: event=${signal.event}, project=${signal.project}, pids=[${signal.pids.join(',')}], version=${signal.version}`);

  // Smart check: if we're already on the correct terminal, don't disrupt
  const activeTerminal = vscode.window.activeTerminal;
  if (activeTerminal && vscode.window.state.focused) {
    try {
      const activePid = await activeTerminal.processId;
      if (activePid && signal.pids.includes(activePid)) {
        log.appendLine(`Already on the correct terminal — no action needed`);
        return;
      }
    } catch (_) {}
  }

  // Show an in-window notification with "Focus Terminal" button
  // This supplements the OS notification from hook.js
  const action = await vscode.window.showInformationMessage(
    signal.event === 'stop'
      ? `Task completed in: ${signal.project}`
      : `Waiting for your response in: ${signal.project}`,
    'Focus Terminal'
  );

  if (action === 'Focus Terminal') {
    log.appendLine('User clicked Focus Terminal');
    await focusMatchingTerminal(signal.pids, log);
  }
}

function checkAllSignalFiles(log) {
  if (!vscode.workspace.workspaceFolders) return;

  for (const folder of vscode.workspace.workspaceFolders) {
    const signalPath = getSignalPath(folder.uri.fsPath);
    if (fs.existsSync(signalPath)) {
      log.appendLine(`Signal found on window focus: ${folder.name}`);
      handleSignal(signalPath, log);
      return;
    }
  }
}

// --- Terminal focusing ---

async function focusMatchingTerminal(pids, log) {
  const terminals = vscode.window.terminals;
  log.appendLine(`Open terminals (${terminals.length}): ${terminals.map(t => t.name).join(', ')}`);

  for (const terminal of terminals) {
    try {
      const termPid = await terminal.processId;
      if (termPid && pids.includes(termPid)) {
        log.appendLine(`PID match: "${terminal.name}" (PID ${termPid})`);
        await showTerminal(terminal, log);
        return;
      }
    } catch (_) {}
  }

  for (const terminal of terminals) {
    const name = terminal.name.toLowerCase();
    if (name.includes('claude') || name.includes('node')) {
      log.appendLine(`Name match: "${terminal.name}"`);
      await showTerminal(terminal, log);
      return;
    }
  }

  if (terminals.length > 0) {
    const lastTerminal = terminals[terminals.length - 1];
    log.appendLine(`Fallback: last terminal "${lastTerminal.name}"`);
    await showTerminal(lastTerminal, log);
    return;
  }

  log.appendLine('No terminals found to focus');
}

async function showTerminal(terminal, log) {
  await vscode.commands.executeCommand('workbench.action.terminal.focus');
  terminal.show();
  setTimeout(() => {
    const active = vscode.window.activeTerminal;
    log.appendLine(`Active terminal after switch: "${active?.name || 'none'}"`);
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

function updateStatusBar(item) {
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
  const status = checkHookStatus(context.extensionPath);

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
  // Run hook.js directly to test the full notification flow
  const hookPath = path.join(context.extensionPath, 'hook.js');
  const { execFile } = require('child_process');
  execFile('node', [hookPath], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir() },
    input: '{"hook_event_name":"Notification"}'
  }, (err) => {
    if (err) log.appendLine(`Test notification error: ${err.message}`);
    else log.appendLine('Test notification sent via hook.js');
  });
}

// --- First-run checks ---

async function runFirstRunChecks(context, log) {
  const config = vscode.workspace.getConfiguration('claudeNotifications');

  if (config.get('autoSetupHooks', true)) {
    const status = checkHookStatus(context.extensionPath);
    log.appendLine(`Hook status: ${status}`);

    if (status === 'not-installed' || status === 'no-file') {
      const choice = await vscode.window.showInformationMessage(
        'Claude Notifications: Set up Claude Code hooks for automatic notifications?',
        'Set Up Now', 'Later', "Don't Ask Again"
      );

      if (choice === 'Set Up Now') {
        await cmdSetupHooks(context, log);
      } else if (choice === "Don't Ask Again") {
        await config.update('autoSetupHooks', false, vscode.ConfigurationTarget.Global);
      }
    } else if (status === 'legacy') {
      const choice = await vscode.window.showInformationMessage(
        'Claude Notifications: You have legacy shell-script hooks. Upgrade to the new Node.js hooks for cross-platform support?',
        'Upgrade', 'Later', "Don't Ask Again"
      );

      if (choice === 'Upgrade') {
        await cmdSetupHooks(context, log);
      } else if (choice === "Don't Ask Again") {
        await config.update('autoSetupHooks', false, vscode.ConfigurationTarget.Global);
      }
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
