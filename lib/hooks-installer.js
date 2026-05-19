// lib/hooks-installer.js — Install/uninstall Claude Code hooks in ~/.claude/settings.json.
//
// As of 3.5.0, hook entries point at a stable-location WRAPPER under
// ~/.claude/claude-notifications/, not directly at the extension's
// dist/hook.js. The wrapper survives extension uninstalls and self-
// destructs (cleaning all profiles + state) the first time it fires
// after the extension is gone. See lib/hook-runtime.js + bin/hook-wrapper.cjs.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

const HOOK_EVENTS = ['Stop', 'Notification', 'PermissionRequest'];
const USER_PROMPT_EVENT = 'UserPromptSubmit';
const ALL_EVENTS = [...HOOK_EVENTS, USER_PROMPT_EVENT];

// Substrings that identify any era of our hook entries. New installs use
// claude-notifications/hook(.cjs|-user-prompt.cjs); pre-3.5.0 installs
// used hook.js/hook-user-prompt.js inside dimokol.claude-notifications-*.
// Either form is "ours" and gets cleaned on uninstall / migrated on
// re-install.
const OUR_HOOK_IDENTIFIERS = [
  'claude-notifications/hook.cjs',
  'claude-notifications\\hook.cjs',
  'claude-notifications/hook-user-prompt.cjs',
  'claude-notifications\\hook-user-prompt.cjs',
  'dimokol.claude-notifications',
  'dimokol.claude-terminal-focus'
];

const OUR_USER_PROMPT_IDENTIFIERS = [
  'claude-notifications/hook-user-prompt.cjs',
  'claude-notifications\\hook-user-prompt.cjs',
  'hook-user-prompt.js'
];

function commandReferencesAnyOf(command, substrings) {
  if (typeof command !== 'string') return false;
  return substrings.some(sub => command.includes(sub));
}

function getHookCommand(wrapperHookPath) {
  return `node ${JSON.stringify(wrapperHookPath)}`;
}

function getUserPromptHookCommand(wrapperUserPromptPath) {
  return `node ${JSON.stringify(wrapperUserPromptPath)}`;
}

/**
 * Extract the first hook path we can find from settings.json. Used by
 * checkHookStatus to detect stale-path conditions on activation.
 */
function getInstalledHookPath(hooks) {
  for (const event of ALL_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    for (const entry of hooks[event]) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!commandReferencesAnyOf(h.command, OUR_HOOK_IDENTIFIERS)) continue;
        const match = h.command.match(/node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
        const hookPath = match && (match[1] || match[2] || match[3]);
        if (hookPath) return hookPath;
      }
    }
  }
  return null;
}

/**
 * Check if our hooks are already installed and current.
 * `status` is one of: 'installed', 'not-installed', 'legacy', 'no-file',
 * 'stale-path', 'partial'.
 *
 * `expectedHookPath` (the wrapper hook path) is supplied by the caller
 * so this module stays decoupled from the runtime.
 */
function checkHookStatus(expectedHookPath, settingsPath = CLAUDE_SETTINGS_PATH) {
  if (!fs.existsSync(settingsPath)) {
    return { status: 'no-file' };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = settings.hooks;
    if (!hooks) return { status: 'not-installed' };

    const hasAllPrimary = HOOK_EVENTS.every(event => hasOurHook(hooks[event]));
    const hasUserPrompt = hasUserPromptHook(hooks[USER_PROMPT_EVENT]);

    if (hasAllPrimary && hasUserPrompt) {
      const installedPath = getInstalledHookPath(hooks);
      if (installedPath && path.resolve(installedPath) !== path.resolve(expectedHookPath)) {
        return { status: 'stale-path', installedPath };
      }
      return { status: 'installed' };
    }

    if (hasAllPrimary || HOOK_EVENTS.some(event => hasOurHook(hooks[event]))) {
      const installedPath = getInstalledHookPath(hooks);
      return { status: 'partial', installedPath };
    }

    const hasLegacyStop = hasLegacyHook(hooks.Stop);
    const hasLegacyNotification = hasLegacyHook(hooks.Notification);
    if (hasLegacyStop || hasLegacyNotification) return { status: 'legacy' };

    return { status: 'not-installed' };
  } catch (_) {
    return { status: 'not-installed' };
  }
}

function hasOurHook(hookArray) {
  if (!Array.isArray(hookArray)) return false;
  return hookArray.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h => commandReferencesAnyOf(h.command, OUR_HOOK_IDENTIFIERS))
  );
}

