# v2.0 — Self-Contained Claude Terminal Focus

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension fully self-contained — install from Marketplace, one-click setup, no external dependencies, cross-platform (macOS/Windows/Linux).

**Architecture:** A Node.js hook script (shipped inside the extension) replaces all platform-specific shell/PowerShell scripts. The hook writes a JSON signal file; the extension watches it, plays a sound, and shows a notification via VS Code API (primary) with node-notifier as fallback. Auto-install command patches `~/.claude/settings.json` to register the hook.

**Tech Stack:** VS Code Extension API, Node.js (hook script), node-notifier (npm dependency for fallback notifications)

---

## File Structure

```
claude-terminal-focus/
├── extension.js              — MODIFY: rewrite for v2 (settings, notifications, sound, auto-install)
├── hook.js                   — CREATE: cross-platform Node.js hook script (runs outside VS Code)
├── lib/
│   ├── signals.js            — CREATE: signal file read/write/watch logic (shared constants)
│   ├── notifications.js      — CREATE: VS Code notification + node-notifier fallback
│   ├── sounds.js             — CREATE: cross-platform sound playback
│   ├── hooks-installer.js    — CREATE: read/write ~/.claude/settings.json, install/uninstall hooks
│   └── gitignore-setup.js    — CREATE: add signal files to global gitignore
├── sounds/
│   ├── notification.wav      — CREATE: bundled notification sound
│   └── task-complete.wav     — CREATE: bundled task-complete sound
├── package.json              — MODIFY: add dependencies, settings, commands
├── README.md                 — MODIFY: simplified setup docs
├── .vscodeignore             — MODIFY: include new files, exclude old scripts
├── scripts/                  — DELETE (after migration): old platform-specific scripts
└── docs/                     — plan files (not shipped)
```

### Responsibilities

| File | Responsibility |
|------|----------------|
| `hook.js` | Runs outside VS Code. Reads `CLAUDE_PROJECT_DIR` + stdin JSON. Finds workspace root. Writes JSON signal file with event type, project name, PID chain. Exits. No dependencies beyond Node.js stdlib. |
| `lib/signals.js` | Constants (`SIGNAL_DIR`, `SIGNAL_FILE`), signal file path resolution, JSON schema for signal data, watcher setup (fs.watch + polling fallback). |
| `lib/notifications.js` | Shows notification via `vscode.window.showInformationMessage()`. If native notifications disabled or window focused, falls back to `node-notifier`. Returns a promise that resolves to the user's button click action. |
| `lib/sounds.js` | Plays `.wav` files cross-platform: `afplay` (macOS), PowerShell `SoundPlayer` (Windows), `paplay`/`aplay` (Linux). Respects the `sound` setting. |
| `lib/hooks-installer.js` | Reads `~/.claude/settings.json`, merges Stop+Notification hooks pointing to `hook.js`, writes back. Also provides uninstall (removes only our hooks). Backs up before modifying. |
| `lib/gitignore-setup.js` | Checks global gitignore for `.claude-focus` entries. If missing, prompts user and appends them. |
| `extension.js` | Orchestrator. On activate: check first-run, offer hook install, start signal watcher. On signal: play sound + show notification. On notification click: focus terminal (existing PID-matching logic). Registers commands. Reads settings. |

---

## Signal File Format (v2)

The hook writes a single JSON file instead of a plain PID list. The extension detects the format and handles both v1 (plain text PIDs) and v2 (JSON) for backwards compatibility.

```json
{
  "version": 2,
  "event": "stop",
  "project": "ridebly-fe",
  "projectDir": "/Users/dimokol/Documents/WebDev/ridebly-fe",
  "pids": [12345, 12300, 12200],
  "timestamp": 1712678400000
}
```

- `event`: `"stop"` or `"notification"` — determines which sound to play and notification text
- `project`: basename of `CLAUDE_PROJECT_DIR` (for display)
- `projectDir`: full path (for workspace matching)
- `pids`: ancestor PID chain (for terminal matching — same logic as v1)
- `timestamp`: `Date.now()` (for staleness checks — ignore signals older than 30s)

---

## Task 1: Initialize npm project and add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Initialize npm and add node-notifier**

```bash
cd /Users/dimokol/Documents/WebDev/claude-terminal-focus
npm init -y 2>/dev/null  # already has package.json, just need node_modules
npm install node-notifier
```

- [ ] **Step 2: Update package.json with v2 manifest**

Update `package.json` to add commands, settings, and bump version:

