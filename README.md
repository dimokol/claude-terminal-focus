# <img src="images/icon.png" alt="Claude Notifications" width="36" align="top" /> Claude Notifications

**All-in-one Claude Code notification system — sound alerts, OS notifications, and terminal focus. One-click setup, zero external dependencies.**

When running multiple Claude Code sessions across different VS Code windows and terminals:

1. **Hear a sound** when Claude finishes a task or needs your input
2. **See an OS notification** showing which project needs attention — even when VS Code is not in focus
3. **Click the notification** to jump directly to the correct VS Code window and terminal tab

Works on **macOS**, **Windows**, and **Linux** with multiple VS Code windows and terminals simultaneously.

## Quick Start

1. **Install** from the VS Code Marketplace:
   - Extensions (Ctrl/Cmd+Shift+X) → Search **"Claude Notifications"** → Install

2. **Set up hooks** — on first activation, the extension will prompt you:

   > *"Set up Claude Code hooks for automatic notifications?"* → **Set Up Now**

   That's it. The extension installs everything automatically.

   Or run manually: `Ctrl/Cmd+Shift+P` → **"Claude Notifications: Set Up Claude Code Hooks"**

## How It Works

```
Claude needs input / finishes task / needs permission
       │
       ▼
Claude Code fires Stop, Notification, or PermissionRequest hook
       │
       ▼
hook.js runs OUTSIDE VS Code:
       │
       ├── Writes JSON signal file (.vscode/.claude-focus)
       ├── Plays sound (platform-native: afplay / PowerShell / paplay)
       └── Shows OS notification (terminal-notifier / Windows toast / notify-send)
                │
                ▼ (user clicks notification)
                │
                └── Opens the correct VS Code window (via code CLI / vscode:// URI)
                         │
                         ▼
                    Extension detects signal file → focuses the correct terminal tab
```

**Key design**: Sound and notifications are handled by the hook script (outside VS Code), not by the extension. This means notifications work reliably regardless of which VS Code window is focused, or even if you're in a completely different application.

## Status Bar

The extension adds a status bar item showing the current notification state:

- `$(bell) Claude: Notify` — notifications active
- `$(bell-slash) Claude: Muted` — notifications muted

Click it to toggle mute. When muted, signal files are still written (for terminal focus) but no sound or notification is shown.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeNotifications.sound.enabled` | `true` | Play a sound on notifications |
| `claudeNotifications.sound.volume` | `0.5` | Sound volume 0.0–1.0 (macOS/Linux) |
| `claudeNotifications.autoSetupHooks` | `true` | Prompt to install hooks on first run |

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`) and search for:

| Command | Description |
|---------|-------------|
| **Claude Notifications: Set Up Claude Code Hooks** | Install hooks in `~/.claude/settings.json` |
| **Claude Notifications: Remove Claude Code Hooks** | Remove hooks (keeps other settings intact) |
| **Claude Notifications: Add Signal Files to Global Gitignore** | Prevent signal files from showing in git |
| **Claude Notifications: Test Notification** | Send a test notification to verify your setup |
| **Claude Notifications: Toggle Mute** | Mute/unmute notifications (also available via status bar) |

## Monitored Events

The extension monitors three Claude Code events:

| Event | When it fires | Notification |
|-------|--------------|-------------|
| **Stop** | Claude finishes a task | "Task completed in: {project}" + Glass sound |
| **Notification** | Claude needs your input | "Waiting for your response in: {project}" + Funk sound |
| **PermissionRequest** | Claude needs permission | "Permission needed in: {project}" + Funk sound |

## macOS Note

For the best click-to-open experience on macOS, install `terminal-notifier`:

```bash
brew install terminal-notifier
```

Then: **System Settings → Notifications → terminal-notifier** → set to **Alerts**.

Without it, the extension falls back to `osascript` notifications (which work but don't support click-to-open-VS Code).

## Upgrading from v1.x

If you previously used the shell-script based setup:

1. The extension will detect your legacy hooks and offer to upgrade automatically
2. Choosing **"Replace"** removes the old shell hooks and installs the new Node.js hook
3. You can safely delete the old scripts (`~/.claude/notify.sh`, `~/.claude/task-complete.sh`, etc.)
4. `terminal-notifier` is still useful on macOS for click-to-open (but no longer required)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No notifications | Run **"Test Notification"** from the command palette |
| No sound | Check Settings → `claudeNotifications.sound.enabled` and status bar mute state |
| Notification doesn't open VS Code | macOS: install `terminal-notifier` (`brew install terminal-notifier`). Windows: VS Code registers `vscode://` URI automatically. |
| Extension not activating | Output panel → "Claude Notifications" dropdown |
| Wrong terminal focused | Check Output panel PID matching logs |
| Hooks not firing | Run **"Set Up Claude Code Hooks"** command. Restart Claude Code after setup. |

## How the Hook Works

The extension ships a `hook.js` file that Claude Code runs when it needs your attention. This script:

1. Reads the project directory from `CLAUDE_PROJECT_DIR` environment variable
2. Finds the VS Code workspace root (walks up looking for `.vscode/`)
3. Builds a PID ancestor chain (for terminal tab matching)
4. Writes a JSON signal file to `.vscode/.claude-focus`
5. Plays a sound using platform-native commands
6. Shows an OS notification using platform-native commands

The script is pure Node.js with no npm dependencies — it works identically on macOS, Windows, and Linux.

## License

MIT
