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
      let stat;
      try {
        stat = fs2.statSync(handledPath);
      } catch (_) {
        try {
          fs2.writeFileSync(handledPath, String(Date.now()), { flag: "wx" });
          return true;
        } catch (_2) {
          return false;
        }
      }
      if (Date.now() - stat.mtimeMs <= staleMs) return false;
      try {
        fs2.unlinkSync(handledPath);
      } catch (_) {
        return false;
      }
      try {
        fs2.writeFileSync(handledPath, String(Date.now()), { flag: "wx" });
        return true;
      } catch (_) {
        return false;
      }
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
              workspaceRoot: typeof data.workspaceRoot === "string" ? data.workspaceRoot : "",
              pids: Array.isArray(data.pids) ? data.pids : [],
              pidNames: data.pidNames && typeof data.pidNames === "object" ? data.pidNames : {},
              shellPid: Number.isInteger(data.shellPid) && data.shellPid > 0 ? data.shellPid : 0,
              pidChainSource: typeof data.pidChainSource === "string" ? data.pidChainSource : "",
              state: data.state === "fired" ? "fired" : "pending",
              aiTitle: typeof data.aiTitle === "string" ? data.aiTitle : "",
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
        workspaceRoot: "",
        pids,
        pidNames: {},
        shellPid: 0,
        pidChainSource: "",
        state: "pending",
        aiTitle: "",
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
    function normalizeWorkspaceRoot(workspaceRoot) {
      let s = String(workspaceRoot).replace(/\\/g, "/");
      if (process.platform === "win32") {
        s = s.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ":");
      }
      if (s.length > 1 && s.endsWith("/") && !s.endsWith(":/")) {
        s = s.slice(0, -1);
      }
      return s;
    }
    function hashWorkspace(workspaceRoot) {
      return crypto.createHash("sha1").update(normalizeWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 12);
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
      normalizeWorkspaceRoot,
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
    var STAGE_ESCAPE_VALVE_MS = 3e3;
    var PR_NOTIFICATION_BURST_MS = 3e4;
    var LOCK_WAIT_MS = 1e3;
    var LOCK_SLEEP_MS = 5;
    var LOCK_STALE_MS = 2e3;
    function ensureDir(workspaceRoot) {
      const dir = getStateDir2(workspaceRoot);
      fs2.mkdirSync(dir, { recursive: true });
      return dir;
    }
    function sleepSync(ms) {
      try {
        const sab = new SharedArrayBuffer(4);
        const view = new Int32Array(sab);
        Atomics.wait(view, 0, 0, ms);
      } catch (_) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
        }
      }
    }
    function acquireLock(workspaceRoot) {
      const dir = ensureDir(workspaceRoot);
      const lockPath = path2.join(dir, "dedup.lock");
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        try {
          fs2.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
          return lockPath;
        } catch (err) {
          if (err.code !== "EEXIST") return null;
        }
        try {
          const stat = fs2.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            try {
              fs2.unlinkSync(lockPath);
            } catch (_) {
            }
            continue;
          }
        } catch (_) {
          continue;
        }
        sleepSync(LOCK_SLEEP_MS);
      }
      return null;
    }
    function releaseLock(lockPath) {
      if (!lockPath) return;
      try {
        fs2.unlinkSync(lockPath);
      } catch (_) {
      }
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
      const finalPath = getSessionsPath(workspaceRoot);
      const tmpPath = finalPath + ".tmp." + process.pid + "." + now;
      try {
        fs2.writeFileSync(tmpPath, JSON.stringify(map));
        fs2.renameSync(tmpPath, finalPath);
      } catch (_) {
        try {
          fs2.unlinkSync(tmpPath);
        } catch (_2) {
        }
      }
    }
    function shouldNotify(workspaceRoot, sessionId, currentEvent, currentHookEventName) {
      if (!sessionId) return { notify: true, stageId: null };
      const lock = acquireLock(workspaceRoot);
      try {
        const map = readSessions(workspaceRoot);
        const now = Date.now();
        let entry = map[sessionId];
        if (!entry) {
          entry = {
            stageId: 1,
            lastEvent: currentEvent,
            lastHookEventName: currentHookEventName || null,
            resolved: false,
            lastNotifiedAt: now,
            updatedAt: now
          };
          map[sessionId] = entry;
          writeSessions(workspaceRoot, map);
          return { notify: true, stageId: 1 };
        }
        const lastHook = entry.lastHookEventName;
        if ((lastHook === "PermissionRequest" || lastHook === "PreToolUse") && currentHookEventName === "Notification" && now - (entry.lastNotifiedAt || 0) < PR_NOTIFICATION_BURST_MS) {
          entry.lastEvent = currentEvent;
          entry.lastHookEventName = currentHookEventName;
          entry.updatedAt = now;
          writeSessions(workspaceRoot, map);
          return { notify: false, stageId: entry.stageId };
        }
        if (entry.lastEvent === null) {
          entry.lastEvent = currentEvent;
          entry.lastHookEventName = currentHookEventName || null;
          entry.resolved = false;
          entry.lastNotifiedAt = now;
          entry.updatedAt = now;
          writeSessions(workspaceRoot, map);
          return { notify: true, stageId: entry.stageId };
        }
        if (entry.resolved === true) {
          const lastAt2 = entry.lastNotifiedAt || 0;
          if (now - lastAt2 < STAGE_ESCAPE_VALVE_MS) {
            entry.lastEvent = currentEvent;
            entry.lastHookEventName = currentHookEventName || entry.lastHookEventName || null;
            entry.updatedAt = now;
            writeSessions(workspaceRoot, map);
            return { notify: false, stageId: entry.stageId };
          }
          entry.stageId = (entry.stageId || 0) + 1;
          entry.lastEvent = currentEvent;
          entry.lastHookEventName = currentHookEventName || null;
          entry.resolved = false;
          entry.lastNotifiedAt = now;
          entry.updatedAt = now;
          writeSessions(workspaceRoot, map);
          return { notify: true, stageId: entry.stageId };
        }
        const lastAt = entry.lastNotifiedAt || 0;
        if (now - lastAt > STAGE_ESCAPE_VALVE_MS) {
          entry.stageId = (entry.stageId || 0) + 1;
          entry.lastEvent = currentEvent;
          entry.lastHookEventName = currentHookEventName || null;
          entry.resolved = false;
          entry.lastNotifiedAt = now;
          entry.updatedAt = now;
          writeSessions(workspaceRoot, map);
          return { notify: true, stageId: entry.stageId };
        }
        entry.lastEvent = currentEvent;
        entry.lastHookEventName = currentHookEventName || entry.lastHookEventName || null;
        entry.updatedAt = now;
        writeSessions(workspaceRoot, map);
        return { notify: false, stageId: entry.stageId };
      } finally {
        releaseLock(lock);
      }
    }
    function advanceOnPrompt(workspaceRoot, sessionId) {
      if (!sessionId) return;
      const lock = acquireLock(workspaceRoot);
      try {
        const map = readSessions(workspaceRoot);
        const now = Date.now();
        const entry = map[sessionId] || { stageId: 0, lastEvent: null, lastHookEventName: null, resolved: false, lastNotifiedAt: 0, updatedAt: now };
        entry.stageId = (entry.stageId || 0) + 1;
        entry.lastEvent = null;
        entry.lastHookEventName = null;
        entry.resolved = false;
        entry.updatedAt = now;
        map[sessionId] = entry;
        writeSessions(workspaceRoot, map);
      } finally {
        releaseLock(lock);
      }
    }
    function markResolved(workspaceRoot, sessionId) {
      if (!sessionId) return;
      const lock = acquireLock(workspaceRoot);
      try {
        const map = readSessions(workspaceRoot);
        const entry = map[sessionId];
        if (!entry) return;
        entry.resolved = true;
        entry.updatedAt = Date.now();
        writeSessions(workspaceRoot, map);
      } finally {
        releaseLock(lock);
      }
    }
    module2.exports = {
      SESSIONS_PRUNE_MS,
      STAGE_ESCAPE_VALVE_MS,
      PR_NOTIFICATION_BURST_MS,
      LOCK_WAIT_MS,
      LOCK_STALE_MS,
      shouldNotify,
      advanceOnPrompt,
      markResolved,
      _readSessions: readSessions,
      // Exposed for tests:
      acquireLock,
      releaseLock
    };
  }
});