```json
{
  "name": "claude-terminal-focus",
  "displayName": "Claude Terminal Focus",
  "description": "All-in-one Claude Code notifications — sound alerts, OS notifications, and terminal focus. One-click setup, zero dependencies.",
  "version": "2.0.0",
  "publisher": "dimokol",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/dimokol/claude-terminal-focus"
  },
  "bugs": {
    "url": "https://github.com/dimokol/claude-terminal-focus/issues"
  },
  "homepage": "https://github.com/dimokol/claude-terminal-focus#readme",
  "icon": "images/icon.png",
  "engines": {
    "vscode": "^1.80.0"
  },
  "categories": [
    "Other"
  ],
  "keywords": [
    "claude",
    "claude-code",
    "terminal",
    "focus",
    "notification",
    "anthropic",
    "ai",
    "productivity",
    "sound",
    "alert"
  ],
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./extension.js",
  "dependencies": {
    "node-notifier": "^10.0.1"
  },
  "contributes": {
    "commands": [
      {
        "command": "claudeTerminalFocus.setupHooks",
        "title": "Claude Terminal Focus: Set Up Claude Code Hooks"
      },
      {
        "command": "claudeTerminalFocus.removeHooks",
        "title": "Claude Terminal Focus: Remove Claude Code Hooks"
      },
      {
        "command": "claudeTerminalFocus.setupGitignore",
        "title": "Claude Terminal Focus: Add Signal Files to Global Gitignore"
      },
      {
        "command": "claudeTerminalFocus.testNotification",
        "title": "Claude Terminal Focus: Test Notification"
      }
    ],
    "configuration": {
      "title": "Claude Terminal Focus",
      "properties": {
        "claudeTerminalFocus.sound.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Play a sound when Claude needs attention"
        },
        "claudeTerminalFocus.sound.volume": {
          "type": "number",
          "default": 0.5,
          "minimum": 0,
          "maximum": 1,
          "description": "Sound volume (0.0 to 1.0, macOS/Linux only)"
        },
        "claudeTerminalFocus.notification.useFallback": {
          "type": "boolean",
          "default": true,
          "description": "Use OS-native notifications (via node-notifier) as fallback when VS Code window is focused. Respects OS notification preferences — never bypasses DND or mute."
        },
        "claudeTerminalFocus.autoSetupHooks": {
          "type": "boolean",
          "default": true,
          "description": "Prompt to install Claude Code hooks on first activation"
        }
      }
    }
  }
}
```

- [ ] **Step 3: Update .vscodeignore**

```
.git/**
.github/**
scripts/**
docs/**
images/icon.svg
.gitignore
.vscodeignore
.DS_Store
```

- [ ] **Step 4: Update .gitignore**

```
*.vsix
node_modules/
.vscode/.claude-focus
.vscode/.claude-focus-clicked
.DS_Store
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .vscodeignore .gitignore
git commit -m "chore: add node-notifier dependency and v2 manifest with commands and settings"
```

---

## Task 2: Create the cross-platform Node.js hook script

**Files:**
- Create: `hook.js`
- Create: `lib/signals.js`

This is the most critical piece — it runs **outside** VS Code, spawned by Claude Code. It must:
1. Read `CLAUDE_PROJECT_DIR` env var + JSON from stdin
2. Find the workspace root (walk up looking for `.vscode/`)
3. Build the PID ancestor chain (cross-platform)
4. Write the JSON signal file
5. Exit cleanly

- [ ] **Step 1: Create `lib/signals.js` — shared constants and utilities**

```javascript
// lib/signals.js
const path = require('path');

const SIGNAL_DIR = '.vscode';
const SIGNAL_FILE = '.claude-focus';
const CLICKED_FILE = '.claude-focus-clicked';
const SIGNAL_VERSION = 2;
const STALE_THRESHOLD_MS = 30000; // ignore signals older than 30s

/**
 * Resolve the signal file path for a given workspace root.
 */
function getSignalPath(workspaceRoot) {
  return path.join(workspaceRoot, SIGNAL_DIR, SIGNAL_FILE);
}

function getClickedPath(workspaceRoot) {
  return path.join(workspaceRoot, SIGNAL_DIR, CLICKED_FILE);
}

/**
 * Parse a signal file. Handles both v1 (plain PID list) and v2 (JSON).
 * Returns a normalized object or null if unparseable/stale.
 */
function parseSignal(content) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Try JSON (v2) first
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (data.version === 2) {
        // Check staleness
        if (data.timestamp && Date.now() - data.timestamp > STALE_THRESHOLD_MS) {
          return null;
        }
        return {
          version: 2,
          event: data.event || 'notification',
          project: data.project || 'Unknown',
          projectDir: data.projectDir || '',
          pids: Array.isArray(data.pids) ? data.pids : [],
          timestamp: data.timestamp || Date.now()
        };
      }
    } catch (_) {
      // Not JSON, fall through to v1
    }
  }

  // v1 format: plain PID list, one per line
  const pids = trimmed
    .split(/\r?\n/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

  return {
    version: 1,
    event: 'notification',
    project: 'Claude Code',
    projectDir: '',
    pids,
    timestamp: Date.now()
  };
}

module.exports = {
  SIGNAL_DIR,
  SIGNAL_FILE,
  CLICKED_FILE,
  SIGNAL_VERSION,
  STALE_THRESHOLD_MS,
  getSignalPath,
  getClickedPath,
  parseSignal
};
```

- [ ] **Step 2: Create `hook.js` — the cross-platform hook script**

