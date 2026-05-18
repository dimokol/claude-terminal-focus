# Claude Notifications

**All-in-one Claude Code notification system — sound alerts, OS banners, and terminal focus. Zero-interaction setup, fully customizable.**

![OS notification → terminal focus](images/os-notification.gif)

![In-VS-Code toast → terminal focus](images/vsc-banner.gif)

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

## What's New in v3.4.0

- **Right terminal focused on Windows + Git Bash.** Clicking the Focus-Terminal toast (or an OS banner) while Claude was running in a Git Bash terminal used to open the wrong terminal — typically a stray PowerShell. The same matching failure also surfaced a Focus-Terminal toast for users with "Sound only when focused" set, even when they *were* actively on the Claude terminal. Root cause: `terminal.processId` on Git Bash is a launcher PID that isn't in the hook's process-ancestor chain (MSYS2 fork model / winpty / ConPTY break the link), so PID matching silently missed and the extension fell back to the *last* terminal opened. Now uses a four-tier strategy — PID → shell-integration cwd → Claude title markers (`✳`, `⚒`, project basename) → single non-default-shell-named — and never falls back to "last terminal" if nothing confidently matches.
- **Session title in notifications.** Banners and toasts now include Claude Code's auto-generated session title from the transcript: `Task completed in: my-project — Refactor the auth middleware` instead of just the project name. Falls back gracefully when the transcript is missing or has no `ai-title` record.
- **Faster, more reliable PID walking.** `hook.js` now snapshots the process tree in one subprocess call (`Get-CimInstance` on Windows, `ps -A` on POSIX) instead of one subprocess per ancestor. The walk also records process *names* and the first shell ancestor's PID, which the extension uses for the new matching tiers. Future "wrong terminal" reports include a one-line diagnostic in Claude's hook log so we can debug without instrumentation.
- **`AskUserQuestion` multi-choice prompts no longer get swallowed by dedup** — escape valve added in `lib/stage-dedup.js`. See CHANGELOG for the revert plan when upstream [anthropics/claude-code#15872](https://github.com/anthropics/claude-code/issues/15872) ships.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## How It Works

```
Claude fires hook (Stop / Notification / PermissionRequest / UserPromptSubmit)
       │
       ▼
hook.js consults stage-dedup state for this session
       │
       ├─ Re-fire of an already-notified, unresolved stage → exit silently
       │
       └─ Fresh stage (first event for the session, or previous stage acked):
             │
             ▼
       Write signal file → sleep 1.2 s → race the extension
             │
             ├── Extension wins the claim (VS Code is focused):
             │     ├─ Already on the correct terminal → sound only (and ack)
             │     └─ Different terminal / tab        → sound + in-window toast
             │
             └── Hook wins the claim (VS Code not focused / closed):
                   └─ OS banner + sound; clicking it focuses the terminal (and ack)
```

**Key design.** Exactly one notification path fires per stage — never zero, never two for the same stage. Both sides claim the same marker file atomically via `O_EXCL`, so the winner is unambiguous even under rapid concurrent events. A stage advances only when you've engaged (clicked, focused, responded) or Claude moves to a genuinely new state — so re-fires of the same event minutes later are silently dropped.

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
| *(stage advance)* | `UserPromptSubmit` | — (no banner; bumps stageId so the next event re-notifies) | — |

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
| Notification doesn't open VS Code | macOS: run **"Configure macOS terminal-notifier"**. Windows: the extension auto-registers a `claude-notif://` URI handler under `HKCU\Software\Classes\` on activation — no setup needed. If clicks do nothing, check the **"Claude Notifications"** Output panel for `Windows click-handler registered:`. |
| Want to fully uninstall | Run **"Claude Notifications: Uninstall"** before removing the extension. It removes the Claude Code hooks in `~/.claude/settings.json`, the per-workspace state in `~/.claude/focus-state/`, and (on Windows) the `claude-notif://` registry key plus the launcher in `%LOCALAPPDATA%\claude-notifications\`. |
| Duplicate notifications | Update to v3.2+. The new stage-ID dedup suppresses re-fires of the same event until you acknowledge — see [How It Works](#how-it-works). If still duplicating, make sure the legacy `dimokol.claude-terminal-focus` extension is uninstalled. |
| Notifications stop firing | Inspect `~/.claude/focus-state/<hash>/sessions` (where `<hash>` is the 12-char hash for your workspace). If you see `resolved:true` stuck for the active session, that's the dedup remembering you acknowledged a stage. Delete the file to reset; the next event will create a fresh stage. |
| Two `terminal-notifier` entries in macOS Notifications | macOS keeps notification settings per bundle, and a past install (e.g. bundled with `node-notifier` or an older brew version) can linger. Configure the entry you want and leave the other off. To fully reset: `killall NotificationCenter` then fire any notification once to re-register. |
| Wrong terminal focused | Check the **"Claude Notifications"** Output panel for PID matching logs. |
| Hooks not firing | Run **"Set Up Claude Code Hooks"** and restart any active Claude Code sessions so they re-read `~/.claude/settings.json`. |
| Extension not activating | Check the **"Claude Notifications"** channel in the Output panel. |

## How the Hook Works

The extension ships two bundled hooks that Claude Code invokes:

- `dist/hook.js` — runs on `Stop`, `Notification`, and `PermissionRequest`. Decides whether to notify, writes the signal, and races the extension for the claim.
- `dist/hook-user-prompt.js` — runs on `UserPromptSubmit`. Tiny: it just advances the session's `stageId` so the next Stop/Notification is treated as a fresh stage.

`hook.js` flow:

1. Reads `session_id`, `hook_event_name`, and `message` from stdin (Claude's hook input).
2. Reads the project directory from `CLAUDE_PROJECT_DIR` and walks up looking for a `.vscode/` folder to identify the VS Code workspace root.
3. Hashes that workspace root (`sha1` → 12 hex chars) to derive `~/.claude/focus-state/<hash>/`.
4. Calls `shouldNotify(workspaceRoot, sessionId, event)` — if the current stage was already notified for this event type and not yet acknowledged, exits immediately.
5. Builds a PID ancestor chain so the extension can focus the exact terminal tab that spawned Claude.
6. Writes a JSON signal file to `~/.claude/focus-state/<hash>/signal`.
7. Sleeps 1.2 seconds to give the extension time to claim if VS Code is focused.
8. Atomically tries to claim the handled-marker (`O_EXCL`). If the extension or a sibling hook already claimed it, exits silently.
9. Otherwise marks the signal `fired`, plays the configured sound, and shows an OS banner.

A stage is marked **resolved** when:

- You click an OS banner (`terminal-notifier -execute` writes a clicked marker; the extension picks it up and marks resolved).
- You click **Focus Terminal** on an in-window toast.
- The notification fires while you're already focused on the matching terminal (sound-only path).

After `markResolved`, the next event of any type — even the same type — advances the stageId and notifies again.

`hook.js`, `hook-user-prompt.js`, and the extension are all bundled with esbuild, so the installed package has no runtime `node_modules` dependency — just self-contained JS files.

## License

MIT
