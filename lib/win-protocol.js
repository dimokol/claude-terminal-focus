// lib/win-protocol.js — claude-notif:// URI scheme + HKCU registry CRUD.
//
// Used by three places:
//   - hook.js (Windows branch): buildLaunchUri to put the click payload
//     into the toast's launch="..." attribute as a base64 query param.
//   - bin/win-click-handler.js (the bundled launcher): parseLaunchUri to
//     decode the marker on click.
//   - extension.js (Windows activation): installWinProtocol writes the
//     launcher file under %LOCALAPPDATA% and registers the HKCU keys;
//     uninstallWinProtocol removes them.
//
// Self-heal: installWinProtocol is called on every extension activation
// and overwrites the registry value with the current launcher + node
// paths, so reinstalls/updates never leave a stale or duplicate handler.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROTOCOL_SCHEME = 'claude-notif';
const REGISTRY_ROOT = 'HKCU\\Software\\Classes\\claude-notif';

function buildLaunchUri(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return `${PROTOCOL_SCHEME}://click?marker=${encodeURIComponent(b64)}`;
}

function parseLaunchUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(`${PROTOCOL_SCHEME}://`)) return null;
  const m = uri.match(/[?&]marker=([^&]+)/);
  if (!m) return null;
  let json;
  try {
    const b64 = decodeURIComponent(m[1]);
    json = Buffer.from(b64, 'base64').toString('utf8');
    if (!json.startsWith('{')) return null;
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
  // Empty "URL Protocol" value is required by Windows for a key to be
  // recognized as a registered URI scheme handler.
  //
  // Shell command: when hideVbsPath is supplied, we launch through
  // wscript.exe (a windowless host) running our hide.vbs wrapper, which
  // in turn spawns node.exe with Run window-style 0 (hidden). This is
  // the only way to prevent a Node console window from flashing every
  // time the user clicks the toast — node.exe is a console-subsystem
  // binary, so Windows ALWAYS allocates a console window for it unless
  // the parent suppressed it via CreateProcess flags (which the OS
  // shell does not do when invoking URL handlers). wscript.exe IS a
  // windowless host, and its WScript.Shell.Run with intWindowStyle=0
  // properly suppresses the child window.
  //
  // Fallback: if hideVbsPath isn't available (older builds, missing
  // asset), fall back to the legacy direct-node command. That keeps
  // click-to-focus functional even when the .vbs wrapper is absent —
  // the only cost is the cosmetic console-window flash.
  const shellCommand = hideVbsPath
    ? `wscript.exe "${hideVbsPath}" "${nodeExe}" "${launcherPath}" "%1"`
    : `"${nodeExe}" "${launcherPath}" "%1"`;
  return [
    {
      bin: 'reg.exe',
      args: [
        'ADD', REGISTRY_ROOT,
        '/ve', '/t', 'REG_SZ',
        '/d', 'URL:Claude Notifications Click Handler',
        '/f'
      ]
    },
    {
      bin: 'reg.exe',
      args: [
        'ADD', REGISTRY_ROOT,
        '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '',
        '/f'
      ]
    },
    {
      bin: 'reg.exe',
      args: [
        'ADD', `${REGISTRY_ROOT}\\shell\\open\\command`,
        '/ve', '/t', 'REG_SZ',
        '/d', shellCommand,
        '/f'
      ]
    }
  ];
}

function buildUnregisterCommand() {
  return {
    bin: 'reg.exe',
    args: ['DELETE', REGISTRY_ROOT, '/f']
  };
}

function getLauncherDir(env = process.env, home = os.homedir()) {
  const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return path.join(base, 'claude-notifications');
}

function getLauncherPath(env = process.env, home = os.homedir()) {
  return path.join(getLauncherDir(env, home), 'win-click-handler.js');
}

function resolveNodeExe() {
  try {
    const out = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true });
    if (out.status === 0 && out.stdout) {
      const first = out.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch (_) {}
  return 'node.exe';
}

function defaultRunReg(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
}

function installWinProtocol({
  bundledLauncherPath,
  bundledHideVbsPath,
  launcherSource,
  hideVbsSource,
  nodeExe,
  env = process.env,
  home = os.homedir(),
  fsLike = fs,
  runRegLike = defaultRunReg
} = {}) {
  const launcherDir = getLauncherDir(env, home);
  const launcherPath = path.join(launcherDir, 'win-click-handler.js');
  const hideVbsPath = path.join(launcherDir, 'hide.vbs');
  const resolvedNode = nodeExe || resolveNodeExe();

  try {
    fsLike.mkdirSync(launcherDir, { recursive: true });
    const source = launcherSource != null
      ? launcherSource
      : fs.readFileSync(bundledLauncherPath, 'utf8');
    fsLike.writeFileSync(launcherPath, source);
  } catch (e) {
    return { ok: false, error: `write launcher: ${e.message}` };
  }

  // Copy hide.vbs alongside the launcher. If the asset is missing
  // (older build, or bundle stripped), we skip the wscript wrapper and
  // fall back to direct-node invocation — registry handler still works,
  // just with the cosmetic console-window flash.
  let hideVbsAvailable = false;
  try {
    let vbsContent = hideVbsSource;
    if (vbsContent == null && bundledHideVbsPath && fs.existsSync(bundledHideVbsPath)) {
      vbsContent = fs.readFileSync(bundledHideVbsPath, 'utf8');
    }
    if (vbsContent != null) {
      fsLike.writeFileSync(hideVbsPath, vbsContent);
      hideVbsAvailable = true;
    }
  } catch (_) {
    // Non-fatal — continue without the wrapper.
  }

  const cmds = buildRegisterCommands({
    nodeExe: resolvedNode,
    launcherPath,
    hideVbsPath: hideVbsAvailable ? hideVbsPath : undefined
  });
  for (const cmd of cmds) {
    const res = runRegLike(cmd.bin, cmd.args);
    if (!res || res.status !== 0) {
      return { ok: false, error: `reg ${cmd.args[0]}: ${(res && res.stderr) || 'unknown error'}` };
    }
  }

  return { ok: true, launcherPath, hideVbsPath: hideVbsAvailable ? hideVbsPath : null, nodeExe: resolvedNode };
}

function uninstallWinProtocol({ runRegLike = defaultRunReg } = {}) {
  const cmd = buildUnregisterCommand();
  const res = runRegLike(cmd.bin, cmd.args);
  if (!res) return { ok: false, error: 'no result from reg.exe' };
  if (res.status === 0) return { ok: true };
  if (res.stderr && /unable to find the specified registry key/i.test(res.stderr)) {
    return { ok: true };
  }
  return { ok: false, error: res.stderr || `exit ${res.status}` };
}

module.exports = {
  PROTOCOL_SCHEME,
  REGISTRY_ROOT,
  buildLaunchUri,
  parseLaunchUri,
  buildRegisterCommands,
  buildUnregisterCommand,
  installWinProtocol,
  uninstallWinProtocol,
  getLauncherDir,
  getLauncherPath,
  resolveNodeExe
};
