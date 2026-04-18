# Claude Notifications

**All-in-one Claude Code notification system — sound alerts, OS banners, and terminal focus. Zero-interaction setup, fully customizable.**

When running multiple Claude Code sessions across different VS Code windows and terminals:

1. **Hear a sound** when Claude finishes a task or needs your input.
2. **See an OS banner** showing which project needs attention — even when VS Code is not in focus.
3. **Click the banner** to jump directly to the correct VS Code window and terminal tab.

Works on **macOS**, **Windows**, and **Linux**, across multiple VS Code windows and terminals simultaneously.

## Quick Start

1. **Install** from the VS Code Marketplace:
   - Extensions (`Ctrl/Cmd+Shift+X`) → search **"Claude Notifications"** → Install.

2. **That's it.** Hooks are installed automatically on first activation — no prompts, no clicks. You'll see a confirmation toast and the status bar shows `$(bell) Claude: Notify`.

   If you ever need to re-run setup: `Ctrl/Cmd+Shift+P` → **"Claude Notifications: Set Up Claude Code Hooks"**.

## What's New in v3.1

- **True atomic dedup.** The hook and the extension race for a single atomic marker file (`O_EXCL`). Whoever wins fires; the other exits silently. Even two events from the same Claude turn (e.g. Stop + Notification at the end of a plan phase) now produce exactly one notification.
- **No more stale in-window toasts.** After firing the OS banner, `hook.js` marks the signal as `fired`. The extension ignores fired signals when you return to VS Code, so you never see a duplicate toast for a banner you already saw.
- **Event priority.** When `waiting` (user action required) and `completed` (just-finished) fire together, the more urgent `waiting` notification wins.
- **Click-to-focus is silent.** Clicking an OS banner now jumps you to the matching terminal without an extra in-window toast.
- **Fixed volume scale.** The `0–100` slider now maps linearly to the audio amplitude (`0.0–1.0`) instead of being interpreted as a `0–255` gain. Default `50` matches typical OS-notification loudness at your current system volume; `100` plays the file at its native level.
- **Smarter macOS setup.** The **Configure** action detects whether `terminal-notifier` is already installed and offers the right next step (install, reinstall, test banner, or open System Settings) instead of always prompting to install.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## How It Works

```
Claude needs input / finishes task / requests permission
       │
       ▼
Claude Code fires Stop, Notification, or PermissionRequest hook
       │
       ▼
hook.js writes a signal file, sleeps 1.2s, then races the extension
       │
       ├── Extension wins the claim (VS Code is focused):
       │     ├─ Already on the correct terminal → sound only (configurable)
       │     └─ Different terminal / tab        → sound + in-window toast
       │
       └── Hook wins the claim (VS Code not focused / closed):
             └─ OS banner + sound; clicking it focuses the terminal
```

**Key design.** Exactly one notification path fires per event — never zero, never two. Both sides claim the same marker file atomically via `O_EXCL`, so the winner is unambiguous even under rapid concurrent events.

## Focus Behavior

The extension **never changes terminal focus without an explicit user action**:

- Clicking **"Focus Terminal"** on an in-window toast.
- Clicking an **OS banner** (focuses VS Code and auto-focuses the matching terminal — no extra toast).

You will never lose your place in a terminal because of a notification.

## Status Bar

The extension adds a status bar item with three states:

- `$(gear) Claude: Set Up` — hooks not installed (click to install).
- `$(bell) Claude: Notify` — notifications active (click to mute).
- `$(bell-slash) Claude: Muted` — notifications muted (click to unmute).

When muted, signal files are still written (so terminal focus still works if you click the banner) but no sound or notification is shown.

## Settings

Settings are grouped per event so you can configure Waiting and Completed independently. All settings are prefixed with `claudeNotifications.` — e.g. `claudeNotifications.volume`.

### Top

| Setting | Default | Description |
|---|---|---|
| `autoSetupHooks` | `true` | Install and upgrade Claude Code hooks automatically. Uncheck to be prompted before any change to `~/.claude/settings.json`. |
| `volume` | `50` | `0` = silent, `50` ≈ typical OS notification, `100` = the sound file's native level. OS master volume still applies. |

### Waiting

Fires when Claude is waiting for your response (Notification + PermissionRequest).

| Setting | Default | Description |
|---|---|---|
| `waiting.action` | `Sound + Notification` | One of `Sound + Notification` · `Sound only` · `Notification only` · `Nothing`. |
| `waiting.sound` | `bundled:notification` | Dropdown of cross-platform values (`none`, two bundled chimes, `custom`). For every sound on your actual OS, use the **Choose Sound…** command. |
| `waiting.customSoundPath` | *(empty)* | Absolute path to a custom audio file. Used only when `waiting.sound` is `custom`. |

### Completed

Fires when Claude finishes a task (Stop).

| Setting | Default | Description |
|---|---|---|
| `completed.action` | `Sound + Notification` | Same options as `waiting.action`. |
| `completed.sound` | `bundled:task-complete` | Same options as `waiting.sound`. |
| `completed.customSoundPath` | *(empty)* | Absolute path to a custom audio file. Used only when `completed.sound` is `custom`. |

### Bottom

| Setting | Default | Description |
|---|---|---|
| `soundWhenFocused` | `sound` | What to do when you're already on the terminal Claude just wrote to: `sound` (play audio cue) or `nothing` (stay silent). |
| `macOS.setup` | — | macOS only. Link to the Configure command — detects whether `terminal-notifier` is installed and offers install / reinstall / test / open Notification Settings. |

#### Picking a system sound

The Settings-UI dropdown only lists cross-platform values because VS Code settings schemas can't be populated at runtime. Every sound actually available on your OS (macOS `/System/Library/Sounds`, Windows `C:\Windows\Media`, Linux freedesktop theme) lives in the **Choose Sound…** command:

