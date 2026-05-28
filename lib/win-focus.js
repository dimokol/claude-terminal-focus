// lib/win-focus.js — bring a Windows process's main window to the foreground.
//
// SetForegroundWindow from a background process is blocked by Windows 10/11
// (only flashes the taskbar button). The reliable workaround is to
// temporarily AttachThreadInput from our thread to the current foreground
// window's thread; that merges input queues so Windows treats us as having
// focus privilege long enough for BringWindowToTop + SetForegroundWindow
// to actually succeed. We detach immediately after to avoid input lock-up.
//
// AllowSetForegroundWindow on the target PID is a belt-and-suspenders
// addition for the case where the shell already granted us foreground rights
// (e.g. URL-protocol-handler activation path).
//
// Used by:
//   - bin/win-click-handler.js (custom-URI launcher invoked by Windows shell
//     for `claude-notif://` activations — works when toast click reaches us)
//   - extension.js UriHandler (the `vscode://dimokol.claude-notifications/`
//     path, when the click is processed in-process by VS Code's extension
//     host and we still need to bring VS Code's main window to the front
//     over whatever fullscreen app the user is currently looking at)

'use strict';

const { spawnSync, spawn } = require('child_process');

// Normalize a single pid or an array of pids into a sorted, valid list.
function normalizePids(pidOrPids) {
  const arr = Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids];
  return arr.filter(p => Number.isInteger(p) && p > 0);
}

function buildPsScript(pidOrPids) {
  const pids = normalizePids(pidOrPids);
  // PS array literal of the candidate PIDs. EnumWindows matches a window
  // owned by ANY of them — only the renderer Code.exe owns a top-level
  // visible window, so passing the whole Code.exe ancestor set (ptyHost +
  // renderer + main) lets the renderer win without us having to know which
  // is which from the Node side.
  const pidList = pids.join(',');
  return `
$ErrorActionPreference = 'Stop'
$targetPids = @(${pidList})

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CN_Win32 {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
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

# Retry across the post-toast-click foreground settling window. When the
# extension host spawns us right after the user clicks the toast, the
# foreground window can briefly be the toast host / a transient window;
# AttachThreadInput to that wrong thread fails to raise VS Code. Re-reading
# the foreground each attempt and retrying over ~1.5s catches the settled
# state.
for ($i = 0; $i -lt 6 -and -not $ok; $i++) {
  [CN_Win32]::AllowSetForegroundWindow($foundPid) | Out-Null
  $fgHwnd = [CN_Win32]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [CN_Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
  $sb = New-Object System.Text.StringBuilder 256
  [CN_Win32]::GetWindowText($fgHwnd, $sb, 256) | Out-Null
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $currentThread) {
    $attached = [CN_Win32]::AttachThreadInput($currentThread, $fgThread, $true)
  }
  try {
    if ([CN_Win32]::IsIconic($found)) { [CN_Win32]::ShowWindow($found, 9) | Out-Null }
    # Alt-key tap: synthesizing an Alt down/up gives our thread a "recent
    # user input" event, which satisfies one of SetForegroundWindow's
    # allow-conditions. This is the only thing that works when the
    # foreground is "Action center" (the toast host) — AttachThreadInput
    # to that protected UWP surface fails, but the Alt tap doesn't need it.
    [CN_Win32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [CN_Win32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [CN_Win32]::BringWindowToTop($found) | Out-Null
    $ok = [CN_Win32]::SetForegroundWindow($found)
  } finally {
    if ($attached) { [CN_Win32]::AttachThreadInput($currentThread, $fgThread, $false) | Out-Null }
  }
  if (-not $ok) { Start-Sleep -Milliseconds 150 }
}

if (-not $ok) {
  Write-Error "SetForegroundWindow failed"
  exit 3
}
exit 0
`.trim();
}

/**
 * Synchronously bring the main visible window owned by any of `pidOrPids`
 * to foreground. Returns true on success (PS exit 0). Use when the caller
 * can block briefly (typical budget: 1-3 seconds).
 */
function focusHwndByPid(pidOrPids, budgetMs = 2000) {
  const pids = normalizePids(pidOrPids);
  if (pids.length === 0) return false;
  try {
    const res = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', buildPsScript(pids)
    ], {
      windowsHide: true,
      timeout: budgetMs,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return res && res.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Fire-and-forget version: spawn the foreground PS and return immediately.
 * Use this from the VS Code extension host where we can't block the
 * extension thread on a PS subprocess.
 *
 * IMPORTANT: must NOT use `detached: true`. A detached child becomes the
 * root of a new process group (CREATE_NEW_PROCESS_GROUP), which breaks the
 * AttachThreadInput-based foreground inheritance — SetForegroundWindow then
 * only flashes the taskbar instead of actually raising the window. Verified
 * 2026-05-25: detached spawn = taskbar flash only; plain spawn + unref =
 * real focus steal. We `unref()` so Node doesn't wait on the ~1s PS process.
 */
function focusHwndByPidAsync(pidOrPids) {
  const pids = normalizePids(pidOrPids);
  if (pids.length === 0) return false;
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', buildPsScript(pids)
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  buildPsScript,
  focusHwndByPid,
  focusHwndByPidAsync
};
