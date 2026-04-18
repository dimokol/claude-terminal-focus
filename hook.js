#!/usr/bin/env node
// hook.js — Claude Code hook script (runs OUTSIDE VS Code)
// Called by Claude Code on Stop, Notification, and PermissionRequest events.
//
// Flow:
// 1. Write JSON signal file (.vscode/.claude-focus) with state=pending
// 2. Sleep HANDSHAKE_MS (1200ms) — give the extension time to claim
// 3. Atomically try to claim the handled-marker:
//    - If the extension already claimed it: exit silently (ext handled).
//    - If a sibling hook (different event, fired near-simultaneously)
//      already claimed it: exit silently — a single notification already
//      covers this Claude "turn".
// 4. Mark the signal as fired (so the extension, if it later polls after
//    the user returns to VS Code, ignores this signal instead of firing a
//    duplicate toast).
// 5. Fire OS banner + play sound (fallback).

const fs = require('fs');
const path = require('path');
const { execSync, execFile, spawn } = require('child_process');
const os = require('os');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  SIGNAL_DIR,
  SIGNAL_FILE,
  CLICKED_FILE,
  CLAIMED_FILE,
  claimHandled,
  eventPriority
} = require('./lib/signals');

const CONFIG_FILE = 'claude-notifications-config.json';
const DEFAULT_HANDSHAKE_MS = 1200;