```javascript
#!/usr/bin/env node
// hook.js — Claude Code hook script (runs OUTSIDE VS Code)
// Called by Claude Code on Stop and Notification events.
// Writes a JSON signal file that the VS Code extension watches.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SIGNAL_DIR = '.vscode';
const SIGNAL_FILE = '.claude-focus';

// --- 1. Read input ---

// Claude Code provides CLAUDE_PROJECT_DIR as env var
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const projectName = path.basename(projectDir);

// Claude Code pipes JSON to stdin with hook_event_name, session_id, etc.
let hookEvent = 'notification';
let stdinData = '';
try {
  stdinData = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  const input = JSON.parse(stdinData);
  const eventName = (input.hook_event_name || '').toLowerCase();
  if (eventName === 'stop') hookEvent = 'stop';
  else hookEvent = 'notification';
} catch (_) {
  // stdin might not be JSON or might be empty — default to notification
}

// --- 2. Find workspace root ---
// Walk up from projectDir looking for the topmost directory with a .vscode/ folder
// (same logic as the old bash scripts). Stop at $HOME to avoid using ~/.vscode.

const homeDir = process.env.HOME || process.env.USERPROFILE || '';
let workspaceRoot = projectDir;
let searchDir = projectDir;

while (searchDir !== path.dirname(searchDir)) { // stop at filesystem root
  if (searchDir === homeDir) break; // don't go above $HOME
  if (fs.existsSync(path.join(searchDir, SIGNAL_DIR))) {
    workspaceRoot = searchDir;
  }
  searchDir = path.dirname(searchDir);
}

// Ensure .vscode/ exists in the workspace root
const signalDirPath = path.join(workspaceRoot, SIGNAL_DIR);
if (!fs.existsSync(signalDirPath)) {
  fs.mkdirSync(signalDirPath, { recursive: true });
}

// --- 3. Build PID ancestor chain ---

function getPidChain() {
  const pids = [];
  let currentPid = process.pid;

  if (process.platform === 'win32') {
    // Windows: use WMIC or Get-CimInstance
    while (currentPid && currentPid > 0) {
      pids.push(currentPid);
      try {
        const output = execSync(
          `wmic process where ProcessId=${currentPid} get ParentProcessId /value`,
          { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const match = output.match(/ParentProcessId=(\d+)/);
        if (!match) break;
        const parentPid = parseInt(match[1], 10);
        if (parentPid === currentPid || parentPid === 0) break;
        currentPid = parentPid;
      } catch (_) {
        break;
      }
    }
  } else {
    // macOS / Linux: use ps
    while (currentPid && currentPid > 1) {
      pids.push(currentPid);
      try {
        const output = execSync(`ps -o ppid= -p ${currentPid}`, {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        const parentPid = parseInt(output.trim(), 10);
        if (isNaN(parentPid) || parentPid <= 0 || parentPid === currentPid) break;
        currentPid = parentPid;
      } catch (_) {
        break;
      }
    }
  }

  return pids;
}

// --- 4. Write signal file ---

const signal = {
  version: 2,
  event: hookEvent,
  project: projectName,
  projectDir: projectDir,
  pids: getPidChain(),
  timestamp: Date.now()
};

const signalPath = path.join(signalDirPath, SIGNAL_FILE);
fs.writeFileSync(signalPath, JSON.stringify(signal, null, 2));

// Done — the VS Code extension picks up the signal file and handles
// sound playback + notifications from inside VS Code.
```

- [ ] **Step 3: Make hook.js executable**

```bash
chmod +x hook.js
```

- [ ] **Step 4: Test hook.js locally**

```bash
cd /Users/dimokol/Documents/WebDev/claude-terminal-focus
CLAUDE_PROJECT_DIR="$PWD" echo '{"hook_event_name":"Stop"}' | node hook.js
cat .vscode/.claude-focus
```

Expected: JSON file with version 2, event "stop", PID chain, and timestamp.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js hook.js
git commit -m "feat: add cross-platform Node.js hook script and signal utilities"
```

---

## Task 3: Create the sound playback module

**Files:**
- Create: `lib/sounds.js`
- Create: `sounds/notification.wav`
- Create: `sounds/task-complete.wav`

- [ ] **Step 1: Source sound files**

We need two short `.wav` files. Options:
- **Option A (recommended):** Use system sounds as fallback and bundle two tiny .wav files for consistency. Generate them with `ffmpeg` from system sounds:

```bash
# macOS — convert system sounds to wav (small, ~50KB each)
ffmpeg -i /System/Library/Sounds/Funk.aiff -ar 22050 -ac 1 sounds/notification.wav
ffmpeg -i /System/Library/Sounds/Glass.aiff -ar 22050 -ac 1 sounds/task-complete.wav
```

If `ffmpeg` is not installed, use `afconvert`:

```bash
mkdir -p sounds
afconvert /System/Library/Sounds/Funk.aiff sounds/notification.wav -d LEI16 -f WAVE --rate 22050 --channels 1
afconvert /System/Library/Sounds/Glass.aiff sounds/task-complete.wav -d LEI16 -f WAVE --rate 22050 --channels 1
```

- [ ] **Step 2: Create `lib/sounds.js`**

```javascript
// lib/sounds.js — Cross-platform sound playback
const { execFile } = require('child_process');
const path = require('path');

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');