// lib/click-marker.js
var require_click_marker = __commonJS({
  "lib/click-marker.js"(exports2, module2) {
    var CLICK_MARKER_STALE_MS = 5 * 60 * 1e3;
    function parseClickMarker(content) {
      if (typeof content !== "string" || content.trim() === "") {
        return { legacy: true };
      }
      let data;
      try {
        data = JSON.parse(content);
      } catch (_) {
        return { legacy: true };
      }
      if (!data || typeof data !== "object") return { legacy: true };
      if (typeof data.timestamp === "number" && Date.now() - data.timestamp > CLICK_MARKER_STALE_MS) {
        return { stale: true };
      }
      return {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
        event: data.event === "completed" ? "completed" : "waiting",
        project: typeof data.project === "string" ? data.project : "Unknown",
        pids: Array.isArray(data.pids) ? data.pids.filter((p) => Number.isInteger(p) && p > 0) : [],
        shellPid: Number.isInteger(data.shellPid) && data.shellPid > 0 ? data.shellPid : 0,
        workspaceRoot: typeof data.workspaceRoot === "string" ? data.workspaceRoot : "",
        projectDir: typeof data.projectDir === "string" ? data.projectDir : "",
        aiTitle: typeof data.aiTitle === "string" ? data.aiTitle : "",
        timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now()
      };
    }
    function buildClickMarkerPayload2({ sessionId, pids, shellPid, workspaceRoot, projectDir, event, project, aiTitle }) {
      return JSON.stringify({
        sessionId: sessionId || "",
        event: event === "completed" ? "completed" : "waiting",
        project: project || "Unknown",
        pids: Array.isArray(pids) ? pids : [],
        shellPid: Number.isInteger(shellPid) && shellPid > 0 ? shellPid : 0,
        workspaceRoot: workspaceRoot || "",
        projectDir: projectDir || "",
        aiTitle: typeof aiTitle === "string" ? aiTitle : "",
        timestamp: Date.now()
      });
    }
    module2.exports = { parseClickMarker, buildClickMarkerPayload: buildClickMarkerPayload2, CLICK_MARKER_STALE_MS };
  }
});

