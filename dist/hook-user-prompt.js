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
    function hashWorkspace(workspaceRoot) {
      return crypto.createHash("sha1").update(String(workspaceRoot)).digest("hex").slice(0, 12);
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
    function advanceOnPrompt2(workspaceRoot, sessionId) {
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
      advanceOnPrompt: advanceOnPrompt2,
      markResolved,
      _readSessions: readSessions
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