/**
 * Play a sound file. Non-blocking — fires and forgets.
 * @param {'notification' | 'task-complete'} soundName
 * @param {number} volume - 0.0 to 1.0 (supported on macOS/Linux only)
 */
function playSound(soundName, volume = 0.5) {
  const soundFile = path.join(SOUNDS_DIR, `${soundName}.wav`);
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // macOS: afplay with volume (0-255 scale)
      const macVolume = Math.round(volume * 255).toString();
      execFile('afplay', ['-v', macVolume, soundFile], handleError);
    } else if (platform === 'win32') {
      // Windows: PowerShell SoundPlayer (no volume control)
      const psCommand = `(New-Object System.Media.SoundPlayer '${soundFile.replace(/'/g, "''")}').PlaySync()`;
      execFile('powershell', ['-NoProfile', '-Command', psCommand], handleError);
    } else {
      // Linux: try paplay (PulseAudio) first, fall back to aplay (ALSA)
      execFile('paplay', [soundFile], (err) => {
        if (err) {
          execFile('aplay', [soundFile], handleError);
        }
      });
    }
  } catch (_) {
    // Sound playback is best-effort — never crash the extension
  }
}

function handleError(err) {
  // Silently ignore — sound is non-critical
  if (err && process.env.CLAUDE_TERMINAL_FOCUS_DEBUG) {
    console.error('Sound playback error:', err.message);
  }
}

module.exports = { playSound };
```

- [ ] **Step 3: Commit**

```bash
git add lib/sounds.js sounds/
git commit -m "feat: add cross-platform sound playback with bundled wav files"
```

---

## Task 4: Create the notification module

**Files:**
- Create: `lib/notifications.js`

- [ ] **Step 1: Create `lib/notifications.js`**

```javascript
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
  const config = vscode.workspace.getConfiguration('claudeTerminalFocus');
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
    }, (err, response, metadata) => {
      if (err) {
        log.appendLine(`node-notifier error: ${err.message}`);
      }
    });

    // On click, write the clicked marker file so the extension's existing
    // click-detection logic picks it up
    notifier.on('click', () => {
      log.appendLine('Fallback notification clicked');
      // The extension's watcher already handles terminal focusing
      // when it detects the clicked file — no extra action needed here
      // since the VS Code window will gain focus from the click
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
```

- [ ] **Step 2: Commit**

```bash
git add lib/notifications.js
git commit -m "feat: add notification module with VS Code API primary and node-notifier fallback"
```

---

## Task 5: Create the hooks installer module

**Files:**
- Create: `lib/hooks-installer.js`

- [ ] **Step 1: Create `lib/hooks-installer.js`**

```javascript
// lib/hooks-installer.js — Install/uninstall Claude Code hooks in ~/.claude/settings.json
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_MARKER = 'claude-terminal-focus'; // used to identify our hooks

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

    const hookCommand = getHookCommand(extensionPath);

    // Check if our v2 hooks are installed
    const hasStop = hasOurHook(hooks.Stop, hookCommand);
    const hasNotification = hasOurHook(hooks.Notification, hookCommand);

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

function hasOurHook(hookArray, hookCommand) {
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
    for (const event of ['Stop', 'Notification']) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(entry =>
          !Array.isArray(entry.hooks) || !entry.hooks.some(h =>
            h.command && h.command.includes('hook.js')
          )
        );
      }
    }

    // Add our hooks
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    if (!Array.isArray(settings.hooks.Notification)) settings.hooks.Notification = [];

    settings.hooks.Stop.push(ourHookEntry);
    settings.hooks.Notification.push(ourHookEntry);

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
    for (const event of ['Stop', 'Notification']) {
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
```

- [ ] **Step 2: Commit**

```bash
git add lib/hooks-installer.js
git commit -m "feat: add hooks installer for auto-registering Claude Code hooks"
```

---

## Task 6: Create the gitignore setup module

**Files:**
- Create: `lib/gitignore-setup.js`

- [ ] **Step 1: Create `lib/gitignore-setup.js`**

```javascript
// lib/gitignore-setup.js — Add signal files to global gitignore
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const ENTRIES = ['.vscode/.claude-focus', '.vscode/.claude-focus-clicked'];

/**
 * Check if the global gitignore already contains our entries.
 * @returns {{ configured: boolean, gitignorePath: string | null }}
 */
function checkGitignoreStatus() {
  const gitignorePath = getGlobalGitignorePath();
  if (!gitignorePath) return { configured: false, gitignorePath: null };

  if (!fs.existsSync(gitignorePath)) return { configured: false, gitignorePath };

  const content = fs.readFileSync(gitignorePath, 'utf8');
  const hasAll = ENTRIES.every(entry => content.includes(entry));
  return { configured: hasAll, gitignorePath };
}

/**
 * Add signal file entries to the global gitignore.
 * Creates the file if it doesn't exist. Sets git config if needed.
 * @returns {{ success: boolean, message: string }}
 */
function setupGitignore() {
  try {
    let gitignorePath = getGlobalGitignorePath();

    // If no global gitignore is configured, create one
    if (!gitignorePath) {
      gitignorePath = path.join(os.homedir(), '.gitignore_global');
      execSync(`git config --global core.excludesfile "${gitignorePath}"`, { encoding: 'utf8' });
    }

    // Read existing content
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf8');
    }

    // Append missing entries
    const missing = ENTRIES.filter(entry => !content.includes(entry));
    if (missing.length === 0) {
      return { success: true, message: 'Global gitignore already configured.' };
    }

    const addition = '\n# Claude Terminal Focus signal files\n' + missing.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, addition);

    return {
      success: true,
      message: `Added ${missing.length} entries to ${gitignorePath}`
    };
  } catch (err) {
    return { success: false, message: `Failed to set up gitignore: ${err.message}` };
  }
}