// lib/transcript-title.js
var require_transcript_title = __commonJS({
  "lib/transcript-title.js"(exports2, module2) {
    var fs2 = require("fs");
    function readAiTitle2(transcriptPath) {
      if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
      let content;
      try {
        content = fs2.readFileSync(transcriptPath, "utf8");
      } catch (_) {
        return null;
      }
      if (!content) return null;
      const lines = content.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.indexOf('"ai-title"') === -1) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && obj.type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle.trim() !== "") {
            return obj.aiTitle.trim();
          }
        } catch (_) {
        }
      }
      return null;
    }
    module2.exports = { readAiTitle: readAiTitle2 };
  }
});

// lib/process-tree.js
var require_process_tree = __commonJS({
  "lib/process-tree.js"(exports2, module2) {
    var { execSync: execSync2 } = require("child_process");
    var WALK_UP_LIMIT = 30;
    function snapshot() {
      if (process.platform === "win32") {
        return snapshotWindows();
      }
      return snapshotPosix();
    }
    function snapshotWindows() {
      try {
        const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
        const out = execSync2(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
          encoding: "utf8",
          timeout: 5e3,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const procs = parsePowerShellJson(out);
        if (procs.size > 0) return { procs, source: "powershell" };
      } catch (_) {
      }
      try {
        const out = execSync2(
          `wmic process get ProcessId,ParentProcessId,Name /format:csv`,
          { encoding: "utf8", timeout: 5e3, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
        );
        const procs = parseWmicCsv(out);
        if (procs.size > 0) return { procs, source: "wmic" };
      } catch (_) {
      }
      return { procs: /* @__PURE__ */ new Map(), source: "failed" };
    }
    function snapshotPosix() {
      try {
        const out = execSync2("ps -A -o pid=,ppid=,comm=", {
          encoding: "utf8",
          timeout: 3e3,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const procs = parsePsOutput(out);
        if (procs.size > 0) return { procs, source: "ps" };
      } catch (_) {
      }
      return { procs: /* @__PURE__ */ new Map(), source: "failed" };
    }
    function parsePowerShellJson(text) {
      const procs = /* @__PURE__ */ new Map();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        return procs;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const pid = toInt(row.ProcessId);
        const ppid = toInt(row.ParentProcessId);
        const name = typeof row.Name === "string" ? row.Name : "";
        if (pid > 0) procs.set(pid, { pid, ppid, name });
      }
      return procs;
    }
    function parseWmicCsv(text) {
      const procs = /* @__PURE__ */ new Map();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return procs;
      const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
      const nameIdx = header.indexOf("name");
      const pidIdx = header.indexOf("processid");
      const ppidIdx = header.indexOf("parentprocessid");
      if (pidIdx < 0 || ppidIdx < 0) return procs;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const pid = toInt(cols[pidIdx]);
        const ppid = toInt(cols[ppidIdx]);
        const name = nameIdx >= 0 ? (cols[nameIdx] || "").trim() : "";
        if (pid > 0) procs.set(pid, { pid, ppid, name });
      }
      return procs;
    }
    function parsePsOutput(text) {
      const procs = /* @__PURE__ */ new Map();
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = toInt(m[1]);
        const ppid = toInt(m[2]);
        const name = m[3].trim();
        if (pid > 0) procs.set(pid, { pid, ppid, name });
      }
      return procs;
    }
    function toInt(value) {
      const n = parseInt(value, 10);
      return Number.isFinite(n) ? n : 0;
    }
    function walkUp2(snapshotResult, pid, limit = WALK_UP_LIMIT) {
      const { procs } = snapshotResult;
      const chain = [];
      const seen = /* @__PURE__ */ new Set();
      let current = pid;
      while (current && current > 0 && chain.length < limit) {
        if (seen.has(current)) break;
        seen.add(current);
        const node = procs.get(current);
        if (!node) {
          chain.push({ pid: current, ppid: 0, name: "" });
          break;
        }
        chain.push(node);
        if (!node.ppid || node.ppid === current) break;
        current = node.ppid;
      }
      return chain;
    }
    function walkDown(snapshotResult, rootPid) {
      const { procs } = snapshotResult;
      const childIndex = /* @__PURE__ */ new Map();
      for (const node of procs.values()) {
        if (!node.ppid) continue;
        if (!childIndex.has(node.ppid)) childIndex.set(node.ppid, []);
        childIndex.get(node.ppid).push(node.pid);
      }
      const result = /* @__PURE__ */ new Set();
      const stack = [rootPid];
      while (stack.length) {
        const pid = stack.pop();
        if (result.has(pid)) continue;
        result.add(pid);
        const children = childIndex.get(pid);
        if (children) stack.push(...children);
      }
      return result;
    }
    module2.exports = {
      snapshot,
      walkUp: walkUp2,
      walkDown,
      // Exposed for tests:
      parsePowerShellJson,
      parseWmicCsv,
      parsePsOutput,
      WALK_UP_LIMIT
    };
  }
});

// hook.js
var fs = require("fs");
var path = require("path");
var { execSync, execFile, spawn } = require("child_process");
var os = require("os");
var { setTimeout: sleep } = require("node:timers/promises");
var { pathToFileURL } = require("node:url");
var { claimHandled, eventPriority } = require_signals();
var {
  getStateDir,
  getSignalPath,
  getClickedPath,
  getClaimedPath
} = require_state_paths();
var { shouldNotify: checkShouldNotify } = require_stage_dedup();
var { buildClickMarkerPayload } = require_click_marker();
var { readAiTitle } = require_transcript_title();
var { snapshot: processSnapshot, walkUp } = require_process_tree();
var SHELL_PROCESS_NAMES = /* @__PURE__ */ new Set([
  "bash.exe",
  "sh.exe",
  "zsh.exe",
  "pwsh.exe",
  "powershell.exe",
  "cmd.exe",
  "fish.exe",
  "wsl.exe",
  // POSIX (no .exe), as reported by `ps -o comm=`. Includes the
  // login-shell '-' prefix variants.
  "bash",
  "-bash",
  "sh",
  "-sh",
  "zsh",
  "-zsh",
  "pwsh",
  "powershell",
  "fish",
  "-fish"
]);
var CONFIG_FILE = "claude-notifications-config.json";
var DEFAULT_HANDSHAKE_MS = 1200;
function shEsc(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function buildHiddenPsArgv(tmpScript) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const hideVbsPath = path.join(localAppData, "claude-notifications", "hide.vbs");
  const psTail = [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    tmpScript
  ];
  let useVbs = false;
  try {
    useVbs = fs.existsSync(hideVbsPath);
  } catch (_) {
    useVbs = false;
  }
  if (useVbs) {
    return ["/c", "start", '""', "/B", "wscript.exe", hideVbsPath, ...psTail];
  }
  return ["/c", "start", '""', "/B", ...psTail];
}
function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
(async () => {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = path.basename(projectDir);
  let hookEvent = "waiting";
  let hookEventName = "";
  let hookMessage = "";
  let sessionId = "";
  let transcriptPath = "";
  try {
    const stdinData = fs.readFileSync(0, "utf8");
    const input = JSON.parse(stdinData);
    hookEventName = input.hook_event_name || "";
    hookMessage = typeof input.message === "string" ? input.message : "";
    sessionId = input.session_id || "";
    transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
    const eventName = hookEventName.toLowerCase();
    if (eventName === "stop") hookEvent = "completed";
    else hookEvent = "waiting";
  } catch (_) {
  }
  const MAX_TITLE_LEN = 60;
  let aiTitle = "";
  if (transcriptPath) {
    const raw = readAiTitle(transcriptPath);
    if (raw) {
      aiTitle = raw.length > MAX_TITLE_LEN ? raw.slice(0, MAX_TITLE_LEN - 1) + "\u2026" : raw;
    }
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
  const dedup = checkShouldNotify(workspaceRoot, sessionId, hookEvent, hookEventName);
  if (!dedup.notify) {
    process.exit(0);
  }
  const snap = processSnapshot();
  const chain = walkUp(snap, process.pid);
  const pids = chain.map((n) => n.pid);
  const pidNames = {};
  for (const node of chain) {
    if (node.name) pidNames[String(node.pid)] = node.name;
  }
  let shellPid = 0;
  for (const node of chain) {
    if (!node.name) continue;
    const base = node.name.toLowerCase().replace(/^.*[/\\]/, "").replace(/^-/, "");
    if (SHELL_PROCESS_NAMES.has(base)) {
      shellPid = node.pid;
      break;
    }
  }
  try {
    const tip = chain.length > 0 ? chain[chain.length - 1] : null;
    const tipDesc = tip ? `pid=${tip.pid} name=${tip.name || "?"}` : "empty-chain";
    process.stderr.write(
      `claude-notifications: chain depth=${chain.length} source=${snap.source} shellPid=${shellPid || "none"} tip=${tipDesc}
`
    );
  } catch (_) {
  }
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
      pidNames,
      shellPid: shellPid || void 0,
      pidChainSource: snap.source,
      state: "pending",
      aiTitle,
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
          const child = spawn("afplay", ["-v", vol, fileToPlay], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
        } else if (process.platform === "win32") {
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
          const tmpSoundScript = path.join(os.tmpdir(), `claude-sound-${Date.now()}-${process.pid}.ps1`);
          const soundCleanup = `
try {} finally { Remove-Item -LiteralPath '${tmpSoundScript.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue }`;
          fs.writeFileSync(tmpSoundScript, "\uFEFF" + psCmd + soundCleanup, "utf8");
          const child = spawn("cmd.exe", buildHiddenPsArgv(tmpSoundScript), {
            detached: true,
            stdio: "ignore",
            windowsHide: true
          });
          child.unref();
        } else {
          const paVol = String(Math.round(volume / 100 * 65536));
          const child = spawn("sh", ["-c", `paplay --volume=${paVol} '${fileToPlay.replace(/'/g, "'\\''")}' || aplay '${fileToPlay.replace(/'/g, "'\\''")}'`], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
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
      const clickPayload = buildClickMarkerPayload({
        sessionId,
        pids,
        shellPid,
        workspaceRoot,
        projectDir,
        event: hookEvent,
        project: projectName,
        aiTitle
      });
      const executeCmd = `/usr/bin/printf '%s' ${shEsc(clickPayload)} > ${shEsc(clickedPath)} && ${shEsc(codeCli)} ${shEsc(workspaceRoot)}`;
      const notifierArgs = [
        "-title",
        eventInfo.title,
        "-message",
        eventInfo.message,
        "-execute",
        executeCmd,
        "-group",
        `claude-${projectName}`
      ];
      if (aiTitle) {
        notifierArgs.splice(2, 0, "-subtitle", aiTitle);
      }
      const child = spawn("terminal-notifier", notifierArgs, { detached: true, stdio: "ignore" });
      child.unref();
    } catch (_) {
      try {
        const osaTitle = aiTitle ? `${eventInfo.title} \u2014 ${aiTitle.replace(/"/g, '\\"')}` : eventInfo.title;
        execSync(`osascript -e 'display notification "${eventInfo.message}" with title "${osaTitle}"'`, {
          timeout: 3e3,
          stdio: "ignore"
        });
      } catch (_2) {
      }
    }
  } else if (process.platform === "win32") {
    const tmpScript = path.join(os.tmpdir(), `claude-notif-${Date.now()}-${process.pid}.ps1`);
    const titleLine = aiTitle ? `    <text>${xmlEsc(aiTitle)}</text>` : "";
    const clickMarkerJson = buildClickMarkerPayload({
      sessionId,
      pids,
      shellPid,
      workspaceRoot,
      projectDir,
      event: hookEvent,
      project: projectName,
      aiTitle
    });
    const clickMarkerB64 = Buffer.from(clickMarkerJson, "utf8").toString("base64");
    const toastLaunchUri = `vscode://dimokol.claude-notifications/click?marker=${encodeURIComponent(clickMarkerB64)}`;
    const psScriptBody = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast activationType="protocol" launch="${xmlEsc(toastLaunchUri)}" duration="long">
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
      fs.writeFileSync(tmpScript, "\uFEFF" + psScriptBody, "utf8");
      const child = spawn("cmd.exe", buildHiddenPsArgv(tmpScript), {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
    } catch (_) {
      try {
        fs.unlinkSync(tmpScript);
      } catch (_2) {
      }
    }
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
  process.exit(0);
})();
