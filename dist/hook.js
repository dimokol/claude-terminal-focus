#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/signals.js
var require_signals = __commonJS({
  "lib/signals.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var SIGNAL_DIR2 = ".vscode";
    var SIGNAL_FILE2 = ".claude-focus";
    var CLICKED_FILE2 = ".claude-focus-clicked";
    var CLAIMED_FILE2 = ".claude-focus-claimed";
    var SIGNAL_VERSION = 2;
    var STALE_THRESHOLD_MS = 3e4;
    var CLAIM_STALE_MS = 5e3;
    var EVENT_PRIORITY = { completed: 1, waiting: 2 };
    function getSignalPath(workspaceRoot) {
      return path2.join(workspaceRoot, SIGNAL_DIR2, SIGNAL_FILE2);
    }
    function getClickedPath(workspaceRoot) {
      return path2.join(workspaceRoot, SIGNAL_DIR2, CLICKED_FILE2);
    }
    function getClaimedPath(workspaceRoot) {
      return path2.join(workspaceRoot, SIGNAL_DIR2, CLAIMED_FILE2);
    }
    function eventPriority2(event) {
      return EVENT_PRIORITY[event] || 0;
    }
    function normalizeEvent(event) {
      if (event === "completed") return "completed";
      if (event === "stop") return "completed";
      return "waiting";
    }
    function claimHandled2(handledPath, staleMs = CLAIM_STALE_MS) {
      try {
        fs2.writeFileSync(handledPath, String(Date.now()), { flag: "wx" });
        return true;
      } catch (err) {
        if (err.code !== "EEXIST") return false;
      }
      try {
        const stat = fs2.statSync(handledPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs2.unlinkSync(handledPath);
          fs2.writeFileSync(handledPath, String(Date.now()), { flag: "wx" });
          return true;
        }
      } catch (_) {
      }
      return false;
    }
    function parseSignal(content) {
      const trimmed = content.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith("{")) {
        try {
          const data = JSON.parse(trimmed);
          if (data.version === 2) {
            if (data.timestamp && Date.now() - data.timestamp > STALE_THRESHOLD_MS) {
              return null;
            }
            return {
              version: 2,
              event: normalizeEvent(data.event || "notification"),
              hookEventName: typeof data.hookEventName === "string" ? data.hookEventName : "",
              hookMessage: typeof data.hookMessage === "string" ? data.hookMessage : "",
              sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
              project: data.project || "Unknown",
              projectDir: data.projectDir || "",
              pids: Array.isArray(data.pids) ? data.pids : [],
              state: data.state === "fired" ? "fired" : "pending",
              timestamp: data.timestamp || Date.now()
            };
          }
        } catch (_) {
        }
      }
      const pids = trimmed.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
      return {
        version: 1,
        event: "waiting",
        hookEventName: "",
        hookMessage: "",
        sessionId: "",
        project: "Claude Code",
        projectDir: "",
        pids,
        state: "pending",
        timestamp: Date.now()
      };
    }
    module2.exports = {
      SIGNAL_DIR: SIGNAL_DIR2,
      SIGNAL_FILE: SIGNAL_FILE2,
      CLICKED_FILE: CLICKED_FILE2,
      CLAIMED_FILE: CLAIMED_FILE2,
      SIGNAL_VERSION,
      STALE_THRESHOLD_MS,
      CLAIM_STALE_MS,
      getSignalPath,
      getClickedPath,
      getClaimedPath,
      claimHandled: claimHandled2,
      eventPriority: eventPriority2,
      normalizeEvent,
      parseSignal
    };
  }
});

