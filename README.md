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

> The extension also uses `node-notifier` as a fallback when VS Code is focused, so notifications will work even when the VS Code window is in the foreground. The fallback respects your OS notification preferences — it never bypasses Do Not Disturb or mute settings.

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
