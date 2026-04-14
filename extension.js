// extension.js — Claude Notifications v2.0
const vscode = require('vscode');
const fs = require('fs');
const { getSignalPath, getClickedPath, parseSignal } = require('./lib/signals');
const { showNotification, isNativeNotificationsEnabled } = require('./lib/notifications');
const { playSound } = require('./lib/sounds');
const { checkHookStatus, installHooks, uninstallHooks } = require('./lib/hooks-installer');
const { checkGitignoreStatus, setupGitignore } = require('./lib/gitignore-setup');

const POLL_MS = 800;

function activate(context) {
  const log = vscode.window.createOutputChannel('Claude Notifications');
  log.appendLine('Claude Notifications v2.0 activated');
  log.appendLine(`Workspace folders: ${(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).join(', ') || 'none'}`);

  // --- Register commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNotifications.setupHooks', () => cmdSetupHooks(context, log)),
    vscode.commands.registerCommand('claudeNotifications.removeHooks', () => cmdRemoveHooks(log)),
    vscode.commands.registerCommand('claudeNotifications.setupGitignore', () => cmdSetupGitignore(log)),
    vscode.commands.registerCommand('claudeNotifications.testNotification', () => cmdTestNotification(log))
  );

  // --- Signal file watcher (polling) ---

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

  // --- Window focus handler (Windows toast support) ---

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

  // Delete signal file immediately to prevent re-processing
  try { fs.unlinkSync(signalPath); } catch (_) {}

  const signal = parseSignal(content);
  if (!signal) {
    log.appendLine('Signal file was empty or stale — ignoring');
    return;
  }

  log.appendLine(`Signal: event=${signal.event}, project=${signal.project}, pids=[${signal.pids.join(',')}], version=${signal.version}`);

  // Play sound
  const config = vscode.workspace.getConfiguration('claudeNotifications');
  if (config.get('sound.enabled', true)) {
    const volume = config.get('sound.volume', 0.5);
    const soundName = signal.event === 'stop' ? 'task-complete' : 'notification';
    playSound(soundName, volume);
  }

  // Show notification
  const action = await showNotification(signal, log);

  if (action === 'focus') {
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

  // Try matching by PID
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

  // Try matching by name
  for (const terminal of terminals) {
    const name = terminal.name.toLowerCase();
    if (name.includes('claude') || name.includes('node')) {
      log.appendLine(`Name match: "${terminal.name}"`);
      await showTerminal(terminal, log);
      return;
    }
  }

  // Fallback: last terminal
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

    // Also check gitignore
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

async function cmdTestNotification(log) {
  const testSignal = {
    version: 2,
    event: 'notification',
    project: 'Test Project',
    projectDir: '',
    pids: [],
    timestamp: Date.now()
  };

  const config = vscode.workspace.getConfiguration('claudeNotifications');
  if (config.get('sound.enabled', true)) {
    playSound('notification', config.get('sound.volume', 0.5));
  }

  await showNotification(testSignal, log);
  log.appendLine('Test notification sent');
}

// --- First-run checks ---

async function runFirstRunChecks(context, log) {
  const config = vscode.workspace.getConfiguration('claudeNotifications');

  // Check 1: Are hooks installed?
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

  // Check 2: Native notifications
  const nativeEnabled = isNativeNotificationsEnabled();
  if (nativeEnabled === false) {
    const choice = await vscode.window.showInformationMessage(
      'Claude Notifications: VS Code native notifications are disabled. Enable them for OS-level alerts when VS Code is in the background?',
      'Open Settings', 'Use Fallback Only', 'Dismiss'
    );

    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'window.nativeNotifications');
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
