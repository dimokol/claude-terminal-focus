// lib/win-foreground-lock.js — read/set HKCU ForegroundLockTimeout.
//
// Why this exists: while ForegroundLockTimeout is non-zero (Windows default
// 200000ms), the OS forbids background processes from calling
// SetForegroundWindow — they only get a taskbar flash. Our OS-banner click
// handler runs in the (background) extension host, so it cannot raise VS
// Code over a fullscreen app until this is 0. Verified 2026-05-28: a plain
// registry write to 0 applies LIVE (no re-login) for SetForegroundWindow on
// Win10. SystemParametersInfo broadcast is best-effort (it returned
// ACCESS_DENIED on the test machine yet the registry write still took
// effect live), so we never depend on it.
//
// Pure builders + parser are testable on any platform; the spawn wrappers
// take an injectable runner.

'use strict';

const { spawnSync } = require('child_process');

const FLT_REG_PATH = 'HKCU\\Control Panel\\Desktop';
const FLT_VALUE_NAME = 'ForegroundLockTimeout';

function buildReadCommand() {
  return { bin: 'reg.exe', args: ['query', FLT_REG_PATH, '/v', FLT_VALUE_NAME] };
}

function buildWriteCommand(value) {
  return {
    bin: 'reg.exe',
    args: ['add', FLT_REG_PATH, '/v', FLT_VALUE_NAME, '/t', 'REG_DWORD', '/d', String(value >>> 0), '/f']
  };
}

// Parse `reg query` stdout → integer value, or null if not present/parseable.
function parseFltQuery(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const m = stdout.match(/ForegroundLockTimeout\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) ? n : null;
}

function defaultRunReg(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
}

function getForegroundLockTimeout({ runRegLike = defaultRunReg } = {}) {
  const cmd = buildReadCommand();
  let res;
  try { res = runRegLike(cmd.bin, cmd.args); } catch (_) { return null; }
  if (!res || res.status !== 0) return null;
  return parseFltQuery(res.stdout || '');
}

// Write the value via reg.exe, then best-effort broadcast via
// SystemParametersInfo so it applies live without a re-login. The reg write
// is the source of truth (proven to apply live on Win10); the SPI broadcast
// is allowed to fail silently.
function setForegroundLockTimeout(value, { runRegLike = defaultRunReg, broadcast = broadcastSpi } = {}) {
  const cmd = buildWriteCommand(value);
  let res;
  try { res = runRegLike(cmd.bin, cmd.args); } catch (e) { return { ok: false, error: e.message }; }
  if (!res || res.status !== 0) {
    return { ok: false, error: (res && res.stderr) || `reg add exit ${res && res.status}` };
  }
  try { broadcast(value); } catch (_) {}
  return { ok: true };
}

// Best-effort live broadcast. SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001.
// Spawned through PowerShell P/Invoke; failures are non-fatal. Guarded to
// win32 so tests on other platforms (and the spawn) never run off-Windows.
function broadcastSpi(value) {
  if (process.platform !== 'win32') return;
  const ps = `
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class CN_SPI { [DllImport("user32.dll",SetLastError=true)] public static extern bool SystemParametersInfo(uint a,uint b,UIntPtr c,uint d); }
"@
[CN_SPI]::SystemParametersInfo(0x2001, 0, [UIntPtr]::new(${value >>> 0}), 3) | Out-Null
`.trim();
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    windowsHide: true, timeout: 3000, stdio: 'ignore'
  });
}

module.exports = {
  FLT_REG_PATH,
  FLT_VALUE_NAME,
  buildReadCommand,
  buildWriteCommand,
  parseFltQuery,
  defaultRunReg,
  getForegroundLockTimeout,
  setForegroundLockTimeout
};
