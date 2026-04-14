#!/usr/bin/env node
// hook.js — Claude Code hook script (runs OUTSIDE VS Code)
// Called by Claude Code on Stop, Notification, and PermissionRequest events.
//
// Responsibilities (all happen outside VS Code for reliability):
// 1. Write JSON signal file (for terminal focusing by the extension)
// 2. Play sound (platform-native)
// 3. Show OS notification (platform-native, click opens correct VS Code window)

const fs = require('fs');
const path = require('path');
const { execSync, execFile, spawn } = require('child_process');
const os = require('os');

const SIGNAL_DIR = '.vscode';
const SIGNAL_FILE = '.claude-focus';
const CONFIG_FILE = 'claude-notifications-config.json';

// --- 1. Read input ---

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const projectName = path.basename(projectDir);

let hookEvent = 'notification';
try {
  const stdinData = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(stdinData);
  const eventName = (input.hook_event_name || '').toLowerCase();
  if (eventName === 'stop') hookEvent = 'stop';
  else if (eventName === 'notification') hookEvent = 'notification';
  else if (eventName === 'permissionrequest') hookEvent = 'permission';
  else hookEvent = 'notification';
} catch (_) {}

// --- 2. Read config (mute state, sound preferences) ---

const configPath = path.join(os.homedir(), '.claude', CONFIG_FILE);
let config = { muted: false, soundEnabled: true, volume: 0.5 };
try {
  if (fs.existsSync(configPath)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  }
} catch (_) {}

// If muted, write signal file (for terminal focus) but skip sound + notification
const isMuted = config.muted === true;

// --- 3. Find workspace root ---

const homeDir = process.env.HOME || process.env.USERPROFILE || '';
let workspaceRoot = projectDir;
let searchDir = projectDir;

while (searchDir !== path.dirname(searchDir)) {
  if (searchDir === homeDir) break;
  if (fs.existsSync(path.join(searchDir, SIGNAL_DIR))) {
    workspaceRoot = searchDir;
  }
  searchDir = path.dirname(searchDir);
}

const signalDirPath = path.join(workspaceRoot, SIGNAL_DIR);
if (!fs.existsSync(signalDirPath)) {
  fs.mkdirSync(signalDirPath, { recursive: true });
}

// --- 4. Build PID ancestor chain ---

function getPidChain() {
  const pids = [];
  let currentPid = process.pid;

  if (process.platform === 'win32') {
    while (currentPid && currentPid > 0) {
      pids.push(currentPid);
      try {
        const output = execSync(
          `wmic process where ProcessId=${currentPid} get ParentProcessId /value`,
          { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const match = output.match(/ParentProcessId=(\d+)/);
        if (!match) break;
        const parentPid = parseInt(match[1], 10);
        if (parentPid === currentPid || parentPid === 0) break;
        currentPid = parentPid;
      } catch (_) { break; }
    }
  } else {
    while (currentPid && currentPid > 1) {
      pids.push(currentPid);
      try {
        const output = execSync(`ps -o ppid= -p ${currentPid}`, {
          encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
        });
        const parentPid = parseInt(output.trim(), 10);
        if (isNaN(parentPid) || parentPid <= 0 || parentPid === currentPid) break;
        currentPid = parentPid;
      } catch (_) { break; }
    }
  }
  return pids;
}

// --- 5. Write signal file ---

const signal = {
  version: 2,
  event: hookEvent,
  project: projectName,
  projectDir: projectDir,
  workspaceRoot: workspaceRoot,
  pids: getPidChain(),
  timestamp: Date.now()
};

const signalPath = path.join(signalDirPath, SIGNAL_FILE);
fs.writeFileSync(signalPath, JSON.stringify(signal, null, 2));

// If muted, stop here — signal file written for terminal focus, but no sound/notification
if (isMuted) process.exit(0);

// --- 6. Play sound ---

const eventMessages = {
  stop: { title: 'Claude Code — Done', message: `Task completed in: ${projectName}`, sound: 'task-complete' },
  notification: { title: 'Claude Code', message: `Waiting for your response in: ${projectName}`, sound: 'notification' },
  permission: { title: 'Claude Code — Permission', message: `Permission needed in: ${projectName}`, sound: 'notification' }
};

const eventInfo = eventMessages[hookEvent] || eventMessages.notification;

if (config.soundEnabled !== false) {
  const extensionDir = path.dirname(__filename);
  const soundFile = path.join(extensionDir, 'sounds', `${eventInfo.sound}.wav`);

  if (fs.existsSync(soundFile)) {
    try {
      if (process.platform === 'darwin') {
        const vol = Math.round((config.volume || 0.5) * 255).toString();
        execFile('afplay', ['-v', vol, soundFile], () => {});
      } else if (process.platform === 'win32') {
        const psCmd = `(New-Object System.Media.SoundPlayer '${soundFile.replace(/'/g, "''")}').PlaySync()`;
        execFile('powershell', ['-NoProfile', '-Command', psCmd], () => {});
      } else {
        execFile('paplay', [soundFile], (err) => {
          if (err) execFile('aplay', [soundFile], () => {});
        });
      }
    } catch (_) {}
  }
}

// --- 7. Show OS notification ---
// Uses platform-native commands so it works regardless of VS Code focus state.
// Click action opens the correct VS Code window.

function findCodeCli() {
  const candidates = ['/usr/local/bin/code', '/opt/homebrew/bin/code'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return execSync('which code', { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (_) {
    return 'code';
  }
}

if (process.platform === 'darwin') {
  const codeCli = findCodeCli();
  // Try terminal-notifier first (supports click-to-open)
  try {
    execSync('command -v terminal-notifier', { stdio: 'ignore' });
    const child = spawn('terminal-notifier', [
      '-title', eventInfo.title,
      '-message', eventInfo.message,
      '-execute', `${codeCli} '${workspaceRoot}'`,
      '-group', `claude-${projectName}`,
      '-ignoreDnD'  // we don't set this — notification respects DND natively
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) {
    // Fallback: osascript (no click action, but always works)
    try {
      execSync(`osascript -e 'display notification "${eventInfo.message}" with title "${eventInfo.title}" sound name "default"'`, {
        timeout: 3000, stdio: 'ignore'
      });
    } catch (_) {}
  }
} else if (process.platform === 'win32') {
  // Windows: PowerShell toast notification
  const vscodePath = workspaceRoot.replace(/\\/g, '/');
  const vscodeUri = `vscode://file/${vscodePath}`;
  const psScript = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $template = @"
    <toast activationType="protocol" launch="${vscodeUri}" duration="long">
      <visual><binding template="ToastGeneric">
        <text>${eventInfo.title}</text>
        <text>${eventInfo.message}</text>
      </binding></visual>
      <audio src="ms-winsoundevent:Notification.Default" silent="true" />
    </toast>
"@
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.Shell.RunDialog").Show($toast)
  `;
  const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript], {
    detached: true, stdio: 'ignore'
  });
  child.unref();
} else {
  // Linux: notify-send
  try {
    const child = spawn('notify-send', [
      eventInfo.title, eventInfo.message,
      '--app-name=Claude Code',
      '--expire-time=15000'
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) {}
}