// hook.js
var fs = require("fs");
var path = require("path");
var { execSync, execFile, spawn } = require("child_process");
var os = require("os");
var { setTimeout: sleep } = require("node:timers/promises");
var {
  SIGNAL_DIR,
  SIGNAL_FILE,
  CLICKED_FILE,
  CLAIMED_FILE,
  claimHandled,
  eventPriority
} = require_signals();
var CONFIG_FILE = "claude-notifications-config.json";
var DEFAULT_HANDSHAKE_MS = 1200;
var SESSIONS_FILE = ".claude-focus-sessions";
var SESSION_DEDUP_MS = 5 * 1e3;
var SESSIONS_PRUNE_MS = 60 * 60 * 1e3;
function shEsc(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
(async () => {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = path.basename(projectDir);
  let hookEvent = "waiting";
  let hookEventName = "";
  let hookMessage = "";
  let sessionId = "";
  try {
    const stdinData = fs.readFileSync(0, "utf8");
    const input = JSON.parse(stdinData);
    hookEventName = input.hook_event_name || "";
    hookMessage = typeof input.message === "string" ? input.message : "";
    sessionId = input.session_id || "";
    const eventName = hookEventName.toLowerCase();
    if (eventName === "stop") hookEvent = "completed";
    else hookEvent = "waiting";
  } catch (_) {
  }
  const configPath = path.join(os.homedir(), ".claude", CONFIG_FILE);
  let config = { muted: false, soundEnabled: true, volume: 0.5 };
  try {
    if (fs.existsSync(configPath)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
    }
  } catch (_) {
  }
  if (config.soundEnabled !== void 0 && !config.sounds) {
    config.sounds = { volume: Math.round((config.volume || 0.5) * 100) };
    config.events = {};
  }
  const isMuted = config.muted === true;
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
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
  const sessionsPath = path.join(signalDirPath, SESSIONS_FILE);
  function readSessions() {
    try {
      const data = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch (_) {
      return {};
    }
  }
  function writeSessions(map) {
    const now = Date.now();
    for (const key of Object.keys(map)) {
      if (now - map[key] > SESSIONS_PRUNE_MS) delete map[key];
    }
    try {
      fs.writeFileSync(sessionsPath, JSON.stringify(map));
    } catch (_) {
    }
  }
  if (sessionId) {
    const sessions = readSessions();
    const lastNotified = sessions[sessionId];
    const now = Date.now();
    if (lastNotified && now - lastNotified < SESSION_DEDUP_MS) {
      process.exit(0);
    }
    sessions[sessionId] = now;
    writeSessions(sessions);
  }
  function getPidChain() {
    const pids2 = [];
    let currentPid = process.pid;
    if (process.platform === "win32") {
      while (currentPid && currentPid > 0) {
        pids2.push(currentPid);
        try {
          const output = execSync(
            `wmic process where ProcessId=${currentPid} get ParentProcessId /value`,
            { encoding: "utf8", timeout: 2e3, stdio: ["pipe", "pipe", "pipe"] }
          );
          const match = output.match(/ParentProcessId=(\d+)/);
          if (!match) break;
          const parentPid = parseInt(match[1], 10);
          if (parentPid === currentPid || parentPid === 0) break;
          currentPid = parentPid;
        } catch (_) {
          break;
        }
      }
    } else {
      while (currentPid && currentPid > 1) {
        pids2.push(currentPid);
        try {
          const output = execSync(`ps -o ppid= -p ${currentPid}`, {
            encoding: "utf8",
            timeout: 2e3,
            stdio: ["pipe", "pipe", "pipe"]
          });
          const parentPid = parseInt(output.trim(), 10);
          if (isNaN(parentPid) || parentPid <= 0 || parentPid === currentPid) break;
          currentPid = parentPid;
        } catch (_) {
          break;
        }
      }
    }
    return pids2;
  }
  const pids = getPidChain();
  let shouldWriteSignal = true;
  try {
    const existing = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    if (existing.timestamp && Date.now() - existing.timestamp < DEFAULT_HANDSHAKE_MS + 1e3 && eventPriority(existing.event) > eventPriority(hookEvent)) {
      shouldWriteSignal = false;
    }
  } catch (_) {
  }
  if (shouldWriteSignal) {
    const signalPayload = {
      version: 2,
      event: hookEvent,
      hookEventName,
      hookMessage,
      sessionId,
      project: projectName,
      projectDir,
      workspaceRoot,
      pids,
      state: "pending",
      timestamp: Date.now()
    };
    fs.writeFileSync(signalPath, JSON.stringify(signalPayload, null, 2));
  }
  if (isMuted) process.exit(0);
  const eventConfig = config.events && config.events[hookEvent] || "Sound + Notification";
  if (eventConfig === "Nothing") process.exit(0);
  const shouldPlaySound = eventConfig === "Sound + Notification" || eventConfig === "Sound only";
  const shouldNotify = eventConfig === "Sound + Notification" || eventConfig === "Notification only";
  const eventMessages = {
    completed: { title: "Claude Code \u2014 Done", message: `Task completed in: ${projectName}`, sound: "task-complete" },
    waiting: { title: "Claude Code", message: `Waiting for your response in: ${projectName}`, sound: "notification" }
  };
  const eventInfo = eventMessages[hookEvent] || eventMessages.waiting;
  const handshakeMs = config.handshakeMs || DEFAULT_HANDSHAKE_MS;
  await sleep(handshakeMs);
  try {
    const onDisk = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    if (onDisk.event && eventPriority(onDisk.event) > eventPriority(hookEvent)) {
      process.exit(0);
    }
  } catch (_) {
    process.exit(0);
  }
  if (!claimHandled(claimPath)) {
    process.exit(0);
  }
  try {
    const onDisk = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    onDisk.state = "fired";
    fs.writeFileSync(signalPath, JSON.stringify(onDisk, null, 2));
  } catch (_) {
  }
  if (shouldPlaySound) {
    const soundPath = config.sounds && config.sounds[hookEvent];
    const rawVolume = config.sounds && config.sounds.volume != null ? config.sounds.volume : 50;
    const volume = Math.max(0, Math.min(100, Number(rawVolume) || 0));
    const fileToPlay = soundPath || path.join(path.dirname(__filename), "sounds", `${eventInfo.sound}.wav`);
    if (volume > 0 && fs.existsSync(fileToPlay)) {
      try {
        if (process.platform === "darwin") {
          const vol = (volume / 100).toFixed(3);
          execFile("afplay", ["-v", vol, fileToPlay], () => {
          });
        } else if (process.platform === "win32") {
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
          execFile("powershell", ["-NoProfile", "-Command", psCmd], () => {
          });
        } else {
          const paVol = String(Math.round(volume / 100 * 65536));
          execFile("paplay", ["--volume", paVol, fileToPlay], (err) => {
            if (err) execFile("aplay", [fileToPlay], () => {
            });
          });
        }
      } catch (_) {
      }
    }
  }
  if (!shouldNotify) process.exit(0);
  function findCodeCli() {
    const candidates = ["/usr/local/bin/code", "/opt/homebrew/bin/code"];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      return execSync("which code", { encoding: "utf8", timeout: 2e3 }).trim();
    } catch (_) {
      return "code";
    }
  }
  if (process.platform === "darwin") {
    const codeCli = findCodeCli();
    try {
      execSync("command -v terminal-notifier", { stdio: "ignore" });
      const executeCmd = `/usr/bin/touch ${shEsc(clickedPath)} && ${shEsc(codeCli)} ${shEsc(workspaceRoot)}`;
      const child = spawn("terminal-notifier", [
        "-title",
        eventInfo.title,
        "-message",
        eventInfo.message,
        "-execute",
        executeCmd,
        "-group",
        `claude-${projectName}`
      ], { detached: true, stdio: "ignore" });
      child.unref();
    } catch (_) {
      try {
        execSync(`osascript -e 'display notification "${eventInfo.message}" with title "${eventInfo.title}"'`, {
          timeout: 3e3,
          stdio: "ignore"
        });
      } catch (_2) {
      }
    }
  } else if (process.platform === "win32") {
    const vscodePath = workspaceRoot.replace(/\\/g, "/");
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
    const child = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psScript], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } else {
    try {
      const child = spawn("notify-send", [
        eventInfo.title,
        eventInfo.message,
        "--app-name=Claude Code",
        "--expire-time=15000"
      ], { detached: true, stdio: "ignore" });
      child.unref();
    } catch (_) {
    }
  }
})();