function getGlobalGitignorePath() {
  try {
    return execSync('git config --global core.excludesfile', { encoding: 'utf8' }).trim() || null;
  } catch (_) {
    return null;
  }
}

module.exports = { checkGitignoreStatus, setupGitignore };
```

- [ ] **Step 2: Commit**

```bash
git add lib/gitignore-setup.js
git commit -m "feat: add gitignore setup utility for signal files"
```

---

## Task 7: Rewrite extension.js — the main orchestrator

**Files:**
- Modify: `extension.js`

This is the big one. Rewrite `extension.js` to:
1. Watch signal files (existing logic, improved)
2. Play sounds on signal detection
3. Show notifications (VS Code API + fallback)
4. Focus the correct terminal on click (existing logic, preserved)
5. Register commands (setup hooks, remove hooks, setup gitignore, test notification)
6. First-run checks (hook status, native notifications, gitignore)

- [ ] **Step 1: Rewrite `extension.js`**

```javascript
// extension.js — Claude Terminal Focus v2.0
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getSignalPath, getClickedPath, parseSignal, SIGNAL_DIR, SIGNAL_FILE, CLICKED_FILE } = require('./lib/signals');
const { showNotification, isNativeNotificationsEnabled } = require('./lib/notifications');
const { playSound } = require('./lib/sounds');
const { checkHookStatus, installHooks, uninstallHooks } = require('./lib/hooks-installer');
const { checkGitignoreStatus, setupGitignore } = require('./lib/gitignore-setup');

const POLL_MS = 800;

function activate(context) {
  const log = vscode.window.createOutputChannel('Claude Terminal Focus');
  log.appendLine('Claude Terminal Focus v2.0 activated');
  log.appendLine(`Workspace folders: ${(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).join(', ') || 'none'}`);

  // --- Register commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTerminalFocus.setupHooks', () => cmdSetupHooks(context, log)),
    vscode.commands.registerCommand('claudeTerminalFocus.removeHooks', () => cmdRemoveHooks(log)),
    vscode.commands.registerCommand('claudeTerminalFocus.setupGitignore', () => cmdSetupGitignore(log)),
    vscode.commands.registerCommand('claudeTerminalFocus.testNotification', () => cmdTestNotification(log))
  );

  // --- Signal file watcher (polling) ---

  const timer = setInterval(() => {
    if (!vscode.workspace.workspaceFolders) return;

    for (const folder of vscode.workspace.workspaceFolders) {
      // Check for v1-style clicked marker (backwards compat with terminal-notifier)
      const clickedPath = getClickedPath(folder.uri.fsPath);
      if (fs.existsSync(clickedPath)) {
        log.appendLine(`Clicked marker found (v1 compat) — ${folder.name}`);
        try { fs.unlinkSync(clickedPath); } catch (_) {}
        const signalPath = getSignalPath(folder.uri.fsPath);
        handleSignal(signalPath, log);
        return;
      }

      // Check for signal file
      const signalPath = getSignalPath(folder.uri.fsPath);
      if (fs.existsSync(signalPath)) {
        log.appendLine(`Signal file found — ${folder.name}`);
        handleSignal(signalPath, log);
        return;
      }
    }
  }, POLL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // --- Window focus handler (Windows toast support) ---

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        checkAllSignalFiles(log);
      }
    })
  );

  // --- First-run checks ---

  runFirstRunChecks(context, log);

  log.appendLine(`Polling every ${POLL_MS}ms for signals`);
  log.appendLine('Ready');
}

// --- Signal handling ---

async function handleSignal(signalPath, log) {
  let content;
  try {
    content = fs.readFileSync(signalPath, 'utf8').trim();
  } catch (err) {
    log.appendLine(`Could not read signal file: ${err.message}`);
    return;
  }

  // Delete signal file immediately to prevent re-processing
  try { fs.unlinkSync(signalPath); } catch (_) {}

  const signal = parseSignal(content);
  if (!signal) {
    log.appendLine('Signal file was empty or stale — ignoring');
    return;
  }

  log.appendLine(`Signal: event=${signal.event}, project=${signal.project}, pids=[${signal.pids.join(',')}], version=${signal.version}`);

  // Play sound
  const config = vscode.workspace.getConfiguration('claudeTerminalFocus');
  if (config.get('sound.enabled', true)) {
    const volume = config.get('sound.volume', 0.5);
    const soundName = signal.event === 'stop' ? 'task-complete' : 'notification';
    playSound(soundName, volume);
  }

  // Show notification
  const action = await showNotification(signal, log);

  if (action === 'focus') {
    log.appendLine('User clicked Focus Terminal');
    await focusMatchingTerminal(signal.pids, log);
  }
}