1. From a **Waiting Sound** or **Completed Sound** row in Settings, click the **Choose Sound…** link — the picker opens pre-targeted at that event. From the command palette, invoke **"Claude Notifications: Choose Sound"** and pick the event first.
2. Click the **🔊 speaker icon** on any row to hear it at your configured volume. Playback is strictly opt-in — arrow-keying through the list doesn't play anything. The current selection is marked with a `✓`.
3. Highlight the one you want and press Enter to save, or Escape to cancel.

Picking a system sound writes `system:<Name>` to the setting. The Settings UI accepts the value and the extension resolves it at runtime.

#### Previewing your configured sounds

**"Claude Notifications: Preview Sound"** shows exactly two rows — Waiting and Completed — each with the current sound name and a speaker button. Click a speaker (or highlight + Enter) to hear that notification at your configured volume. Use this to check what your notifications will actually sound like.

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`) and search for:

| Command | Description |
|---|---|
| **Set Up Claude Code Hooks** | Install hooks in `~/.claude/settings.json`. |
| **Remove Claude Code Hooks** | Remove hooks (leaves any other settings untouched). |
| **Add Signal Files to Global Gitignore** | Prevent signal files from showing up in `git status`. |
| **Test Notification** | Send a test notification to verify your setup end-to-end. |
| **Toggle Mute** | Mute/unmute notifications (also available via the status bar). |
| **Choose Sound** | Browse bundled, system, and custom sounds per event. |
| **Preview Sound** | Listen to any available sound without changing settings. |
| **Configure macOS terminal-notifier** | Install / reinstall / test / open macOS Notification Settings. |

## Monitored Events

The extension listens to three Claude Code hook events, grouped into two types:

| Type | Hook events | Banner text | Bundled sound |
|---|---|---|---|
| **Waiting** | `Notification`, `PermissionRequest` | "Waiting for your response in: *{project}*" | `notification.wav` |
| **Completed** | `Stop` | "Task completed in: *{project}*" | `task-complete.wav` |

## macOS Setup

For the best click-to-open experience on macOS, install `terminal-notifier`. The extension prompts you on first activation **only if it's missing**, or you can run it anytime:

`Ctrl/Cmd+Shift+P` → **"Claude Notifications: Configure macOS terminal-notifier"**

The command detects whether `terminal-notifier` is already installed and offers the right action: install (via Homebrew), reinstall, send a test banner, or open System Settings → Notifications. The same entry is available under **Settings → Claude Notifications → macOS: Setup**.

After installing: **System Settings → Notifications → terminal-notifier** → set to **Alerts** (banners disappear after a few seconds; alerts stay until dismissed).

> **About duplicate `terminal-notifier` entries in System Settings.** If you see two `terminal-notifier` rows, macOS is remembering registrations from past installs (e.g. an older brew version, or one bundled with `node-notifier` inside some `node_modules`). Keep the entry configured the way you want and leave the other off. This extension only talks to the `terminal-notifier` on your `PATH` — it never registers a second copy.

Without `terminal-notifier`, the extension falls back to `osascript` notifications (which work but don't support click-to-open).

## Upgrading from v1.x

If you previously used the shell-script setup:

1. The extension detects legacy hooks and offers to upgrade automatically.
2. Choosing **"Replace"** removes the old shell hooks and installs the new Node.js hook.
3. You can safely delete the old scripts (`~/.claude/notify.sh`, `~/.claude/task-complete.sh`, etc.).

## Troubleshooting

| Problem | Solution |
|---|---|
| No notifications at all | Run **"Test Notification"** from the command palette. Check the status bar isn't showing `Muted`. |
| No sound | Check that `waiting.action` / `completed.action` aren't set to `Notification only` or `Nothing`, and that `volume` is > 0. |
| Sound is too loud or too quiet | Adjust `volume`. `50` matches typical OS-notification loudness; `100` plays the file at its native level. OS master volume still applies. |
| Notification doesn't open VS Code | macOS: run **"Configure macOS terminal-notifier"**. Windows: click-to-open uses `vscode://` — no setup needed. |
| Duplicate notifications | Update to v3.1+. If still duplicating, make sure the legacy `dimokol.claude-terminal-focus` extension is uninstalled. |
| Two `terminal-notifier` entries in macOS Notifications | macOS keeps notification settings per bundle, and a past install (e.g. bundled with `node-notifier` or an older brew version) can linger. Configure the entry you want and leave the other off. To fully reset: `killall NotificationCenter` then fire any notification once to re-register. |
| Wrong terminal focused | Check the **"Claude Notifications"** Output panel for PID matching logs. |
| Hooks not firing | Run **"Set Up Claude Code Hooks"** and restart any active Claude Code sessions so they re-read `~/.claude/settings.json`. |
| Extension not activating | Check the **"Claude Notifications"** channel in the Output panel. |

## How the Hook Works

The extension ships a bundled `dist/hook.js` that Claude Code runs when it needs your attention. The script:

1. Reads the project directory from the `CLAUDE_PROJECT_DIR` environment variable.
2. Walks up looking for a `.vscode/` folder to find the VS Code workspace root.
3. Builds a PID ancestor chain so the extension can focus the exact terminal tab that spawned Claude.
4. Writes a JSON signal file to `<workspace>/.vscode/.claude-focus`.
5. Sleeps 1.2 seconds to give the extension time to claim the signal if VS Code is focused.
6. Atomically tries to claim the handled-marker. If the extension already claimed it, exits silently.
7. Otherwise marks the signal as `fired`, plays the configured sound, and shows an OS banner.

`hook.js` and the extension are both bundled with esbuild, so the installed package has no runtime `node_modules` dependency — just two self-contained JS files per platform.

## License

MIT
