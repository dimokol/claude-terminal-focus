#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/win-protocol.js
var require_win_protocol = __commonJS({
  "lib/win-protocol.js"(exports2, module2) {
    var fs2 = require("fs");
    var os = require("os");
    var path2 = require("path");
    var { spawnSync } = require("child_process");
    var PROTOCOL_SCHEME = "claude-notif";
    var REGISTRY_ROOT = "HKCU\\Software\\Classes\\claude-notif";
    function buildLaunchUri(payload) {
      const json = JSON.stringify(payload);
      const b64 = Buffer.from(json, "utf8").toString("base64");
      return `${PROTOCOL_SCHEME}://click?marker=${encodeURIComponent(b64)}`;
    }
    function parseLaunchUri2(uri) {
      if (typeof uri !== "string" || !uri.startsWith(`${PROTOCOL_SCHEME}://`)) return null;
      const m = uri.match(/[?&]marker=([^&]+)/);
      if (!m) return null;
      let json;
      try {
        const b64 = decodeURIComponent(m[1]);
        json = Buffer.from(b64, "base64").toString("utf8");
        if (!json.startsWith("{")) return null;
      } catch (_) {
        return null;
      }
      try {
        return JSON.parse(json);
      } catch (_) {
        return null;
      }
    }
    function buildRegisterCommands({ nodeExe, launcherPath }) {
      const shellCommand = `"${nodeExe}" "${launcherPath}" "%1"`;
      return [
        {
          bin: "reg.exe",
          args: [
            "ADD",
            REGISTRY_ROOT,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            "URL:Claude Notifications Click Handler",
            "/f"
          ]
        },
        {
          bin: "reg.exe",
          args: [
            "ADD",
            REGISTRY_ROOT,
            "/v",
            "URL Protocol",
            "/t",
            "REG_SZ",
            "/d",
            "",
            "/f"
          ]
        },
        {
          bin: "reg.exe",
          args: [
            "ADD",
            `${REGISTRY_ROOT}\\shell\\open\\command`,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            shellCommand,
            "/f"
          ]
        }
      ];
    }
    function buildUnregisterCommand() {
      return {
        bin: "reg.exe",
        args: ["DELETE", REGISTRY_ROOT, "/f"]
      };
    }
    function getLauncherDir(env = process.env, home = os.homedir()) {
      const base = env.LOCALAPPDATA || path2.join(home, "AppData", "Local");
      return path2.join(base, "claude-notifications");
    }
    function getLauncherPath(env = process.env, home = os.homedir()) {
      return path2.join(getLauncherDir(env, home), "win-click-handler.js");
    }
    function resolveNodeExe() {
      try {
        const out = spawnSync("where", ["node"], { encoding: "utf8", windowsHide: true });
        if (out.status === 0 && out.stdout) {
          const first = out.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
          if (first) return first;
        }
      } catch (_) {
      }
      return "node.exe";
    }
    function defaultRunReg(bin, args) {
      return spawnSync(bin, args, { encoding: "utf8", windowsHide: true });
    }
    function installWinProtocol({
      bundledLauncherPath,
      launcherSource,
      nodeExe,
      env = process.env,
      home = os.homedir(),
      fsLike = fs2,
      runRegLike = defaultRunReg
    } = {}) {
      const launcherDir = getLauncherDir(env, home);
      const launcherPath = path2.join(launcherDir, "win-click-handler.js");
      const resolvedNode = nodeExe || resolveNodeExe();
      try {
        fsLike.mkdirSync(launcherDir, { recursive: true });
        const source = launcherSource != null ? launcherSource : fs2.readFileSync(bundledLauncherPath, "utf8");
        fsLike.writeFileSync(launcherPath, source);
      } catch (e) {
        return { ok: false, error: `write launcher: ${e.message}` };
      }
      const cmds = buildRegisterCommands({ nodeExe: resolvedNode, launcherPath });
      for (const cmd of cmds) {
        const res = runRegLike(cmd.bin, cmd.args);
        if (!res || res.status !== 0) {
          return { ok: false, error: `reg ${cmd.args[0]}: ${res && res.stderr || "unknown error"}` };
        }
      }
      return { ok: true, launcherPath, nodeExe: resolvedNode };
    }
    function uninstallWinProtocol({ runRegLike = defaultRunReg } = {}) {
      const cmd = buildUnregisterCommand();
      const res = runRegLike(cmd.bin, cmd.args);
      if (!res) return { ok: false, error: "no result from reg.exe" };
      if (res.status === 0) return { ok: true };
      if (res.stderr && /unable to find the specified registry key/i.test(res.stderr)) {
        return { ok: true };
      }
      return { ok: false, error: res.stderr || `exit ${res.status}` };
    }
    module2.exports = {
      PROTOCOL_SCHEME,
      REGISTRY_ROOT,
      buildLaunchUri,
      parseLaunchUri: parseLaunchUri2,
      buildRegisterCommands,
      buildUnregisterCommand,
      installWinProtocol,
      uninstallWinProtocol,
      getLauncherDir,
      getLauncherPath,
      resolveNodeExe
    };
  }
});

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
    function getStateDir(workspaceRoot) {
      return path2.join(STATE_ROOT, hashWorkspace(workspaceRoot));
    }
    function getSignalPath(workspaceRoot) {
      return path2.join(getStateDir(workspaceRoot), "signal");
    }
    function getClickedPath2(workspaceRoot) {
      return path2.join(getStateDir(workspaceRoot), "clicked");
    }
    function getClaimedPath(workspaceRoot) {
      return path2.join(getStateDir(workspaceRoot), "claimed");
    }
    function getSessionsPath(workspaceRoot) {
      return path2.join(getStateDir(workspaceRoot), "sessions");
    }
    module2.exports = {
      STATE_ROOT,
      hashWorkspace,
      normalizeWorkspaceRoot,
      getStateDir,
      getSignalPath,
      getClickedPath: getClickedPath2,
      getClaimedPath,
      getSessionsPath
    };
  }
});

// bin/win-click-handler.js
var fs = require("fs");
var path = require("path");
var { spawn } = require("child_process");
var { parseLaunchUri } = require_win_protocol();
var { getClickedPath } = require_state_paths();
function extractPayload(uri) {
  if (typeof uri !== "string" || uri === "") return null;
  const payload = parseLaunchUri(uri);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.workspaceRoot !== "string" || payload.workspaceRoot === "") return null;
  return payload;
}
function main() {
  const payload = extractPayload(process.argv[2]);
  if (!payload) process.exit(0);
  payload.timestamp = Date.now();
  try {
    const clickedPath = getClickedPath(payload.workspaceRoot);
    fs.mkdirSync(path.dirname(clickedPath), { recursive: true });
    fs.writeFileSync(clickedPath, JSON.stringify(payload));
  } catch (_) {
  }
  try {
    const child = spawn("code", [payload.workspaceRoot], {
      detached: true,
      stdio: "ignore",
      shell: true,
      windowsHide: true
    });
    child.unref();
  } catch (_) {
  }
  process.exit(0);
}
if (require.main === module) {
  main();
}
module.exports = { extractPayload };