// Shell-escape a single argument (POSIX single-quote style).
function shEsc(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

(async () => {
  // --- 1. Read input ---

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = path.basename(projectDir);

  let hookEvent = 'waiting';
  try {
    const stdinData = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(stdinData);
    const eventName = (input.hook_event_name || '').toLowerCase();
    if (eventName === 'stop') hookEvent = 'completed';
    else hookEvent = 'waiting'; // notification, permissionrequest, etc.
  } catch (_) {}

  // --- 2. Read config (mute state, sound/event preferences) ---

  const configPath = path.join(os.homedir(), '.claude', CONFIG_FILE);
  let config = { muted: false, soundEnabled: true, volume: 0.5 };
  try {
    if (fs.existsSync(configPath)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    }
  } catch (_) {}

  // Backwards compat: old flat config → new nested config
  if (config.soundEnabled !== undefined && !config.sounds) {
    config.sounds = { volume: Math.round((config.volume || 0.5) * 100) };
    config.events = {};
  }

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

  const signalPath = path.join(signalDirPath, SIGNAL_FILE);
  const claimPath = path.join(signalDirPath, CLAIMED_FILE);
  const clickedPath = path.join(signalDirPath, CLICKED_FILE);

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
  // If another hook (for a concurrent event) already wrote a signal with a
  // higher-priority event, preserve it. This makes "waiting" (user action
  // required) win over "completed" (just-finished) when both fire together.

  const pids = getPidChain();
  let shouldWriteSignal = true;
  try {
    const existing = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    if (
      existing.timestamp &&
      Date.now() - existing.timestamp < DEFAULT_HANDSHAKE_MS + 1000 &&
      eventPriority(existing.event) > eventPriority(hookEvent)
    ) {
      shouldWriteSignal = false;
    }
  } catch (_) {}

  if (shouldWriteSignal) {
    const signalPayload = {
      version: 2,
      event: hookEvent,
      project: projectName,
      projectDir: projectDir,
      workspaceRoot: workspaceRoot,
      pids,
      state: 'pending',
      timestamp: Date.now()
    };
    fs.writeFileSync(signalPath, JSON.stringify(signalPayload, null, 2));
  }

  // If muted, the signal file is written (useful for Focus Terminal if
  // the user opens VS Code and chooses to engage) but skip the rest.
  if (isMuted) process.exit(0);

  // --- 6. Per-event settings ---

  const eventConfig = (config.events && config.events[hookEvent]) || 'Sound + Notification';
  if (eventConfig === 'Nothing') process.exit(0);

  const shouldPlaySound = eventConfig === 'Sound + Notification' || eventConfig === 'Sound only';
  const shouldNotify = eventConfig === 'Sound + Notification' || eventConfig === 'Notification only';

  const eventMessages = {
    completed: { title: 'Claude Code — Done', message: `Task completed in: ${projectName}`, sound: 'task-complete' },
    waiting: { title: 'Claude Code', message: `Waiting for your response in: ${projectName}`, sound: 'notification' }
  };
  const eventInfo = eventMessages[hookEvent] || eventMessages.waiting;

  // --- 7. Handshake: wait for extension to claim ---

  const handshakeMs = config.handshakeMs || DEFAULT_HANDSHAKE_MS;
  await sleep(handshakeMs);

  // Priority defer: if the signal on disk now reflects a higher-priority
  // event from a sibling hook, let that hook fire instead.
  try {
    const onDisk = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    if (onDisk.event && eventPriority(onDisk.event) > eventPriority(hookEvent)) {
      process.exit(0);
    }
  } catch (_) {
    // Signal deleted — extension claimed. Exit silently.
    process.exit(0);
  }

  // Atomically claim the right to fire. Either the extension already
  // claimed it (during the handshake) or a sibling hook.js did — in either
  // case we exit silently so the user sees exactly one notification.
  if (!claimHandled(claimPath)) {
    process.exit(0);
  }

  // Mark the signal as fired so if the user later focuses VS Code, the
  // extension's polling loop ignores this signal instead of firing a
  // duplicate in-window toast. The signal file is kept (not deleted) so
  // the click-to-focus flow can still read the PIDs.
  try {
    const onDisk = JSON.parse(fs.readFileSync(signalPath, 'utf8'));
    onDisk.state = 'fired';
    fs.writeFileSync(signalPath, JSON.stringify(onDisk, null, 2));
  } catch (_) {}

  // --- 8. Fallback: fire OS banner + sound ---

  // Play sound. See lib/sounds.js for the volume-mapping rationale:
  // 0–100 → 0.0–1.0 amplitude multiplier (not 0–255). afplay -v above
  // ~1.0 clips hard, which was the root cause of the v3.0 loudness bug.
  if (shouldPlaySound) {
    const soundPath = config.sounds && config.sounds[hookEvent];
    const rawVolume = (config.sounds && config.sounds.volume != null) ? config.sounds.volume : 50;
    const volume = Math.max(0, Math.min(100, Number(rawVolume) || 0));
    const fileToPlay = soundPath || path.join(path.dirname(__filename), 'sounds', `${eventInfo.sound}.wav`);

    if (volume > 0 && fs.existsSync(fileToPlay)) {
      try {
        if (process.platform === 'darwin') {
          const vol = (volume / 100).toFixed(3);
          execFile('afplay', ['-v', vol, fileToPlay], () => {});
        } else if (process.platform === 'win32') {
          const esc = fileToPlay.replace(/'/g, "''");
          const vol = (volume / 100).toFixed(3);
          const psCmd = `
            try {
              Add-Type -AssemblyName PresentationCore -ErrorAction Stop
              $p = New-Object System.Windows.Media.MediaPlayer
              $p.Open([System.Uri]::new('${esc}', [System.UriKind]::Absolute))
              $p.Volume = ${vol}
              while (-not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 20 }
              $ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150
              $p.Play()
              Start-Sleep -Milliseconds $ms
              $p.Close()
            } catch {
              (New-Object System.Media.SoundPlayer '${esc}').PlaySync()
            }`.trim();
          execFile('powershell', ['-NoProfile', '-Command', psCmd], () => {});
        } else {
          const paVol = String(Math.round((volume / 100) * 65536));
          execFile('paplay', ['--volume', paVol, fileToPlay], (err) => {
            if (err) execFile('aplay', [fileToPlay], () => {});
          });
        }
      } catch (_) {}
    }
  }

  // Show OS notification
  if (!shouldNotify) process.exit(0);

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
    try {
      execSync('command -v terminal-notifier', { stdio: 'ignore' });
      // On click: drop a "clicked" marker (so the extension knows to focus
      // the terminal without showing an extra in-window toast) then open
      // the workspace.
      const executeCmd = `/usr/bin/touch ${shEsc(clickedPath)} && ${shEsc(codeCli)} ${shEsc(workspaceRoot)}`;
      const child = spawn('terminal-notifier', [
        '-title', eventInfo.title,
        '-message', eventInfo.message,
        '-execute', executeCmd,
        '-group', `claude-${projectName}`,
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (_) {
      try {
        execSync(`osascript -e 'display notification "${eventInfo.message}" with title "${eventInfo.title}"'`, {
          timeout: 3000, stdio: 'ignore'
        });
      } catch (_) {}
    }
  } else if (process.platform === 'win32') {
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
    try {
      const child = spawn('notify-send', [
        eventInfo.title, eventInfo.message,
        '--app-name=Claude Code',
        '--expire-time=15000'
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (_) {}
  }
})();