function checkAllSignalFiles(log) {
  if (!vscode.workspace.workspaceFolders) return;

  for (const folder of vscode.workspace.workspaceFolders) {
    const signalPath = getSignalPath(folder.uri.fsPath);
    if (fs.existsSync(signalPath)) {
      log.appendLine(`Signal found on window focus: ${folder.name}`);
      handleSignal(signalPath, log);
      return;
    }
  }
}

// --- Terminal focusing ---

async function focusMatchingTerminal(pids, log) {
  const terminals = vscode.window.terminals;
  log.appendLine(`Open terminals (${terminals.length}): ${terminals.map(t => t.name).join(', ')}`);

  // Try matching by PID
  for (const terminal of terminals) {
    try {
      const termPid = await terminal.processId;
      if (termPid && pids.includes(termPid)) {
        log.appendLine(`PID match: "${terminal.name}" (PID ${termPid})`);
        await showTerminal(terminal, log);
        return;
      }
    } catch (_) {}
  }

  // Try matching by name
  for (const terminal of terminals) {
    const name = terminal.name.toLowerCase();
    if (name.includes('claude') || name.includes('node')) {
      log.appendLine(`Name match: "${terminal.name}"`);
      await showTerminal(terminal, log);
      return;
    }
  }

  // Fallback: last terminal
  if (terminals.length > 0) {
    const lastTerminal = terminals[terminals.length - 1];
    log.appendLine(`Fallback: last terminal "${lastTerminal.name}"`);
    await showTerminal(lastTerminal, log);
    return;
  }

  log.appendLine('No terminals found to focus');
}

async function showTerminal(terminal, log) {
  await vscode.commands.executeCommand('workbench.action.terminal.focus');
  terminal.show();
  setTimeout(() => {
    const active = vscode.window.activeTerminal;
    log.appendLine(`Active terminal after switch: "${active?.name || 'none'}"`);
  }, 300);
}

// --- Commands ---

async function cmdSetupHooks(context, log) {
  const status = checkHookStatus(context.extensionPath);

  if (status === 'installed') {
    vscode.window.showInformationMessage('Claude Terminal Focus hooks are already installed.');
    return;
  }

  let replaceLegacy = false;
  if (status === 'legacy') {
    const choice = await vscode.window.showInformationMessage(
      'Legacy Claude Terminal Focus hooks detected (shell scripts). Replace with the new Node.js hooks?',
      'Replace', 'Keep Both', 'Cancel'
    );
    if (choice === 'Cancel' || !choice) return;
    replaceLegacy = choice === 'Replace';
  } else {
    const choice = await vscode.window.showInformationMessage(
      'Install Claude Code hooks for notifications and terminal focus? This will modify ~/.claude/settings.json (a backup will be created).',
      'Install', 'Cancel'
    );
    if (choice !== 'Install') return;
  }

  const result = installHooks(context.extensionPath, { replaceLegacy });

  if (result.success) {
    log.appendLine(`Hooks installed. Backup: ${result.backupPath}`);
    vscode.window.showInformationMessage(result.message);

    // Also check gitignore
    const gitStatus = checkGitignoreStatus();
    if (!gitStatus.configured) {
      const gitChoice = await vscode.window.showInformationMessage(
        'Add signal files to global gitignore?',
        'Yes', 'No'
      );
      if (gitChoice === 'Yes') {
        const gitResult = setupGitignore();
        vscode.window.showInformationMessage(gitResult.message);
      }
    }
  } else {
    vscode.window.showErrorMessage(result.message);
  }
}

async function cmdRemoveHooks(log) {
  const choice = await vscode.window.showWarningMessage(
    'Remove Claude Terminal Focus hooks from ~/.claude/settings.json?',
    'Remove', 'Cancel'
  );
  if (choice !== 'Remove') return;

  const result = uninstallHooks();
  if (result.success) {
    log.appendLine(result.message);
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showErrorMessage(result.message);
  }
}

async function cmdSetupGitignore(log) {
  const result = setupGitignore();
  if (result.success) {
    log.appendLine(result.message);
    vscode.window.showInformationMessage(result.message);
  } else {
    vscode.window.showErrorMessage(result.message);
  }
}

async function cmdTestNotification(log) {
  const testSignal = {
    version: 2,
    event: 'notification',
    project: 'Test Project',
    projectDir: '',
    pids: [],
    timestamp: Date.now()
  };

  const config = vscode.workspace.getConfiguration('claudeTerminalFocus');
  if (config.get('sound.enabled', true)) {
    playSound('notification', config.get('sound.volume', 0.5));
  }

  await showNotification(testSignal, log);
  log.appendLine('Test notification sent');
}

// --- First-run checks ---

