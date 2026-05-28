#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/state-paths.js
var require_state_paths = __commonJS({
  "lib/state-paths.js"(exports2, module2) {
    var crypto = require("crypto");
    var os = require("os");
    var path2 = require("path");
    var STATE_ROOT = path2.join(os.homedir(), ".claude", "focus-state");
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
    function getSignalPath(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "signal");
    }
    function getClickedPath(workspaceRoot) {
      return path2.join(getStateDir2(workspaceRoot), "clicked");
    }
    function getClaimedPath(workspaceRoot) {
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
      getSignalPath,
      getClickedPath,
      getClaimedPath,
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
    function advanceOnPrompt2(workspaceRoot, sessionId) {
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
      advanceOnPrompt: advanceOnPrompt2,
      markResolved,
      _readSessions: readSessions,
      // Exposed for tests:
      acquireLock,
      releaseLock
    };
  }
});

// hook-user-prompt.js
var fs = require("fs");
var path = require("path");
var { getStateDir } = require_state_paths();
var { advanceOnPrompt } = require_stage_dedup();
(() => {
  let sessionId = "";
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    sessionId = typeof input.session_id === "string" ? input.session_id : "";
  } catch (_) {
    process.exit(0);
  }
  if (!sessionId) process.exit(0);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
  fs.mkdirSync(getStateDir(workspaceRoot), { recursive: true });
  advanceOnPrompt(workspaceRoot, sessionId);
})();
