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
    var CLAIM_CROSS_STAGE_STEAL_MS = 2e3;
    var EVENT_PRIORITY = { completed: 1, waiting: 2 };
    function eventPriority2(event) {
      return EVENT_PRIORITY[event] || 0;
    }
    function normalizeEvent(event) {
      if (event === "completed") return "completed";
      if (event === "stop") return "completed";
      return "waiting";
    }
    function claimHandled2(handledPath, opts = {}) {
      if (typeof opts === "number") opts = { staleMs: opts };
      const staleMs = opts.staleMs != null ? opts.staleMs : CLAIM_STALE_MS;
      const crossTagStealMs = opts.crossTagStealMs != null ? opts.crossTagStealMs : CLAIM_CROSS_STAGE_STEAL_MS;
      const tag = typeof opts.tag === "string" ? opts.tag : "";
      const markerContent = () => `${Date.now()}:${tag}`;
      try {
        fs2.writeFileSync(handledPath, markerContent(), { flag: "wx" });
        return true;
      } catch (err) {
        if (err.code !== "EEXIST") return false;
      }
      let stat;
      try {
        stat = fs2.statSync(handledPath);
      } catch (_) {
        try {
          fs2.writeFileSync(handledPath, markerContent(), { flag: "wx" });
          return true;
        } catch (_2) {
          return false;
        }
      }
      let effectiveStaleMs = staleMs;
      if (tag) {
        let markerTag = "";
        try {
          const raw = fs2.readFileSync(handledPath, "utf8");
          const sep = raw.indexOf(":");
          if (sep !== -1) markerTag = raw.slice(sep + 1);
        } catch (_) {
        }
        if (markerTag && markerTag !== tag) effectiveStaleMs = crossTagStealMs;
      }
      if (Date.now() - stat.mtimeMs <= effectiveStaleMs) return false;
      try {
        fs2.unlinkSync(handledPath);
      } catch (_) {
        return false;
      }
      try {
        fs2.writeFileSync(handledPath, markerContent(), { flag: "wx" });
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
              question: typeof data.question === "string" ? data.question : "",
              customName: typeof data.customName === "string" ? data.customName : "",
              sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
              stageId: Number.isInteger(data.stageId) && data.stageId > 0 ? data.stageId : 0,
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
      const lines = trimmed.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
      if (lines.length === 0 || !lines.every((s) => /^\d+$/.test(s))) return null;
      const pids = lines.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n > 0);
      return {
        version: 1,
        event: "waiting",
        hookEventName: "",
        hookMessage: "",
        question: "",
        customName: "",
        sessionId: "",
        stageId: 0,
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
      CLAIM_CROSS_STAGE_STEAL_MS,
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
    function getStateRoot() {
      return path2.join(os2.homedir(), ".claude", "focus-state");
    }
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
      return path2.join(getStateRoot(), hashWorkspace(workspaceRoot));
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
      getStateRoot,
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
          if (now - lastAt2 < STAGE_ESCAPE_VALVE_MS || currentHookEventName === "Notification") {
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
        if (now - lastAt > STAGE_ESCAPE_VALVE_MS && currentHookEventName !== "Notification") {
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
    var CLICK_MARKER_STALE_MS = 60 * 60 * 1e3;
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

// lib/code-build.js
var require_code_build = __commonJS({
  "lib/code-build.js"(exports2, module2) {
    "use strict";
    var BUILDS = [
      { id: "insiders", re: /^Code - Insiders\.exe$/i, scheme: "vscode-insiders", cli: "code-insiders" },
      { id: "stable", re: /^Code\.exe$/i, scheme: "vscode", cli: "code" },
      { id: "vscodium", re: /^(VSCodium|Codium)\.exe$/i, scheme: "vscodium", cli: "codium" },
      { id: "cursor", re: /^Cursor\.exe$/i, scheme: "cursor", cli: "cursor" },
      { id: "windsurf", re: /^Windsurf\.exe$/i, scheme: "windsurf", cli: "windsurf" }
    ];
    var CLI_PREFERENCE = ["code", "code-insiders", "codium", "cursor", "windsurf"];
    function buildFor(name) {
      if (typeof name !== "string" || name === "") return null;
      const base = name.replace(/^.*[/\\]/, "");
      return BUILDS.find((b) => b.re.test(base)) || null;
    }
    function classifyBuild2(name) {
      const b = buildFor(name);
      return b ? b.id : null;
    }
    function schemeForBinaryName2(binaryName, fallback = "vscode") {
      const b = buildFor(binaryName);
      return b ? b.scheme : fallback;
    }
    function cliForBinaryName(binaryName) {
      const b = buildFor(binaryName);
      return b ? b.cli : null;
    }
    function resolveCodeCli({ binaryName, probe, fallback = "code" } = {}) {
      const mapped = cliForBinaryName(binaryName);
      if (mapped) {
        if (typeof probe !== "function" || probe(mapped)) return mapped;
      }
      if (typeof probe === "function") {
        for (const cli of CLI_PREFERENCE) {
          if (probe(cli)) return cli;
        }
      }
      return fallback;
    }
    module2.exports = {
      BUILDS,
      CLI_PREFERENCE,
      classifyBuild: classifyBuild2,
      schemeForBinaryName: schemeForBinaryName2,
      cliForBinaryName,
      resolveCodeCli
    };
  }
});

// lib/hook-input.js
var require_hook_input = __commonJS({
  "lib/hook-input.js"(exports2, module2) {
    var SKIP_NOTIFICATION_TYPES = /* @__PURE__ */ new Set([
      "auth_success",
      "elicitation_complete",
      "elicitation_response"
    ]);
    var PRIMARY_NOTIFICATION_TYPES = {
      agent_needs_input: { event: "waiting", dedupEventName: "AgentNotification" },
      agent_completed: { event: "completed", dedupEventName: "AgentNotification" },
      elicitation_dialog: { event: "waiting", dedupEventName: "ElicitationNotification" }
    };
    function classifyHookInput2(input) {
      const raw = input && typeof input.hook_event_name === "string" ? input.hook_event_name : "";
      const lower = raw.toLowerCase();
      if (lower === "stop") {
        return { skip: false, event: "completed", hookEventName: raw, dedupEventName: raw };
      }
      if (lower === "notification") {
        const nType = input && typeof input.notification_type === "string" ? input.notification_type : "";
        if (SKIP_NOTIFICATION_TYPES.has(nType)) return { skip: true };
        const primary = PRIMARY_NOTIFICATION_TYPES[nType];
        if (primary) {
          return { skip: false, event: primary.event, hookEventName: raw, dedupEventName: primary.dedupEventName };
        }
        return { skip: false, event: "waiting", hookEventName: raw, dedupEventName: raw };
      }
      return { skip: false, event: "waiting", hookEventName: raw, dedupEventName: raw };
    }
    var MAX_QUESTION_LEN = 120;
    function extractQuestionText2(toolName, toolInput) {
      if (toolName !== "AskUserQuestion") return "";
      if (!toolInput || typeof toolInput !== "object") return "";
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const first = questions.find((q) => q && typeof q.question === "string" && q.question.trim() !== "");
      if (!first) return "";
      let text = first.question.trim().replace(/\s+/g, " ");
      if (text.length > MAX_QUESTION_LEN) text = text.slice(0, MAX_QUESTION_LEN - 1) + "\u2026";
      return text;
    }
    module2.exports = {
      classifyHookInput: classifyHookInput2,
      extractQuestionText: extractQuestionText2,
      SKIP_NOTIFICATION_TYPES,
      PRIMARY_NOTIFICATION_TYPES,
      MAX_QUESTION_LEN
    };
  }
});

// lib/terminal-match.js
var require_terminal_match = __commonJS({
  "lib/terminal-match.js"(exports2, module2) {
    var DEFAULT_SHELL_NAMES = /* @__PURE__ */ new Set([
      "bash",
      "powershell",
      "pwsh",
      "cmd",
      "zsh",
      "sh",
      "fish",
      "terminal",
      "shell",
      "git bash",
      "command prompt"
    ]);
    var CLAUDE_TITLE_MARKERS = ["\u2733", "\u2692", "\u25A3", "\u273B"];
    var PROJECT_NAME_MIN_LEN = 4;
    function matchTerminal(terminals, signal) {
      if (!Array.isArray(terminals) || terminals.length === 0) return null;
      const sig = signal || {};
      const pidSet = /* @__PURE__ */ new Set([
        ...Array.isArray(sig.pids) ? sig.pids : [],
        ...sig.shellPid ? [sig.shellPid] : []
      ]);
      const pidMatches = terminals.filter((t) => t.pid && pidSet.has(t.pid));
      if (pidMatches.length === 1) {
        const t = pidMatches[0];
        const why = sig.shellPid === t.pid ? `shellPid=${t.pid}` : `pid=${t.pid} in signal.pids`;
        return { index: t.index, tier: "pid", reason: why };
      }
      if (sig.shellPid && pidMatches.length === 0 && sig.pidChainSource === "ps") {
        return null;
      }
      const workspaceRoot = normalizePath(sig.workspaceRoot || "");
      const projectDir = normalizePath(sig.projectDir || "");
      if (workspaceRoot || projectDir) {
        const cwdMatches = terminals.filter((t) => {
          const cwd = normalizePath(t.cwd || "");
          if (!cwd) return false;
          if (workspaceRoot && cwd === workspaceRoot) return true;
          if (projectDir && cwd === projectDir) return true;
          if (workspaceRoot && cwd.startsWith(workspaceRoot + "/")) return true;
          if (projectDir && cwd.startsWith(projectDir + "/")) return true;
          return false;
        });
        if (cwdMatches.length === 1) {
          const t = cwdMatches[0];
          return { index: t.index, tier: "cwd", reason: `cwd=${t.cwd}` };
        }
      }
      const aiTitle = (sig.aiTitle || "").trim();
      if (aiTitle && aiTitle.length >= 4) {
        const titleMatches = terminals.filter((t) => (t.name || "").includes(aiTitle));
        if (titleMatches.length === 1) {
          const t = titleMatches[0];
          return { index: t.index, tier: "ai-title", reason: `name contains "${aiTitle}"` };
        }
      }
      const project = (sig.project || "").toLowerCase();
      const projectOk = project.length >= PROJECT_NAME_MIN_LEN;
      const markerMatches = terminals.filter((t) => {
        const name = t.name || "";
        if (!name) return false;
        for (const m of CLAUDE_TITLE_MARKERS) {
          if (name.includes(m)) return true;
        }
        const lower = name.toLowerCase();
        if (lower.includes("claude")) return true;
        if (projectOk && lower.includes(project)) return true;
        return false;
      });
      if (markerMatches.length === 1) {
        const t = markerMatches[0];
        return { index: t.index, tier: "claude-marker", reason: `name="${t.name}"` };
      }
      const nonDefault = terminals.filter((t) => !isDefaultShellName(t.name));
      if (nonDefault.length === 1) {
        const t = nonDefault[0];
        return { index: t.index, tier: "non-default-name", reason: `only non-default-named terminal: "${t.name}"` };
      }
      return null;
    }
    function isDefaultShellName(name) {
      if (!name) return true;
      const trimmed = name.trim().toLowerCase();
      if (DEFAULT_SHELL_NAMES.has(trimmed)) return true;
      const stripped = trimmed.replace(/\s*\(\d+\)\s*$/, "");
      return DEFAULT_SHELL_NAMES.has(stripped);
    }
    function normalizePath(p) {
      if (!p) return "";
      let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
      if (/^[a-zA-Z]:\//.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
      return s;
    }
    module2.exports = {
      matchTerminal,
      isDefaultShellName,
      normalizePath,
      DEFAULT_SHELL_NAMES,
      CLAUDE_TITLE_MARKERS
    };
  }
});

// lib/terminal-names.js
var require_terminal_names = __commonJS({
  "lib/terminal-names.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { getStateDir: getStateDir2 } = require_state_paths();
    var { isDefaultShellName, CLAUDE_TITLE_MARKERS } = require_terminal_match();
    var NAME_CACHE_HEARTBEAT_MS = 60 * 1e3;
    var NAME_CACHE_STALE_MS = 5 * 60 * 1e3;
    var MAX_CUSTOM_NAME_LEN = 60;
    function isCustomTerminalName(name, { aiTitle = "", project = "" } = {}) {
      if (typeof name !== "string") return false;
      const trimmed = name.trim();
      if (!trimmed) return false;
      if (isDefaultShellName(trimmed)) return false;
      for (const marker of CLAUDE_TITLE_MARKERS) {
        if (trimmed.includes(marker)) return false;
      }
      const lower = trimmed.toLowerCase();
      if (lower.includes("claude")) return false;
      if (aiTitle && lower.includes(String(aiTitle).trim().toLowerCase())) return false;
      const deduped = lower.replace(/\s*\(\d+\)\s*$/, "");
      if (project && deduped === String(project).trim().toLowerCase()) return false;
      return true;
    }
    function getTerminalNamesPath(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "terminal-names");
    }
    function writeTerminalNamesCache(workspaceRoot, names) {
      try {
        const dir = getStateDir2(workspaceRoot);
        fs2.mkdirSync(dir, { recursive: true });
        const p = getTerminalNamesPath(workspaceRoot);
        const tmp = `${p}.tmp.${process.pid}`;
        fs2.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), names: names || {} }));
        fs2.renameSync(tmp, p);
        return true;
      } catch (_) {
        return false;
      }
    }
    function readTerminalNamesCache2(workspaceRoot, staleMs = NAME_CACHE_STALE_MS) {
      try {
        const raw = fs2.readFileSync(getTerminalNamesPath(workspaceRoot), "utf8");
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object" || !data.names || typeof data.names !== "object") return null;
        if (typeof data.updatedAt !== "number" || Date.now() - data.updatedAt > staleMs) return null;
        return data;
      } catch (_) {
        return null;
      }
    }
    function lookupCustomName2(cache, { shellPid = 0, pids = [] } = {}, ctx = {}) {
      if (!cache || !cache.names) return "";
      const tryPid = (pid) => {
        if (!pid) return "";
        const name = cache.names[String(pid)];
        if (typeof name !== "string" || !isCustomTerminalName(name, ctx)) return "";
        const trimmed = name.trim();
        return trimmed.length > MAX_CUSTOM_NAME_LEN ? trimmed.slice(0, MAX_CUSTOM_NAME_LEN - 1) + "\u2026" : trimmed;
      };
      const fromShell = tryPid(shellPid);
      if (fromShell) return fromShell;
      for (const pid of Array.isArray(pids) ? pids : []) {
        const hit = tryPid(pid);
        if (hit) return hit;
      }
      return "";
    }
    module2.exports = {
      isCustomTerminalName,
      getTerminalNamesPath,
      writeTerminalNamesCache,
      readTerminalNamesCache: readTerminalNamesCache2,
      lookupCustomName: lookupCustomName2,
      NAME_CACHE_HEARTBEAT_MS,
      NAME_CACHE_STALE_MS,
      MAX_CUSTOM_NAME_LEN
    };
  }
});