async function runFirstRunChecks(context, log) {
  const config = vscode.workspace.getConfiguration('claudeTerminalFocus');

  // Check 1: Are hooks installed?
  if (config.get('autoSetupHooks', true)) {
    const status = checkHookStatus(context.extensionPath);
    log.appendLine(`Hook status: ${status}`);

    if (status === 'not-installed' || status === 'no-file') {
      const choice = await vscode.window.showInformationMessage(
        'Claude Terminal Focus: Set up Claude Code hooks for automatic notifications?',
        'Set Up Now', 'Later', "Don't Ask Again"
      );

      if (choice === 'Set Up Now') {
        await cmdSetupHooks(context, log);
      } else if (choice === "Don't Ask Again") {
        await config.update('autoSetupHooks', false, vscode.ConfigurationTarget.Global);
      }
    } else if (status === 'legacy') {
      const choice = await vscode.window.showInformationMessage(
        'Claude Terminal Focus: You have legacy shell-script hooks. Upgrade to the new Node.js hooks for cross-platform support?',
        'Upgrade', 'Later', "Don't Ask Again"
      );

      if (choice === 'Upgrade') {
        await cmdSetupHooks(context, log);
      } else if (choice === "Don't Ask Again") {
        await config.update('autoSetupHooks', false, vscode.ConfigurationTarget.Global);
      }
    }
  }

  // Check 2: Native notifications
  const nativeEnabled = isNativeNotificationsEnabled();
  if (nativeEnabled === false) {
    const choice = await vscode.window.showInformationMessage(
      'Claude Terminal Focus: VS Code native notifications are disabled. Enable them for OS-level alerts when VS Code is in the background?',
      'Open Settings', 'Use Fallback Only', 'Dismiss'
    );

    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'window.nativeNotifications');
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
```

- [ ] **Step 2: Verify no syntax errors**

```bash
cd /Users/dimokol/Documents/WebDev/claude-terminal-focus
node -c extension.js
node -c hook.js
node -c lib/signals.js
node -c lib/sounds.js
node -c lib/hooks-installer.js
node -c lib/gitignore-setup.js
```

Expected: no output (no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add extension.js
git commit -m "feat: rewrite extension for v2 — auto-install, notifications, sound, settings"
```

---

## Task 8: Rewrite README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite README.md for v2**

```markdown
<p align="center">
  <img src="images/icon.png" alt="Claude Terminal Focus" width="128" />
</p>

# Claude Terminal Focus

**All-in-one Claude Code notification system — sound alerts, OS notifications, and terminal focus. One-click setup, zero external dependencies.**

When running multiple Claude Code sessions across different VS Code windows and terminals:

1. **Hear a sound** when Claude finishes a task or needs your input
2. **See an OS notification** showing which project needs attention
3. **Click the notification** to jump directly to the correct VS Code window and terminal tab

Works on **macOS**, **Windows**, and **Linux** with multiple VS Code windows and terminals simultaneously.

## Quick Start

1. **Install** from the VS Code Marketplace:
   - Extensions (Ctrl/Cmd+Shift+X) → Search **"Claude Terminal Focus"** → Install

2. **Set up hooks** — on first activation, the extension will prompt you:

   > *"Set up Claude Code hooks for automatic notifications?"* → **Set Up Now**

   That's it. The extension installs everything automatically.

   Or run manually: `Ctrl/Cmd+Shift+P` → **"Claude Terminal Focus: Set Up Claude Code Hooks"**

## How It Works

```
Claude needs input / finishes task
       │
       ▼
Claude Code fires Stop or Notification hook
       │
       ▼
hook.js writes a JSON signal file (.vscode/.claude-focus)
       │
       ▼
VS Code extension detects the signal
       │
       ├── Plays a sound (configurable)
       └── Shows a notification
                │
                ├── VS Code is unfocused → OS-level toast notification
                └── VS Code is focused → in-window notification + OS fallback
                         │
                         ▼ (user clicks "Focus Terminal")
                         │
                         └── Extension finds the correct terminal tab via PID matching
```

## Recommended: Enable Native Notifications

For the best experience, enable VS Code's native notifications so alerts reach you when VS Code is in the background:

1. **VS Code**: Settings → search "native notifications" → enable **Window: Native Notifications**
2. **macOS**: System Settings → Notifications → Visual Studio Code → Allow Notifications
3. **Windows**: Settings → System → Notifications → Visual Studio Code → On
4. **Linux**: Ensure `libnotify` is installed (most desktops include it)

> The extension also uses `node-notifier` as a fallback, so notifications will work even without this setting — but native notifications provide the most reliable experience.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeTerminalFocus.sound.enabled` | `true` | Play a sound on notifications |
| `claudeTerminalFocus.sound.volume` | `0.5` | Sound volume 0.0–1.0 (macOS/Linux) |
| `claudeTerminalFocus.notification.useFallback` | `true` | Use OS-native fallback when VS Code window is focused (never overrides OS notification preferences) |
| `claudeTerminalFocus.autoSetupHooks` | `true` | Prompt to install hooks on first run |

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`) and search for:

| Command | Description |
|---------|-------------|
| **Claude Terminal Focus: Set Up Claude Code Hooks** | Install hooks in `~/.claude/settings.json` |
| **Claude Terminal Focus: Remove Claude Code Hooks** | Remove hooks (keeps other settings intact) |
| **Claude Terminal Focus: Add Signal Files to Global Gitignore** | Prevent signal files from showing in git |
| **Claude Terminal Focus: Test Notification** | Send a test notification to verify your setup |

## Upgrading from v1.x

If you previously used the shell-script based setup:

1. The extension will detect your legacy hooks and offer to upgrade automatically
2. Choosing **"Replace"** removes the old shell hooks and installs the new Node.js hook
3. Choosing **"Keep Both"** adds the new hook alongside the old ones (both will fire)
4. You can safely delete the old scripts (`~/.claude/notify.sh`, `~/.claude/task-complete.sh`, etc.)
5. `terminal-notifier` is no longer needed — you can uninstall it (`brew uninstall terminal-notifier`)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No notifications | Run **"Test Notification"** from the command palette |
| No sound | Check Settings → `claudeTerminalFocus.sound.enabled` |
| Notifications only appear inside VS Code | Enable native notifications (see above) |
| Extension not activating | Output panel → "Claude Terminal Focus" dropdown |
| Wrong terminal focused | Check Output panel PID matching logs |
| Hooks not firing | Run **"Set Up Claude Code Hooks"** command. Restart Claude Code after setup. |

## How the Hook Works

The extension ships a `hook.js` file that Claude Code runs when it needs your attention. This script:

1. Reads the project directory from `CLAUDE_PROJECT_DIR` environment variable
2. Finds the VS Code workspace root (walks up looking for `.vscode/`)
3. Builds a PID ancestor chain (for terminal tab matching)
4. Writes a JSON signal file to `.vscode/.claude-focus`

The script is pure Node.js with no dependencies — it works identically on macOS, Windows, and Linux.

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for v2 — simplified setup, all platforms"
```

---

## Task 9: Remove legacy scripts and clean up

**Files:**
- Delete: `scripts/` directory

- [ ] **Step 1: Remove old scripts directory**

The old scripts are no longer needed — the extension ships `hook.js` which replaces all of them.

```bash
rm -rf scripts/
```

- [ ] **Step 2: Update .vscodeignore — remove scripts reference**

```
.git/**
.github/**
docs/**
images/icon.svg
.gitignore
.vscodeignore
.DS_Store
```

Note: `scripts/` line removed since the directory no longer exists. `hook.js`, `lib/`, `sounds/`, and `node_modules/` must be included in the VSIX package (they're not listed in .vscodeignore, so they're included by default).

- [ ] **Step 3: Update description in package.json**

Already done in Task 1, but verify the description reads:
```
"description": "All-in-one Claude Code notifications — sound alerts, OS notifications, and terminal focus. One-click setup, zero dependencies."
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove legacy shell/PowerShell scripts, clean up vscodeignore"
```

---

## Task 10: End-to-end testing

- [ ] **Step 1: Package the extension locally**

```bash
cd /Users/dimokol/Documents/WebDev/claude-terminal-focus
npx @vscode/vsce package
```

Expected: produces `claude-terminal-focus-2.0.0.vsix`

- [ ] **Step 2: Install the VSIX in VS Code**

Extensions → `...` menu → "Install from VSIX..." → select the `.vsix` file.

- [ ] **Step 3: Test first-run flow**

1. Open Output panel → "Claude Terminal Focus" → should show "v2.0 activated"
2. Should see prompt: "Set up Claude Code hooks?" → click "Set Up Now"
3. Verify `~/.claude/settings.json` now has Stop + Notification hooks pointing to the extension's `hook.js`
4. Should see prompt about global gitignore → click "Yes"

- [ ] **Step 4: Test the notification command**

1. `Ctrl/Cmd+Shift+P` → "Claude Terminal Focus: Test Notification"
2. Should hear a sound
3. Should see a notification with "Focus Terminal" button

- [ ] **Step 5: Test with real Claude Code**

1. Open a terminal, run Claude Code on a task
2. When Claude stops or needs input, verify:
   - Sound plays
   - Notification appears
   - Clicking "Focus Terminal" switches to the correct terminal tab

- [ ] **Step 6: Test hook removal**

1. `Ctrl/Cmd+Shift+P` → "Claude Terminal Focus: Remove Claude Code Hooks"
2. Confirm removal
3. Check `~/.claude/settings.json` — our hooks should be gone, other settings preserved

- [ ] **Step 7: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```

---

## Summary

| Task | What it produces |
|------|-----------------|
| 1 | npm deps + package.json manifest with commands/settings |
| 2 | `hook.js` + `lib/signals.js` — the cross-platform hook |
| 3 | `lib/sounds.js` + bundled `.wav` files |
| 4 | `lib/notifications.js` — VS Code API + node-notifier fallback |
| 5 | `lib/hooks-installer.js` — auto-install/uninstall hooks |
| 6 | `lib/gitignore-setup.js` — auto-setup gitignore |
| 7 | `extension.js` rewrite — ties everything together |
| 8 | README.md rewrite — clean v2 docs |
| 9 | Remove legacy scripts, clean up |
| 10 | End-to-end testing |
