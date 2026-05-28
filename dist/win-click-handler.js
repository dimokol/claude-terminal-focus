#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/win-protocol.js
var require_win_protocol = __commonJS({
  "lib/win-protocol.js"(exports2, module2) {
    var fs2 = require("fs");
    var os2 = require("os");
    var path2 = require("path");
    var { spawnSync: spawnSync2 } = require("child_process");
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
    function buildRegisterCommands({ nodeExe, launcherPath, hideVbsPath }) {
      const shellCommand = hideVbsPath ? `wscript.exe "${hideVbsPath}" "${nodeExe}" "${launcherPath}" "%1"` : `"${nodeExe}" "${launcherPath}" "%1"`;
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
    function getLauncherDir(env = process.env, home = os2.homedir()) {
      const base = env.LOCALAPPDATA || path2.join(home, "AppData", "Local");
      return path2.join(base, "claude-notifications");
    }
    function getLauncherPath(env = process.env, home = os2.homedir()) {
      return path2.join(getLauncherDir(env, home), "win-click-handler.js");
    }
    function resolveNodeExe() {
      try {
        const out = spawnSync2("where", ["node"], { encoding: "utf8", windowsHide: true });
        if (out.status === 0 && out.stdout) {
          const first = out.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
          if (first) return first;
        }
      } catch (_) {
      }
      return "node.exe";
    }
    function defaultRunReg(bin, args) {
      return spawnSync2(bin, args, { encoding: "utf8", windowsHide: true });
    }
    function installWinProtocol({
      bundledLauncherPath,
      bundledHideVbsPath,
      launcherSource,
      hideVbsSource,
      nodeExe,
      env = process.env,
      home = os2.homedir(),
      fsLike = fs2,
      runRegLike = defaultRunReg
    } = {}) {
      const launcherDir = getLauncherDir(env, home);
      const launcherPath = path2.join(launcherDir, "win-click-handler.js");
      const hideVbsPath = path2.join(launcherDir, "hide.vbs");
      const resolvedNode = nodeExe || resolveNodeExe();
      try {
        fsLike.mkdirSync(launcherDir, { recursive: true });
        const source = launcherSource != null ? launcherSource : fs2.readFileSync(bundledLauncherPath, "utf8");
        fsLike.writeFileSync(launcherPath, source);
      } catch (e) {
        return { ok: false, error: `write launcher: ${e.message}` };
      }
      let hideVbsAvailable = false;
      try {
        let vbsContent = hideVbsSource;
        if (vbsContent == null && bundledHideVbsPath && fs2.existsSync(bundledHideVbsPath)) {
          vbsContent = fs2.readFileSync(bundledHideVbsPath, "utf8");
        }
        if (vbsContent != null) {
          fsLike.writeFileSync(hideVbsPath, vbsContent);
          hideVbsAvailable = true;
        }
      } catch (_) {
      }
      const cmds = buildRegisterCommands({
        nodeExe: resolvedNode,
        launcherPath,
        hideVbsPath: hideVbsAvailable ? hideVbsPath : void 0
      });
      for (const cmd of cmds) {
        const res = runRegLike(cmd.bin, cmd.args);
        if (!res || res.status !== 0) {
          return { ok: false, error: `reg ${cmd.args[0]}: ${res && res.stderr || "unknown error"}` };
        }
      }
      return { ok: true, launcherPath, hideVbsPath: hideVbsAvailable ? hideVbsPath : null, nodeExe: resolvedNode };
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

// lib/process-tree.js
var require_process_tree = __commonJS({
  "lib/process-tree.js"(exports2, module2) {
    var { execSync } = require("child_process");
    var WALK_UP_LIMIT = 30;
    function snapshot2() {
      if (process.platform === "win32") {
        return snapshotWindows();
      }
      return snapshotPosix();
    }
    function snapshotWindows() {
      try {
        const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`;
        const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
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
        const out = execSync(
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
        const out = execSync("ps -A -o pid=,ppid=,comm=", {
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
    function walkUp(snapshotResult, pid, limit = WALK_UP_LIMIT) {
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
      snapshot: snapshot2,
      walkUp,
      walkDown,
      // Exposed for tests:
      parsePowerShellJson,
      parseWmicCsv,
      parsePsOutput,
      WALK_UP_LIMIT
    };
  }
});

// lib/code-instance-resolver.js
var require_code_instance_resolver = __commonJS({
  "lib/code-instance-resolver.js"(exports2, module2) {
    "use strict";
    var VS_CODE_BINARY_PATTERN = /^(Code( - Insiders)?|VSCodium|Codium|Cursor|Windsurf)\.exe$/i;
    var DEFAULT_MAX_DEPTH = 30;
    function isVsCodeBinary(name) {
      if (typeof name !== "string") return false;
      return VS_CODE_BINARY_PATTERN.test(name);
    }
    function findCodeAncestorPid(startPid, procs, maxDepth = DEFAULT_MAX_DEPTH) {
      if (!procs || typeof procs.get !== "function") return 0;
      if (!Number.isInteger(startPid) || startPid <= 0) return 0;
      let current = startPid;
      const seen = /* @__PURE__ */ new Set();
      for (let i = 0; i < maxDepth; i++) {
        if (seen.has(current)) return 0;
        seen.add(current);
        const node = procs.get(current);
        if (!node) return 0;
        if (isVsCodeBinary(node.name)) return node.pid;
        if (!node.ppid || node.ppid === current) return 0;
        current = node.ppid;
      }
      return 0;
    }
    function resolveCodeInstancePid2(pids, snapshot2, maxDepth = DEFAULT_MAX_DEPTH) {
      if (!Array.isArray(pids) || pids.length === 0) return 0;
      if (!snapshot2 || !snapshot2.procs) return 0;
      let bestPid = 0;
      let bestDepth = Infinity;
      for (const startPid of pids) {
        if (!Number.isInteger(startPid) || startPid <= 0) continue;
        let current = startPid;
        let depth = 0;
        const seen = /* @__PURE__ */ new Set();
        while (depth < maxDepth) {
          if (seen.has(current)) break;
          seen.add(current);
          const node = snapshot2.procs.get(current);
          if (!node) break;
          if (isVsCodeBinary(node.name)) {
            if (depth < bestDepth) {
              bestPid = node.pid;
              bestDepth = depth;
            }
            break;
          }
          if (!node.ppid || node.ppid === current) break;
          current = node.ppid;
          depth++;
        }
      }
      return bestPid;
    }
    function resolveCodeInstancePids(pids, snapshot2, maxDepth = DEFAULT_MAX_DEPTH) {
      if (!Array.isArray(pids) || pids.length === 0) return [];
      if (!snapshot2 || !snapshot2.procs) return [];
      const found = [];
      const pushUnique = (p) => {
        if (!found.includes(p)) found.push(p);
      };
      for (const startPid of pids) {
        if (!Number.isInteger(startPid) || startPid <= 0) continue;
        let current = startPid;
        let depth = 0;
        const seen = /* @__PURE__ */ new Set();
        while (depth < maxDepth) {
          if (seen.has(current)) break;
          seen.add(current);
          const node = snapshot2.procs.get(current);
          if (!node) break;
          if (isVsCodeBinary(node.name)) {
            pushUnique(node.pid);
          }
          if (!node.ppid || node.ppid === current) break;
          current = node.ppid;
          depth++;
        }
      }
      return found;
    }
    module2.exports = {
      VS_CODE_BINARY_PATTERN,
      isVsCodeBinary,
      findCodeAncestorPid,
      resolveCodeInstancePid: resolveCodeInstancePid2,
      resolveCodeInstancePids,
      DEFAULT_MAX_DEPTH
    };
  }
});

// lib/win-focus.js
var require_win_focus = __commonJS({
  "lib/win-focus.js"(exports2, module2) {
    "use strict";
    var { spawnSync: spawnSync2, spawn: spawn2 } = require("child_process");
    function normalizePids(pidOrPids) {
      const arr = Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids];
      return arr.filter((p) => Number.isInteger(p) && p > 0);
    }
    function buildPsScript(pidOrPids) {
      const pids = normalizePids(pidOrPids);
      const pidList = pids.join(",");
      return `
$ErrorActionPreference = 'Stop'
$targetPids = @(${pidList})

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CN_Win32 {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  // SendInput (not the legacy keybd_event) is the call Chromium/Electron use
  // to satisfy SetForegroundWindow's "received the last input event" rule.
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inp, int cb);
  public static void TapAlt() {
    INPUT[] inp = new INPUT[2];
    inp[0].type = 1; inp[0].u.ki.wVk = 0x12;                 // VK_MENU down
    inp[1].type = 1; inp[1].u.ki.wVk = 0x12; inp[1].u.ki.dwFlags = 0x0002; // VK_MENU up (KEYEVENTF_KEYUP)
    SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

$found = [IntPtr]::Zero
$foundPid = [uint32]0
$cb = [CN_Win32+EnumWindowsProc] {
  param([IntPtr]$hwnd, [IntPtr]$lParam)
  if (-not [CN_Win32]::IsWindowVisible($hwnd)) { return $true }
  if ([CN_Win32]::GetWindowTextLength($hwnd) -eq 0) { return $true }
  $wpid = [uint32]0
  [CN_Win32]::GetWindowThreadProcessId($hwnd, [ref]$wpid) | Out-Null
  if ($targetPids -contains $wpid) {
    Set-Variable -Scope 1 -Name found -Value $hwnd
    Set-Variable -Scope 1 -Name foundPid -Value $wpid
    return $false
  }
  return $true
}

[CN_Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($found -eq [IntPtr]::Zero) {
  Write-Error "no visible window for pids ${pidList}"
  exit 2
}

$currentThread = [CN_Win32]::GetCurrentThreadId()
$ok = $false

# Retry while the foreground settles, re-reading it each pass, then SendInput
# Alt-tap + SetForegroundWindow. $ok is verified against GetForegroundWindow,
# not the (unreliable) SetForegroundWindow return value.
#
# NOTE: this helper currently has NO caller in the toast-click path \u2014 the
# OS-banner-click foreground raise was investigated exhaustively and shown to
# be blocked by ShellExperienceHost (and gated by ForegroundLockTimeout); see
# docs/windows-banner-focus-handoff.md. It is retained, proven-correct in
# non-toast contexts, for bin/win-click-handler.js and any future attempt.
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  [CN_Win32]::AllowSetForegroundWindow($foundPid) | Out-Null
  $fgHwnd = [CN_Win32]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [CN_Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $currentThread) {
    $attached = [CN_Win32]::AttachThreadInput($currentThread, $fgThread, $true)
  }
  try {
    if ([CN_Win32]::IsIconic($found)) { [CN_Win32]::ShowWindow($found, 9) | Out-Null }
    [CN_Win32]::TapAlt()
    [CN_Win32]::BringWindowToTop($found) | Out-Null
    [CN_Win32]::SetForegroundWindow($found) | Out-Null
  } finally {
    if ($attached) { [CN_Win32]::AttachThreadInput($currentThread, $fgThread, $false) | Out-Null }
  }
  Start-Sleep -Milliseconds 40
  $ok = ([CN_Win32]::GetForegroundWindow() -eq $found)
  if (-not $ok) { Start-Sleep -Milliseconds 110 }
}

if (-not $ok) {
  Write-Error "SetForegroundWindow failed"
  exit 3
}
exit 0
`.trim();
    }
    function focusHwndByPid2(pidOrPids, budgetMs = 2e3) {
      const pids = normalizePids(pidOrPids);
      if (pids.length === 0) return false;
      try {
        const res = spawnSync2("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          buildPsScript(pids)
        ], {
          windowsHide: true,
          timeout: budgetMs,
          stdio: ["ignore", "ignore", "pipe"]
        });
        return res && res.status === 0;
      } catch (_) {
        return false;
      }
    }
    function focusHwndByPidAsync(pidOrPids) {
      const pids = normalizePids(pidOrPids);
      if (pids.length === 0) return false;
      try {
        const child = spawn2("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          buildPsScript(pids)
        ], {
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
        return true;
      } catch (_) {
        return false;
      }
    }
    module2.exports = {
      buildPsScript,
      focusHwndByPid: focusHwndByPid2,
      focusHwndByPidAsync
    };
  }
});

// bin/win-click-handler.js
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawn, spawnSync } = require("child_process");
var { parseLaunchUri } = require_win_protocol();
var { getClickedPath } = require_state_paths();
var { snapshot } = require_process_tree();
var { resolveCodeInstancePid } = require_code_instance_resolver();
var FOCUS_BUDGET_MS = 3e3;
var CONFIG_PATH = path.join(os.homedir(), ".claude", "claude-notifications-config.json");
function extractPayload(uri) {
  if (typeof uri !== "string" || uri === "") return null;
  const payload = parseLaunchUri(uri);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.workspaceRoot !== "string" || payload.workspaceRoot === "") return null;
  return payload;
}
function readWindowsClickBehavior() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.windowsClickBehavior === "cli" || cfg.windowsClickBehavior === "hwnd") {
      return cfg.windowsClickBehavior;
    }
  } catch (_) {
  }
  return "hwnd";
}
function writeClickMarker(payload) {
  payload.timestamp = Date.now();
  try {
    const clickedPath = getClickedPath(payload.workspaceRoot);
    fs.mkdirSync(path.dirname(clickedPath), { recursive: true });
    fs.writeFileSync(clickedPath, JSON.stringify(payload));
  } catch (_) {
  }
}
function focusHwndByPid(targetPid, budgetMs) {
  const { focusHwndByPid: shared } = require_win_focus();
  return shared(targetPid, budgetMs);
}
function spawnCodeFallback(workspaceRoot) {
  try {
    const quotedPath = '"' + workspaceRoot.replace(/"/g, '\\"') + '"';
    const child = spawn("code " + quotedPath, {
      detached: true,
      stdio: "ignore",
      shell: true,
      windowsHide: true
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}
function focusInstance(payload) {
  const behavior = readWindowsClickBehavior();
  if (behavior === "cli") {
    spawnCodeFallback(payload.workspaceRoot);
    return;
  }
  try {
    const startedAt = Date.now();
    const snap = snapshot();
    if (snap && snap.procs && Array.isArray(payload.pids)) {
      const targetPid = resolveCodeInstancePid(payload.pids, snap);
      if (targetPid > 0) {
        const remaining = Math.max(500, FOCUS_BUDGET_MS - (Date.now() - startedAt));
        if (focusHwndByPid(targetPid, remaining)) return;
      }
    }
  } catch (_) {
  }
  spawnCodeFallback(payload.workspaceRoot);
}
function main() {
  const payload = extractPayload(process.argv[2]);
  if (!payload) process.exit(0);
  writeClickMarker(payload);
  focusInstance(payload);
  process.exit(0);
}
if (require.main === module) {
  main();
}
module.exports = {
  extractPayload,
  readWindowsClickBehavior,
  writeClickMarker,
  focusHwndByPid,
  spawnCodeFallback,
  focusInstance,
  CONFIG_PATH,
  FOCUS_BUDGET_MS
};