function hasUserPromptHook(hookArray) {
  if (!Array.isArray(hookArray)) return false;
  return hookArray.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h => commandReferencesAnyOf(h.command, OUR_USER_PROMPT_IDENTIFIERS))
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
 * Install our hooks. Removes any prior entries that match our identifiers
 * (so 3.4.x → 3.5.x migration is automatic) and writes fresh entries
 * pointing at the supplied wrapper paths.
 *
 * @param {object} wrapperPaths - { hookPath, userPromptHookPath }
 * @param {object} [options]
 * @param {boolean} [options.replaceLegacy] - also strip pre-v3 .sh/.ps1 entries
 * @param {string}  [options.settingsPath]
 */
function installHooks(wrapperPaths, { replaceLegacy = false, settingsPath = CLAUDE_SETTINGS_PATH } = {}) {
  if (!wrapperPaths || !wrapperPaths.hookPath || !wrapperPaths.userPromptHookPath) {
    return { success: false, message: 'installHooks called without { hookPath, userPromptHookPath }' };
  }
  try {
    const claudeDir = path.dirname(settingsPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(content);
      fs.writeFileSync(settingsPath + '.backup', content);
    }

    if (!settings.hooks) settings.hooks = {};

    const ourHookEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: getHookCommand(wrapperPaths.hookPath) }]
    };

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

    // Strip any existing entries of ours (wrapper-style OR legacy direct-
    // to-extension), so reinstall/migration writes a single fresh entry.
    for (const event of ALL_EVENTS) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            commandReferencesAnyOf(h.command, OUR_HOOK_IDENTIFIERS)
          )
        );
      }
    }

    for (const event of HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      settings.hooks[event].push(ourHookEntry);
    }

    const userPromptEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: getUserPromptHookCommand(wrapperPaths.userPromptHookPath) }]
    };
    if (!Array.isArray(settings.hooks[USER_PROMPT_EVENT])) settings.hooks[USER_PROMPT_EVENT] = [];
    settings.hooks[USER_PROMPT_EVENT].push(userPromptEntry);

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return {
      success: true,
      message: 'Claude Code hooks installed successfully.',
      backupPath: settingsPath + '.backup'
    };
  } catch (err) {
    return { success: false, message: `Failed to install hooks: ${err.message}` };
  }
}

/**
 * Remove our hook entries from settings.json. Idempotent.
 */
function uninstallHooks(settingsPath = CLAUDE_SETTINGS_PATH) {
  if (!fs.existsSync(settingsPath)) {
    return { success: true, message: 'No settings file found — nothing to remove.' };
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(content);

    if (!settings.hooks) {
      return { success: true, message: 'No hooks configured — nothing to remove.' };
    }

    fs.writeFileSync(settingsPath + '.backup', content);

    let removed = false;
    for (const event of ALL_EVENTS) {
      if (Array.isArray(settings.hooks[event])) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            commandReferencesAnyOf(h.command, OUR_HOOK_IDENTIFIERS)
          )
        );
        if (settings.hooks[event].length < before) removed = true;
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return {
      success: true,
      message: removed
        ? 'Claude Notifications hooks removed.'
        : 'No Claude Notifications hooks found to remove.'
    };
  } catch (err) {
    return { success: false, message: `Failed to remove hooks: ${err.message}` };
  }
}

/**
 * Find every Claude profile (~/.claude and ~/.claude-*) with a settings.json,
 * excluding backups.
 */
function discoverProfiles(homeDir = os.homedir()) {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(homeDir, { withFileTypes: true }); }
  catch (_) { return result; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name !== '.claude' && !name.startsWith('.claude-')) continue;
    if (name.toLowerCase().startsWith('.claude-backup')) continue;
    const settingsPath = path.join(homeDir, name, 'settings.json');
    if (fs.existsSync(settingsPath)) result.push(settingsPath);
  }
  return result;
}

function checkAllProfiles(expectedHookPath, homeDir) {
  return discoverProfiles(homeDir).map(p => ({
    path: p,
    ...checkHookStatus(expectedHookPath, p)
  }));
}

module.exports = {
  checkHookStatus,
  checkAllProfiles,
  getInstalledHookPath,
  installHooks,
  uninstallHooks,
  discoverProfiles,
  CLAUDE_SETTINGS_PATH,
  OUR_HOOK_IDENTIFIERS,
  OUR_USER_PROMPT_IDENTIFIERS
};
