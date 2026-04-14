// lib/notifications.js — VS Code notification + node-notifier fallback
const vscode = require('vscode');
const path = require('path');

/**
 * Show a notification to the user. Uses VS Code's native notification API
 * as primary. Falls back to node-notifier for OS-level notifications when
 * the VS Code window is focused (since native notifications only appear as
 * OS toasts when the window is NOT focused).
 *
 * IMPORTANT: The fallback (node-notifier) is a *complement*, not an override.
 * It only fires when the VS Code window is focused (meaning the user won't
 * see an OS toast from VS Code). It does NOT fire when native notifications
 * are disabled — if the user turned those off, that's an intentional choice
 * we respect. node-notifier also goes through the OS notification system,
 * so DND/mute settings are naturally respected.
 *
 * @param {object} signal - Parsed signal data from signals.js
 * @param {import('vscode').OutputChannel} log - Output channel for logging
 * @returns {Promise<'focus' | 'dismissed'>} - What the user did
 */
async function showNotification(signal, log) {
  const config = vscode.workspace.getConfiguration('claudeNotifications');
  const useFallback = config.get('notification.useFallback', true);
  const nativeEnabled = isNativeNotificationsEnabled();

  const title = signal.event === 'stop' ? 'Claude Code — Done' : 'Claude Code';
  const message = signal.event === 'stop'
    ? `Task completed in: ${signal.project}`
    : `Waiting for your response in: ${signal.project}`;

  // Always show via VS Code API (appears as OS toast when window unfocused,
  // or as in-window notification when window focused)
  const vscodePromise = vscode.window.showInformationMessage(
    message,
    'Focus Terminal'
  );

  // Fallback via node-notifier — ONLY when ALL of these are true:
  // 1. Fallback is enabled in settings
  // 2. Native notifications are enabled (user hasn't deliberately turned them off)
  // 3. The VS Code window is currently focused (so VS Code's own API will only
  //    show an in-window toast, not an OS toast — the fallback supplements it)
  //
  // We never use the fallback to bypass the user's notification preferences.
  // If they've disabled native notifications or set OS-level DND, we respect that.
  if (useFallback && nativeEnabled !== false && vscode.window.state.focused) {
    try {
      showFallbackNotification(title, message, signal, log);
    } catch (err) {
      log.appendLine(`Fallback notification error: ${err.message}`);
    }
  }

  const action = await vscodePromise;
  return action === 'Focus Terminal' ? 'focus' : 'dismissed';
}

/**
 * Show an OS-native notification via node-notifier.
 */
function showFallbackNotification(title, message, signal, log) {
  try {
    const notifier = require('node-notifier');
    const iconPath = path.join(__dirname, '..', 'images', 'icon.png');

    notifier.notify({
      title,
      message,
      icon: iconPath,
      sound: false, // we handle sound separately
      wait: true,   // keep notification visible until dismissed/clicked
      timeout: 15   // seconds (Linux)
    }, (err) => {
      if (err) {
        log.appendLine(`node-notifier error: ${err.message}`);
      }
    });

    // On click, the VS Code window will gain focus from the click,
    // which triggers the extension's existing window focus handler
    notifier.on('click', () => {
      log.appendLine('Fallback notification clicked');
    });
  } catch (err) {
    log.appendLine(`node-notifier not available: ${err.message}`);
  }
}

/**
 * Check if native notifications are enabled in VS Code settings.
 * Returns true if enabled, false if disabled, null if the setting can't be read.
 */
function isNativeNotificationsEnabled() {
  try {
    const windowConfig = vscode.workspace.getConfiguration('window');
    return windowConfig.get('nativeNotifications', true);
  } catch (_) {
    return null;
  }
}

module.exports = { showNotification, isNativeNotificationsEnabled };
