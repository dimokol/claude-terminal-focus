#!/usr/bin/env node
"use strict";

// bin/hook-wrapper.cjs
var fs = require("fs");
var path = require("path");
var os = require("os");
function pathExistsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}
function discoverProfiles(home) {
  const result = [];
  let entries;
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch (_) {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name !== ".claude" && !name.startsWith(".claude-")) continue;
    if (name.toLowerCase().startsWith(".claude-backup")) continue;
    const sp = path.join(home, name, "settings.json");
    if (pathExistsSync(sp)) result.push(sp);
  }
  return result;
}
function stripFromSettings(settingsPath, identifierSubstrings) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (_) {
    return false;
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch (_) {
    return false;
  }
  if (!s.hooks || typeof s.hooks !== "object") return false;
  let changed = false;
  for (const ev of Object.keys(s.hooks)) {
    const groups = s.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const g of groups) {
      const hooks = Array.isArray(g.hooks) ? g.hooks.filter((h) => {
        const matches = h && typeof h.command === "string" && identifierSubstrings.some((sub) => h.command.includes(sub));
        if (matches) changed = true;
        return !matches;
      }) : [];
      if (hooks.length) keptGroups.push(Object.assign({}, g, { hooks }));
    }
    if (keptGroups.length) s.hooks[ev] = keptGroups;
    else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  if (changed) {
    const tmp = settingsPath + ".cn-cleanup-tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, settingsPath);
  }
  return changed;
}
var SELF_IDENTIFIERS = [
  "claude-notifications/hook.cjs",
  "claude-notifications\\hook.cjs",
  "claude-notifications/hook-user-prompt.cjs",
  "claude-notifications\\hook-user-prompt.cjs",
  "dimokol.claude-notifications",
  "dimokol.claude-terminal-focus"
];
function selfDestruct({ home = os.homedir(), wrapperDir = __dirname } = {}) {
  for (const sp of discoverProfiles(home)) {
    try {
      stripFromSettings(sp, SELF_IDENTIFIERS);
    } catch (_) {
    }
    try {
      fs.rmSync(sp + ".backup", { force: true });
    } catch (_) {
    }
  }
  try {
    fs.rmSync(path.join(home, ".claude", "focus-state"), { recursive: true, force: true });
  } catch (_) {
  }
  if (process.platform === "win32") {
    try {
      const { spawnSync } = require("child_process");
      spawnSync("reg.exe", ["DELETE", "HKCU\\Software\\Classes\\claude-notif", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
    } catch (_) {
    }
    try {
      const lad = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      fs.rmSync(path.join(lad, "claude-notifications"), { recursive: true, force: true });
    } catch (_) {
    }
  }
  if (process.platform === "win32") {
    try {
      const { spawn } = require("child_process");
      const c = spawn("cmd.exe", [
        "/c",
        "timeout",
        "/t",
        "2",
        "/nobreak",
        ">nul",
        "&",
        "rmdir",
        "/s",
        "/q",
        `"${wrapperDir}"`
      ], { detached: true, stdio: "ignore", windowsHide: true });
      c.unref();
    } catch (_) {
    }
  } else {
    try {
      fs.rmSync(wrapperDir, { recursive: true, force: true });
    } catch (_) {
    }
  }
}
function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
function findNewestExtensionHook(recordedPath, isUserPrompt, fsLike = fs) {
  if (typeof recordedPath !== "string" || recordedPath === "") return null;
  try {
    const extRoot = path.dirname(path.dirname(path.dirname(recordedPath)));
    const prefix = "dimokol.claude-notifications-";
    const file = isUserPrompt ? "hook-user-prompt.js" : "hook.js";
    let entries;
    try {
      entries = fsLike.readdirSync(extRoot, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    const candidates = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
      const hookPath = path.join(extRoot, e.name, "dist", file);
      let exists = false;
      try {
        fsLike.accessSync(hookPath);
        exists = true;
      } catch (_) {
      }
      if (exists) candidates.push({ version: e.name.slice(prefix.length), hookPath, dir: path.join(extRoot, e.name) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => compareVersions(b.version, a.version));
    return candidates[0];
  } catch (_) {
    return null;
  }
}
function main() {
  const stateFile = path.join(__dirname, "state.json");
  const isUserPrompt = path.basename(__filename) === "hook-user-prompt.cjs";
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (_) {
    process.exit(0);
  }
  let target = isUserPrompt ? state.extensionUserPromptHookPath : state.extensionHookPath;
  if (!target || !pathExistsSync(target)) {
    const recorded = state.extensionHookPath || state.extensionUserPromptHookPath || "";
    const newest = findNewestExtensionHook(recorded, isUserPrompt);
    if (newest) {
      target = newest.hookPath;
      try {
        state.extensionHookPath = path.join(newest.dir, "dist", "hook.js");
        state.extensionUserPromptHookPath = path.join(newest.dir, "dist", "hook-user-prompt.js");
        state.extensionVersion = newest.version;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      } catch (_) {
      }
    } else {
      try {
        selfDestruct();
      } catch (_) {
      }
      process.exit(0);
    }
  }
  try {
    require(target);
  } catch (e) {
    try {
      fs.appendFileSync(
        path.join(__dirname, "errors.log"),
        `[${(/* @__PURE__ */ new Date()).toISOString()}] ${isUserPrompt ? "user-prompt" : "hook"}: ${e.stack || e.message}
`
      );
    } catch (_) {
    }
    process.exit(0);
  }
}
if (require.main === module) {
  main();
}
module.exports = {
  pathExistsSync,
  discoverProfiles,
  stripFromSettings,
  selfDestruct,
  compareVersions,
  findNewestExtensionHook,
  SELF_IDENTIFIERS,
  main
};
