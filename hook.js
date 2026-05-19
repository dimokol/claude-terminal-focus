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
const { pathToFileURL } = require('node:url');
const { claimHandled, eventPriority } = require('./lib/signals');
const {
  getStateDir,
  getSignalPath,
  getClickedPath,
  getClaimedPath
} = require('./lib/state-paths');
const { shouldNotify: checkShouldNotify } = require('./lib/stage-dedup');
const { buildClickMarkerPayload } = require('./lib/click-marker');
const { readAiTitle } = require('./lib/transcript-title');
const { snapshot: processSnapshot, walkUp } = require('./lib/process-tree');

// Process names we consider "the interactive shell hosting Claude". The
// first ancestor matching one of these is recorded as signal.shellPid —
// the extension prefers it over the raw pid list when matching terminals.
const SHELL_PROCESS_NAMES = new Set([
  'bash.exe', 'sh.exe', 'zsh.exe', 'pwsh.exe', 'powershell.exe',
  'cmd.exe', 'fish.exe', 'wsl.exe',
  // POSIX (no .exe), as reported by `ps -o comm=`. Includes the
  // login-shell '-' prefix variants.
  'bash', '-bash', 'sh', '-sh', 'zsh', '-zsh', 'pwsh', 'powershell',
  'fish', '-fish'
]);

const CONFIG_FILE = 'claude-notifications-config.json';
const DEFAULT_HANDSHAKE_MS = 1200;

