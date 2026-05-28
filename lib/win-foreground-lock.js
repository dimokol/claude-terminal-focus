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

module.exports = {
  FLT_REG_PATH,
  FLT_VALUE_NAME,
  buildReadCommand,
  buildWriteCommand,
  parseFltQuery,
  defaultRunReg
};
