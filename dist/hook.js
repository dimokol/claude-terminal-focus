#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/signals.js
var require_signals = __commonJS({
  "lib/signals.js"(exports2, module2) {
    var fs2 = require("fs");
    var SIGNAL_VERSION = 2;
    var STALE_THRESHOLD_MS = 3e4;
    var CLAIM_STALE_MS = 5e3;
    var EVENT_PRIORITY = { completed: 1, waiting: 2 };
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
      SIGNAL_VERSION,
      STALE_THRESHOLD_MS,
      CLAIM_STALE_MS,
      claimHandled: claimHandled2,
      eventPriority: eventPriority2,
      normalizeEvent,
      parseSignal
    };
  }
});

// lib/state-paths.js
var require_state_paths = __commonJS({
  "lib/state-paths.js"(exports2, module2) {
    var crypto = require("crypto");
    var os2 = require("os");
    var path2 = require("path");
    var STATE_ROOT = path2.join(os2.homedir(), ".claude", "focus-state");
    function hashWorkspace(workspaceRoot) {
      return crypto.createHash("sha1").update(String(workspaceRoot)).digest("hex").slice(0, 12);
    }
    function getStateDir2(workspaceRoot) {
      return path2.join(STATE_ROOT, hashWorkspace(workspaceRoot));
    }
    function getSignalPath2(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "signal");
    }
    function getClickedPath2(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "clicked");
    }
    function getClaimedPath2(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "claimed");
    }
    function getSessionsPath(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "sessions");
    }
    module2.exports = {
      STATE_ROOT,
      hashWorkspace,
      getStateDir: getStateDir2,
      getSignalPath: getSignalPath2,
      getClickedPath: getClickedPath2,
      getClaimedPath: getClaimedPath2,
      getSessionsPath
    };
  }
});

// lib/stage-dedup.js
var require_stage_dedup = __commonJS({
  "lib/stage-dedup.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { getStateDir: getStateDir2, getSessionsPath } = require_state_paths();
    var SESSIONS_PRUNE_MS = 60 * 60 * 1e3;
    function ensureDir(workspaceRoot) {
      const dir = getStateDir2(workspaceRoot);
      fs2.mkdirSync(dir, { recursive: true });
      return dir;
    }
    function readSessions(workspaceRoot) {
      const p = getSessionsPath(workspaceRoot);
      try {
        const data = JSON.parse(fs2.readFileSync(p, "utf8"));
        return data && typeof data === "object" ? data : {};
      } catch (_) {
        return {};
      }
    }
    function writeSessions(workspaceRoot, map) {
      ensureDir(workspaceRoot);
      const now = Date.now();
      for (const key of Object.keys(map)) {
        const u = map[key] && map[key].updatedAt;
        if (typeof u === "number" && now - u > SESSIONS_PRUNE_MS) delete map[key];
      }
      try {
        fs2.writeFileSync(getSessionsPath(workspaceRoot), JSON.stringify(map));
      } catch (_) {
      }
    }
    function shouldNotify(workspaceRoot, sessionId, currentEvent) {
      if (!sessionId) return { notify: true, stageId: null };
      const map = readSessions(workspaceRoot);
      const now = Date.now();
      let entry = map[sessionId];
      if (!entry) {
        entry = { stageId: 1, lastEvent: currentEvent, resolved: false, lastNotifiedAt: now, updatedAt: now };
        map[sessionId] = entry;
        writeSessions(workspaceRoot, map);
        return { notify: true, stageId: 1 };
      }
      if (entry.lastEvent === null) {
        entry.lastEvent = currentEvent;
        entry.resolved = false;
        entry.lastNotifiedAt = now;
        entry.updatedAt = now;
        writeSessions(workspaceRoot, map);
        return { notify: true, stageId: entry.stageId };
      }
      if (entry.resolved === true) {
        entry.stageId = (entry.stageId || 0) + 1;
        entry.lastEvent = currentEvent;
        entry.resolved = false;
        entry.lastNotifiedAt = now;
        entry.updatedAt = now;
        writeSessions(workspaceRoot, map);
        return { notify: true, stageId: entry.stageId };
      }
      entry.lastEvent = currentEvent;
      entry.updatedAt = now;
      writeSessions(workspaceRoot, map);
      return { notify: false, stageId: entry.stageId };
    }
    function advanceOnPrompt(workspaceRoot, sessionId) {
      if (!sessionId) return;
      const map = readSessions(workspaceRoot);
      const now = Date.now();
      const entry = map[sessionId] || { stageId: 0, lastEvent: null, resolved: false, lastNotifiedAt: 0, updatedAt: now };
      entry.stageId = (entry.stageId || 0) + 1;
      entry.lastEvent = null;
      entry.resolved = false;
      entry.updatedAt = now;
      map[sessionId] = entry;
      writeSessions(workspaceRoot, map);
    }
    function markResolved(workspaceRoot, sessionId) {
      if (!sessionId) return;
      const map = readSessions(workspaceRoot);
      const entry = map[sessionId];
      if (!entry) return;
      entry.resolved = true;
      entry.updatedAt = Date.now();
      writeSessions(workspaceRoot, map);
    }
    module2.exports = {
      SESSIONS_PRUNE_MS,
      shouldNotify,
      advanceOnPrompt,
      markResolved,
      _readSessions: readSessions
    };
  }
});

// hook.js
var fs = require("fs");
var path = require("path");
var { execSync, execFile, spawn } = require("child_process");
var os = require("os");
var { setTimeout: sleep } = require("node:timers/promises");
var { claimHandled, eventPriority } = require_signals();
var {
  getStateDir,
  getSignalPath,
  getClickedPath,
  getClaimedPath
} = require_state_paths();
var { shouldNotify: checkShouldNotify } = require_stage_dedup();
var CONFIG_FILE = "claude-notifications-config.json";
var DEFAULT_HANDSHAKE_MS = 1200;
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
    if (fs.existsSync(path.join(searchDir, ".vscode"))) {
      workspaceRoot = searchDir;
    }
    searchDir = path.dirname(searchDir);
  }
  const stateDir = getStateDir(workspaceRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  const signalPath = getSignalPath(workspaceRoot);
  const claimPath = getClaimedPath(workspaceRoot);
  const clickedPath = getClickedPath(workspaceRoot);
  const dedup = checkShouldNotify(workspaceRoot, sessionId, hookEvent);
  if (!dedup.notify) {
    process.exit(0);
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