// Shell-escape a single argument (POSIX single-quote style).
function shEsc(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

(async () => {
  // --- 1. Read input ---

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = path.basename(projectDir);

  let hookEvent = 'waiting';
  let hookEventName = '';
  let hookMessage = '';
  let sessionId = '';
  let transcriptPath = '';
  try {
    const stdinData = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(stdinData);
    hookEventName = input.hook_event_name || '';
    hookMessage = typeof input.message === 'string' ? input.message : '';
    sessionId = input.session_id || '';
    transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
    const eventName = hookEventName.toLowerCase();
    if (eventName === 'stop') hookEvent = 'completed';
    else hookEvent = 'waiting'; // notification, permissionrequest, etc.
  } catch (_) {}

  // aiTitle: best-effort. Missing transcript / no ai-title record / parse
  // error → '', and we fall back to project-only notification text.
  const MAX_TITLE_LEN = 60; // macOS subtitle truncates around here; keep banners readable.
  let aiTitle = '';
  if (transcriptPath) {
    const raw = readAiTitle(transcriptPath);
    if (raw) {
      aiTitle = raw.length > MAX_TITLE_LEN ? raw.slice(0, MAX_TITLE_LEN - 1) + '…' : raw;
    }
  }

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
  // Walk up from projectDir looking for a .vscode/ folder as the marker of
  // a VS Code workspace. Stop at $HOME. If none found, use projectDir.
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  let workspaceRoot = projectDir;
  let searchDir = projectDir;
  while (searchDir !== path.dirname(searchDir)) {
    if (searchDir === homeDir) break;
    if (fs.existsSync(path.join(searchDir, '.vscode'))) {
      workspaceRoot = searchDir;
    }
    searchDir = path.dirname(searchDir);
  }

  // --- State directory (user-level, hashed per workspace) ---
  const stateDir = getStateDir(workspaceRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  const signalPath = getSignalPath(workspaceRoot);
  const claimPath = getClaimedPath(workspaceRoot);
  const clickedPath = getClickedPath(workspaceRoot);

  // --- Stage-ID dedup ---
  // Suppress re-fires of Stop/Notification for an already-notified,
  // unresolved stage. Stage advances on event-type change, on previous
  // stage being resolved (user ack), or on UserPromptSubmit (handled by
  // hook-user-prompt.js). See lib/stage-dedup.js for the full state machine.
  const dedup = checkShouldNotify(workspaceRoot, sessionId, hookEvent);
  if (!dedup.notify) {
    process.exit(0);
  }

  // --- 4. Build PID ancestor chain ---
  //
  // One process-tree snapshot, then a pure JS walk up from process.pid.
  // Previously we ran one `wmic`/`ps` subprocess per ancestor; on Windows
  // that was slow, silently broke (catch + break with no logging), and
  // `wmic` is being removed from modern Windows installs entirely.
  //
  // The walk also records process *names* so the extension can identify
  // which pid is the actual shell (bash.exe / pwsh.exe / cmd.exe / ...).
  // That's how we match terminals reliably for Git Bash, where
  // `terminal.processId` from VS Code is not in the ancestor chain
  // (MSYS2 fork model / launcher exits after spawning the real shell).

  const snap = processSnapshot();
  const chain = walkUp(snap, process.pid);
  const pids = chain.map(n => n.pid);
  const pidNames = {};
  for (const node of chain) {
    if (node.name) pidNames[String(node.pid)] = node.name;
  }
  // First ancestor whose process name looks like an interactive shell.
  // This is what the extension uses for primary terminal matching.
  // Names may arrive as a full path (POSIX `ps -o comm=` on macOS returns
  // '/bin/zsh') or as a bare executable (Windows: 'bash.exe'), so we
  // normalize to a lowercase basename before checking.
  let shellPid = 0;
  for (const node of chain) {
    if (!node.name) continue;
    const base = node.name.toLowerCase().replace(/^.*[/\\]/, '').replace(/^-/, '');
    if (SHELL_PROCESS_NAMES.has(base)) {
      shellPid = node.pid;
      break;
    }
  }

  // Diagnostics — Claude Code captures hook stderr to its hook log.
  // One line, terse, parseable. Surfaces when snapshot acquisition fails
  // (the most common cause of future Windows reports).
  try {
    const tip = chain.length > 0 ? chain[chain.length - 1] : null;
    const tipDesc = tip ? `pid=${tip.pid} name=${tip.name || '?'}` : 'empty-chain';
    process.stderr.write(
      `claude-notifications: chain depth=${chain.length} source=${snap.source} shellPid=${shellPid || 'none'} tip=${tipDesc}\n`
    );
  } catch (_) {}

  // --- 5. Write signal file ---
  // If another hook (for a concurrent event) already wrote a signal with a
  // higher-priority event, preserve it. This makes "waiting" (user action
  // required) win over "completed" (just-finished) when both fire together.
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
      hookEventName,
      hookMessage,
      sessionId,
      project: projectName,
      projectDir: projectDir,
      workspaceRoot: workspaceRoot,
      pids,
      pidNames,
      shellPid: shellPid || undefined,
      pidChainSource: snap.source,
      state: 'pending',
      aiTitle,
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
      // CRITICAL: every sound subprocess is launched detached + unref'd.
      // execFile(..., callback) keeps the parent alive until the child
      // closes its stdio, which on Windows meant PowerShell cold-start +
      // WPF MediaPlayer + WAV duration kept Claude Code's Stop hook
      // hanging for multiple seconds per message — and if PS hung at
      // the (since-fixed) NaturalDuration polling loop, it hung forever.
      // The hook MUST return control to Claude immediately; the sound
      // plays in its own detached process.
      try {
        if (process.platform === 'darwin') {
          const vol = (volume / 100).toFixed(3);
          const child = spawn('afplay', ['-v', vol, fileToPlay], {
            detached: true, stdio: 'ignore'
          });
          child.unref();
        } else if (process.platform === 'win32') {
          const fileUri = pathToFileURL(fileToPlay);
          const vol = (volume / 100).toFixed(3);
          const psCmd = `
            try {
              Add-Type -AssemblyName PresentationCore -ErrorAction Stop
              $p = New-Object System.Windows.Media.MediaPlayer
              $p.Open([System.Uri]'${fileUri}')
              $p.Volume = ${vol}
              $deadline = (Get-Date).AddSeconds(3)
              while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 20
              }
              if ($p.NaturalDuration.HasTimeSpan) {
                $ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150
              } else { $ms = 1500 }
              $p.Play()
              Start-Sleep -Milliseconds $ms
              $p.Close()
            } catch {
              try { (New-Object System.Media.SoundPlayer '${fileToPlay.replace(/'/g, "''")}').PlaySync() } catch {}
            }`.trim();
          const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
            detached: true, stdio: 'ignore', windowsHide: true
          });
          child.unref();
        } else {
          const paVol = String(Math.round((volume / 100) * 65536));
          const child = spawn('sh', ['-c', `paplay --volume=${paVol} '${fileToPlay.replace(/'/g, "'\\''")}' || aplay '${fileToPlay.replace(/'/g, "'\\''")}'`], {
            detached: true, stdio: 'ignore'
          });
          child.unref();
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
      // On click: write a JSON click-marker carrying THIS session's
      // pids/sessionId/event so the extension focuses the right terminal
      // even if a sibling session's hook has since overwritten the shared
      // signal file. Pre-v3.3.1 used an empty `touch` marker, which made
      // multi-session workspaces focus whichever session wrote the signal
      // file last instead of the one whose banner the user actually clicked.
      const clickPayload = buildClickMarkerPayload({
        sessionId, pids, shellPid, workspaceRoot, projectDir,
        event: hookEvent, project: projectName, aiTitle
      });
      const executeCmd = `/usr/bin/printf '%s' ${shEsc(clickPayload)} > ${shEsc(clickedPath)} && ${shEsc(codeCli)} ${shEsc(workspaceRoot)}`;
      const notifierArgs = [
        '-title', eventInfo.title,
        '-message', eventInfo.message,
        '-execute', executeCmd,
        '-group', `claude-${projectName}`,
      ];
      if (aiTitle) {
        notifierArgs.splice(2, 0, '-subtitle', aiTitle);
      }
      const child = spawn('terminal-notifier', notifierArgs, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (_) {
      try {
        const osaTitle = aiTitle
          ? `${eventInfo.title} — ${aiTitle.replace(/"/g, '\\"')}`
          : eventInfo.title;
        execSync(`osascript -e 'display notification "${eventInfo.message}" with title "${osaTitle}"'`, {
          timeout: 3000, stdio: 'ignore'
        });
      } catch (_) {}
    }
  } else if (process.platform === 'win32') {
    // Why this is convoluted: an inline `powershell -Command <script>` launched
    // via `spawn(..., {detached:true, stdio:'ignore'})` on Windows is *not*
    // truly orphaned — it stays inside the parent's job object. When Claude
    // Code's hook returns and tears down its process tree, the still-cold
    // PowerShell child can get killed before WinRT's
    // `ToastNotificationManager.CreateToastNotifier(...).Show(...)` finishes
    // registering the toast with the OS — sound has already fired (hook.js
    // owns that), but the banner never appears and the toast doesn't even
    // land in Action Center.
    //
    // The proven pattern (also what the v2 PS1 setup used) is:
    //   1. Drop the script to a temp .ps1 file.
    //   2. Launch via `cmd /c start "" /B powershell.exe -File <tmp>` —
    //      `start` allocates a fresh process group / detaches from the
    //      parent's job, so the toast survives the hook tearing down.
    //   3. End the script with a small `Start-Sleep` so the WinRT call has
    //      headroom to complete before the spawned PowerShell exits.
    //   4. Self-delete the temp file at the end of the script (own cleanup,
    //      no orphan files in %TEMP%).
    // Use our claude-notif:// URI handler instead of vscode://file/.
    // Three reasons:
    //   1. vscode://file/ triggers VS Code's
    //      `security.promptForLocalFileProtocolHandling` dialog every time
    //      (default true since 1.78) — "An external application wants to
    //      open ..." — even when the workspace is already loaded.
    //   2. vscode://file/<path> opens a NEW window for that path; it does
    //      not switch to an existing window that already has the workspace.
    //      Users with "empty VS Code + folders dragged in" multi-folder
    //      setups never get focused into their actual session.
    //   3. Our launcher writes the click marker before launching `code`,
    //      so the extension's existing handleClickedSignal flow runs and
    //      focuses the matching terminal — same UX as macOS.
    const { buildLaunchUri } = require('./lib/win-protocol');
    const launchUri = buildLaunchUri({
      sessionId, pids, shellPid, workspaceRoot, projectDir,
      event: hookEvent, project: projectName, aiTitle
    });
    const tmpScript = path.join(os.tmpdir(), `claude-notif-${Date.now()}-${process.pid}.ps1`);
    const titleLine = aiTitle ? `    <text>${xmlEsc(aiTitle)}</text>` : '';
    const psScriptBody = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast activationType="protocol" launch="${xmlEsc(launchUri)}" duration="long">
  <visual><binding template="ToastGeneric">
    <text>${xmlEsc(eventInfo.title)}</text>
${titleLine}
    <text>${xmlEsc(eventInfo.message)}</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Default" silent="true" />
</toast>
"@
try {
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($template)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.Shell.RunDialog").Show($toast)
  Start-Sleep -Milliseconds 250
} finally {
  Remove-Item -LiteralPath '${tmpScript.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue
}
`;
    try {
      // BOM so Windows PowerShell 5.1 reads the .ps1 as UTF-8 instead of
      // CP1252 — without it, the em-dash in titles becomes "â€"".
      fs.writeFileSync(tmpScript, '﻿' + psScriptBody, 'utf8');
      const child = spawn('cmd.exe', [
        '/c', 'start', '""', '/B',
        'powershell.exe',
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', tmpScript
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch (_) {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
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

  // CRITICAL: exit explicitly so Claude Code's hook handler returns
  // immediately. All side-effect subprocesses above are spawned with
  // detached + unref + stdio:'ignore', so they survive parent exit.
  // Without this, Node would drain the event loop and any subprocess
  // that's slow to release its handles (Windows PowerShell cold-start
  // is the worst offender) would block Claude for seconds-to-minutes.
  process.exit(0);
})();