// lib/mac-code-cli.js
var require_mac_code_cli = __commonJS({
  "lib/mac-code-cli.js"(exports2, module2) {
    "use strict";
    var fs2 = require("fs");
    var os2 = require("os");
    var path2 = require("path");
    var { getStateDir: getStateDir2 } = require_state_paths();
    var EDITOR_HOST_FILE = "editor-host";
    var EDITOR_HOST_VERSION = 1;
    var SCHEME_CLI_NAMES = {
      vscode: ["code"],
      "vscode-insiders": ["code-insiders"],
      vscodium: ["codium"],
      "vscodium-insiders": ["codium-insiders"],
      "vscode-oss": ["codium", "code-oss"],
      "code-oss": ["code-oss"],
      cursor: ["cursor"],
      windsurf: ["windsurf"]
    };
    function safeCliName2(value) {
      if (typeof value !== "string") return "";
      const name = value.trim();
      if (!name || path2.basename(name) !== name) return "";
      return /^[A-Za-z0-9._-]+$/.test(name) ? name : "";
    }
    function expandHome(value, homeDir = os2.homedir()) {
      if (typeof value !== "string") return "";
      const trimmed = value.trim();
      if (trimmed === "~") return homeDir;
      if (trimmed.startsWith("~/")) return path2.join(homeDir, trimmed.slice(2));
      return trimmed;
    }
    function isExecutable2(filePath, fsLike = fs2) {
      if (!filePath || !path2.isAbsolute(filePath)) return false;
      try {
        fsLike.accessSync(filePath, fs2.constants.X_OK);
        return true;
      } catch (_) {
        return false;
      }
    }
    function readApplicationName(appRoot, fsLike = fs2) {
      if (!appRoot) return "";
      try {
        const product = JSON.parse(fsLike.readFileSync(path2.join(appRoot, "product.json"), "utf8"));
        return safeCliName2(product && product.applicationName);
      } catch (_) {
        return "";
      }
    }
    function appRootFromExecPath(execPath) {
      if (typeof execPath !== "string" || !execPath) return "";
      const normalized = execPath.replace(/\\/g, "/");
      const marker = "/Contents/MacOS/";
      const index = normalized.indexOf(marker);
      if (index < 0) return "";
      return path2.join(normalized.slice(0, index), "Contents", "Resources", "app");
    }
    function resolveMacCodeCli({
      overridePath = "",
      appRoot = "",
      uriScheme = "",
      execPath = "",
      homeDir = os2.homedir(),
      fsLike = fs2
    } = {}) {
      const override = expandHome(overridePath, homeDir);
      if (isExecutable2(override, fsLike)) {
        return {
          codeCliPath: override,
          cliName: path2.basename(override),
          uriScheme: typeof uriScheme === "string" ? uriScheme : "",
          source: "override"
        };
      }
      const roots = [];
      const addRoot = (root) => {
        if (typeof root === "string" && root && !roots.includes(root)) roots.push(root);
      };
      addRoot(appRoot);
      addRoot(appRootFromExecPath(execPath));
      const names = [];
      const addName = (name) => {
        const safe = safeCliName2(name);
        if (safe && !names.includes(safe)) names.push(safe);
      };
      for (const root of roots) addName(readApplicationName(root, fsLike));
      const scheme = typeof uriScheme === "string" ? uriScheme.trim().toLowerCase() : "";
      for (const name of SCHEME_CLI_NAMES[scheme] || []) addName(name);
      addName(scheme);
      for (const root of roots) {
        for (const name of names) {
          const candidate = path2.join(root, "bin", name);
          if (isExecutable2(candidate, fsLike)) {
            return {
              codeCliPath: candidate,
              cliName: name,
              uriScheme: typeof uriScheme === "string" ? uriScheme : "",
              source: "app-root"
            };
          }
        }
      }
      return null;
    }
    function getEditorHostPath(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), EDITOR_HOST_FILE);
    }
    function normalizeEditorHost2(value) {
      if (!value || typeof value !== "object") return null;
      const codeCliPath = typeof value.codeCliPath === "string" ? value.codeCliPath : "";
      if (!path2.isAbsolute(codeCliPath)) return null;
      return {
        version: EDITOR_HOST_VERSION,
        platform: "darwin",
        codeCliPath,
        cliName: safeCliName2(value.cliName) || path2.basename(codeCliPath),
        uriScheme: typeof value.uriScheme === "string" ? value.uriScheme : "",
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0
      };
    }
    function writeEditorHost(workspaceRoot, host, fsLike = fs2) {
      const normalized = normalizeEditorHost2({ ...host, updatedAt: Date.now() });
      if (!normalized) return false;
      const finalPath = getEditorHostPath(workspaceRoot);
      const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
      try {
        fsLike.mkdirSync(path2.dirname(finalPath), { recursive: true });
        fsLike.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2));
        fsLike.renameSync(tmpPath, finalPath);
        return true;
      } catch (_) {
        try {
          fsLike.unlinkSync(tmpPath);
        } catch (_2) {
        }
        return false;
      }
    }
    function readEditorHost2(workspaceRoot, fsLike = fs2) {
      try {
        return normalizeEditorHost2(JSON.parse(fsLike.readFileSync(getEditorHostPath(workspaceRoot), "utf8")));
      } catch (_) {
        return null;
      }
    }
    module2.exports = {
      EDITOR_HOST_FILE,
      EDITOR_HOST_VERSION,
      SCHEME_CLI_NAMES,
      safeCliName: safeCliName2,
      expandHome,
      isExecutable: isExecutable2,
      readApplicationName,
      appRootFromExecPath,
      resolveMacCodeCli,
      getEditorHostPath,
      normalizeEditorHost: normalizeEditorHost2,
      writeEditorHost,
      readEditorHost: readEditorHost2
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
var { schemeForBinaryName, classifyBuild } = require_code_build();
var { classifyHookInput, extractQuestionText } = require_hook_input();
var { readTerminalNamesCache, lookupCustomName } = require_terminal_names();
var { isExecutable, normalizeEditorHost, readEditorHost, safeCliName } = require_mac_code_cli();
var SHELL_PROCESS_NAMES = /* @__PURE__ */ new Set([
  "bash.exe",
  "sh.exe",
  "zsh.exe",
  "pwsh.exe",
  "powershell.exe",
  "cmd.exe",
  "fish.exe",
  "wsl.exe",
  "nu.exe",
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
  "-fish",
  "dash",
  "-dash",
  "ksh",
  "-ksh",
  "tcsh",
  "-tcsh",
  "csh",
  "-csh",
  "nu"
]);
var CONFIG_FILE = "claude-notifications-config.json";
var DEFAULT_HANDSHAKE_MS = 1200;
function shEsc(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function writeFileAtomic(p, data) {
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
    }
    throw err;
  }
}
var MAC_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
function findMacBinary(name) {
  for (const dir of MAC_BIN_DIRS) {
    const p = `${dir}/${name}`;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {
    }
  }
  try {
    const stdout = execSync(`command -v ${name}`, {
      encoding: "utf8",
      timeout: 2e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return stdout || null;
  } catch (_) {
    return null;
  }
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
  let dedupEventName = "";
  let hookMessage = "";
  let sessionId = "";
  let transcriptPath = "";
  let question = "";
  try {
    const stdinData = fs.readFileSync(0, "utf8");
    const input = JSON.parse(stdinData);
    hookMessage = typeof input.message === "string" ? input.message : "";
    sessionId = input.session_id || "";
    transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
    const cls = classifyHookInput(input);
    if (cls.skip) process.exit(0);
    hookEvent = cls.event;
    hookEventName = cls.hookEventName;
    dedupEventName = cls.dedupEventName;
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : null;
    question = extractQuestionText(toolName, toolInput);
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
  const dedup = checkShouldNotify(workspaceRoot, sessionId, hookEvent, dedupEventName || hookEventName);
  if (!dedup.notify) {
    process.exit(0);
  }
  const claimTag = sessionId && dedup.stageId ? `${sessionId}:${dedup.stageId}` : "";
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
  const customName = lookupCustomName(
    readTerminalNamesCache(workspaceRoot),
    { shellPid, pids },
    { aiTitle, project: projectName }
  );
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
      question: question || void 0,
      customName: customName || void 0,
      sessionId,
      stageId: dedup.stageId || void 0,
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
    try {
      writeFileAtomic(signalPath, JSON.stringify(signalPayload, null, 2));
    } catch (_) {
    }
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
  const eventInfo = { ...eventMessages[hookEvent] || eventMessages.waiting };
  if (hookEvent === "waiting" && question) {
    eventInfo.message = `Question in ${projectName}: ${question}`;
  }
  const bannerLabel = customName || aiTitle;
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
  if (!claimHandled(claimPath, { tag: claimTag })) {
    process.exit(0);
  }
  try {
    const onDisk = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    onDisk.state = "fired";
    writeFileAtomic(signalPath, JSON.stringify(onDisk, null, 2));
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
  function findCodeCli(host) {
    if (host) {
      if (isExecutable(host.codeCliPath)) return host.codeCliPath;
      const cliName = safeCliName(host.cliName);
      if (cliName) return findMacBinary(cliName);
      return null;
    }
    return findMacBinary("code") || "code";
  }
  if (process.platform === "darwin") {
    const macHost = readEditorHost(workspaceRoot) || normalizeEditorHost(config.macOS);
    const codeCli = findCodeCli(macHost);
    const tnBinary = findMacBinary("terminal-notifier");
    if (tnBinary) {
      try {
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
        const clickedTmpPath = `${clickedPath}.tmp.${process.pid}.${Date.now()}`;
        const writeClickMarker = `/usr/bin/printf '%s' ${shEsc(clickPayload)} > ${shEsc(clickedTmpPath)} && /bin/mv -f ${shEsc(clickedTmpPath)} ${shEsc(clickedPath)}`;
        const executeCmd = codeCli ? `${writeClickMarker} && ${shEsc(codeCli)} ${shEsc(workspaceRoot)}` : writeClickMarker;
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
        if (bannerLabel) {
          notifierArgs.splice(2, 0, "-subtitle", bannerLabel);
        }
        const child = spawn(tnBinary, notifierArgs, { detached: true, stdio: "ignore" });
        child.unref();
      } catch (_) {
      }
    } else {
      try {
        const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const osaTitle = bannerLabel ? `${eventInfo.title} \u2014 ${bannerLabel}` : eventInfo.title;
        const script = `display notification "${esc(eventInfo.message)}" with title "${esc(osaTitle)}"`;
        const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
        child.unref();
      } catch (_) {
      }
    }
  } else if (process.platform === "win32") {
    const tmpScript = path.join(os.tmpdir(), `claude-notif-${Date.now()}-${process.pid}.ps1`);
    const titleLine = bannerLabel ? `    <text>${xmlEsc(bannerLabel)}</text>` : "";
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
    let launchScheme = "vscode";
    for (const node of chain) {
      if (node && node.name && classifyBuild(node.name)) {
        launchScheme = schemeForBinaryName(node.name);
        break;
      }
    }
    const toastLaunchUri = `${launchScheme}://dimokol.claude-notifications/click?marker=${encodeURIComponent(clickMarkerB64)}`;
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
