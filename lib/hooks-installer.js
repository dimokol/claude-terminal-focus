// lib/hooks-installer.js — Install/uninstall Claude Code hooks in ~/.claude/settings.json
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Get the command string that Claude Code should run for our hook.
 * Points to hook.js inside the extension's install directory.
 * @param {string} extensionPath - context.extensionPath from VS Code
 */
function getHookCommand(extensionPath) {
  const hookPath = path.join(extensionPath, 'hook.js');
  // Use JSON.stringify to handle spaces in paths
  return `node ${JSON.stringify(hookPath)}`;
}

/**
 * Check if our hooks are already installed in ~/.claude/settings.json.
 * @returns {'installed' | 'not-installed' | 'legacy' | 'no-file'}
 */
function checkHookStatus(extensionPath) {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    return 'no-file';
  }

  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const hooks = settings.hooks;
    if (!hooks) return 'not-installed';

    // Check if our v2 hooks are installed
    const hasStop = hasOurHook(hooks.Stop);
    const hasNotification = hasOurHook(hooks.Notification);

    if (hasStop && hasNotification) return 'installed';

    // Check for legacy (v1) hooks — bash scripts
    const hasLegacyStop = hasLegacyHook(hooks.Stop);
    const hasLegacyNotification = hasLegacyHook(hooks.Notification);

    if (hasLegacyStop || hasLegacyNotification) return 'legacy';

    return 'not-installed';
  } catch (_) {
    return 'not-installed';
  }
}

function hasOurHook(hookArray) {
  if (!Array.isArray(hookArray)) return false;
  return hookArray.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h => h.command && h.command.includes('hook.js'))
  );
}

function hasLegacyHook(hookArray) {
  if (!Array.isArray(hookArray)) return false;
  return hookArray.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h =>
      h.command && (
        h.command.includes('task-complete.sh') ||
        h.command.includes('notify.sh') ||
        h.command.includes('task-complete.ps1') ||
        h.command.includes('notify.ps1')
      )
    )
  );
}

/**
 * Install our hooks into ~/.claude/settings.json.
 * Merges with existing hooks — does NOT overwrite other hooks.
 * Creates a backup before modifying.
 *
 * @param {string} extensionPath - context.extensionPath
 * @param {object} options
 * @param {boolean} options.replaceLegacy - if true, remove legacy bash/ps1 hooks
 * @returns {{ success: boolean, message: string, backupPath?: string }}
 */
function installHooks(extensionPath, { replaceLegacy = false } = {}) {
  try {
    // Ensure ~/.claude/ directory exists
    const claudeDir = path.dirname(CLAUDE_SETTINGS_PATH);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing settings (or start fresh)
    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
      settings = JSON.parse(content);

      // Backup
      const backupPath = CLAUDE_SETTINGS_PATH + '.backup';
      fs.writeFileSync(backupPath, content);
    }

    if (!settings.hooks) settings.hooks = {};

    const hookCommand = getHookCommand(extensionPath);
    const ourHookEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: hookCommand }]
    };

    // Remove legacy hooks if requested
    if (replaceLegacy) {
      if (Array.isArray(settings.hooks.Stop)) {
        settings.hooks.Stop = settings.hooks.Stop.filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            h.command && (h.command.includes('task-complete.sh') || h.command.includes('task-complete.ps1'))
          )
        );
      }
      if (Array.isArray(settings.hooks.Notification)) {
        settings.hooks.Notification = settings.hooks.Notification.filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            h.command && (h.command.includes('notify.sh') || h.command.includes('notify.ps1'))
          )
        );
      }
    }

    // Remove any existing v2 hooks (prevent duplicates)
    for (const event of ['Stop', 'Notification', 'PermissionRequest']) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            h.command && h.command.includes('hook.js')
          )
        );
      }
    }

    // Add our hooks to all three events
    for (const event of ['Stop', 'Notification', 'PermissionRequest']) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      settings.hooks[event].push(ourHookEntry);
    }

    // Write
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

    return {
      success: true,
      message: 'Claude Code hooks installed successfully.',
      backupPath: CLAUDE_SETTINGS_PATH + '.backup'
    };
  } catch (err) {
    return { success: false, message: `Failed to install hooks: ${err.message}` };
  }
}

/**
 * Remove our hooks from ~/.claude/settings.json.
 * Only removes hooks that point to our hook.js — leaves everything else intact.
 */
function uninstallHooks() {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    return { success: true, message: 'No settings file found — nothing to remove.' };
  }

  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(content);

    if (!settings.hooks) {
      return { success: true, message: 'No hooks configured — nothing to remove.' };
    }

    // Backup
    fs.writeFileSync(CLAUDE_SETTINGS_PATH + '.backup', content);

    let removed = false;
    for (const event of ['Stop', 'Notification', 'PermissionRequest']) {
      if (Array.isArray(settings.hooks[event])) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            h.command && h.command.includes('hook.js')
          )
        );
        if (settings.hooks[event].length < before) removed = true;
        // Clean up empty arrays
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

    return {
      success: true,
      message: removed
        ? 'Claude Terminal Focus hooks removed.'
        : 'No Claude Terminal Focus hooks found to remove.'
    };
  } catch (err) {
    return { success: false, message: `Failed to remove hooks: ${err.message}` };
  }
}

module.exports = { checkHookStatus, installHooks, uninstallHooks, CLAUDE_SETTINGS_PATH };
