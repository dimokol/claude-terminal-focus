# Changelog

## [3.1.3] - 2026-04-23

### Fixed
- **terminal-notifier / Homebrew detection on macOS.** When VS Code is launched from the Dock or Finder it inherits a minimal `launchd` PATH that doesn't include `/opt/homebrew/bin`, so `command -v terminal-notifier` and `command -v brew` both returned empty even when both were installed. The Mac Setup pane therefore showed the "Configure terminal-notifier" prompt for users who already had it, and clicking **Install** then reported "Homebrew not found." Detection now probes `/opt/homebrew/bin`, `/usr/local/bin`, and `/opt/local/bin` directly via `fs.accessSync` before falling back to the shell lookup, and the brew install command uses the absolute `brewPath` so the setup terminal doesn't depend on PATH either.

### Changed
- **Activation log reads the version from `package.json`** instead of a hardcoded `v3.1` string, so the Output channel header always matches the installed build.

## [3.1.2] - 2026-04-16

### Breaking — settings keys renamed (no auto-migration)
Keys are now grouped by event rather than by implementation category. Old keys are **removed** from the schema; any customizations under them are lost and need to be re-set from the Settings UI.

| Old | New |
|---|---|
| `events.waiting` | `waiting.action` |
| `events.completed` | `completed.action` |
| `sounds.waiting` | `waiting.sound` |
| `sounds.waitingPath` | `waiting.customSoundPath` |
| `sounds.completed` | `completed.sound` |
| `sounds.completedPath` | `completed.customSoundPath` |
| `sounds.volume` | `volume` |

### Added
- **Cross-platform sound picker** for both **Choose Sound…** and **Preview Sound…**. Arrow-keying never auto-plays — each previewable row has a `$(unmute)` speaker button; click it to hear that sound at your configured volume. Current selection is marked with `✓`. System-sound section is scanned at runtime from `/System/Library/Sounds` (macOS), `C:\Windows\Media` (Windows), or the freedesktop theme (Linux), so each OS only shows sounds that exist on the machine.
- **Context-aware Choose Sound.** The **Choose Sound…** link on a Waiting/Completed sound setting now opens the picker pre-targeted at that event (passes the event as a command argument). The command-palette invocation still asks.
- **Focused Preview Sound.** **Preview Sound** now shows two rows — Waiting and Completed — each with the currently configured sound name, target file path, and a speaker button. Lets you answer "what will my notifications actually sound like?" in two clicks.

### Changed
- **Settings layout.** New order in the VS Code Settings UI: Auto Setup Hooks · Volume · **Waiting** (Action, Sound, Custom Sound Path) · **Completed** (Action, Sound, Custom Sound Path) · Sound When Focused · Mac OS › Setup. VS Code's auto-generated section headings (e.g. `Waiting ›`) now come from the dotted key prefix.
- **Descriptions trimmed** throughout. No more paragraphs about VS Code schema limitations, OS-specific sound directories, or `system:<Name>` technical notes — each setting has one clear sentence.
- **`macOS.setup`** moved to the last position with a one-line description: "macOS only. [Configure terminal-notifier] for click-to-open banners."
- **`autoSetupHooks`** is symmetric: checked (default) = install/upgrade silently with a confirmation toast; unchecked = prompt before any change to `~/.claude/settings.json`, both on fresh install *and* legacy-hook upgrades.
- **`terminal-notifier` setup command** is context-aware: "Configure macOS terminal-notifier" instead of always "Set Up…". Detects installed state and offers install / reinstall / test banner / open System Settings.
- **osascript fallback** no longer requests a sound (hook already plays one via `afplay`; dropping the OS chime prevents overlap).
- **Tighter icon**, 1024 × 1024 → 256 × 256 with transparent padding cropped so the extension fills its list square. VSIX total ≈ 240 KB.
- **README cleaned up.** Removed the broken `demo.gif` reference, outdated size claims, and the redundant "What's New in v3.0" section; collapsed the history to the current version only (full history lives in this changelog).

### Fixed
- **Preview Sound now actually plays at the configured volume** — the old command read the (now-removed) `sounds.volume` key and would have silently fallen back to the default after the rename.
- **`Cannot find module './lib/signals'` crash in the Stop hook.** 3.1.1 refactored `hook.js` to share signal helpers with the extension but the shipped VSIX excluded `lib/**`, so the hook exploded at runtime. Hook is now bundled with esbuild into `dist/hook.js` as a single self-contained script, matching how the extension itself is packaged. `hooks-installer.js` writes that path to `~/.claude/settings.json`; `autoFixHookPaths` migrates anyone on a pre-3.1.2 install automatically on next VS Code activation.
- **Click-to-focus showed a redundant toast** after clicking an OS banner. The extension now focuses the matching terminal silently when it sees the clicked-marker file that `terminal-notifier`'s `-execute` leaves behind.
- **Duplicate OS banners** on rapid events: `hook.js` claims the handled-marker with `O_EXCL` atomic create so only one instance can fire per event.
- **Duplicate in-window toast after an OS banner** — the signal file is now marked `fired` after the banner fires, so later polling/focus handlers skip it.
- **Event priority** — when `completed` and `waiting` fire near-simultaneously (plan phase finishing + approval prompt), `waiting` now wins, matching urgency.

## [3.1.1] - 2026-04-16

### Fixed
- **Notification sound was dangerously loud.** `afplay -v` is an amplitude multiplier (1.0 = unity) but the code mapped `0–100 → 0–255`. Default `volume=50` was playing at `-v 128` — 128× amplification, hard-clipped to maximum, ignoring OS master volume. Result: painfully loud notifications even at low system volume. Now maps linearly to `0.0–1.0`, so `50` ≈ typical OS notification at current OS master volume and `100` = the file's native level. Same fix applied to Linux (`paplay --volume`, 0–65536 scale).
- **Windows playback now respects the volume setting** via WPF `MediaPlayer` (falls back to the old `SoundPlayer` if PresentationCore isn't loadable).

## [3.1.0] - 2026-04-16

### Fixed
- **Duplicate OS banners** — hook.js now uses atomic file creation (`O_EXCL`) for the handled marker. When Claude fires two hook events close together (e.g., Stop + Notification at the end of a plan phase), only one notification is emitted. Previously both hook instances could race past the non-atomic "already claimed?" check and each fire a banner.
- **Duplicate in-window toast after OS banner** — hook.js now marks the signal as `fired` after firing the OS banner. When the user returns to VS Code later, the extension's polling loop and window-focus handler both skip fired signals instead of surfacing a second toast for the same event.
- **Double notification from legacy extension** — the new extension detects when `dimokol.claude-terminal-focus` (the old published name) is still installed and warns the user to uninstall it. Both extensions activating simultaneously was the primary cause of the "OS banner + VS Code toast for the same signal" report.
- **Click-to-focus showed a redundant toast** — clicking an OS banner now focuses the matching terminal silently. Previously the extension would also pop up a "Focus Terminal" toast even though the user had already clicked.
- **Event priority inverted under race** — when `completed` fires before `waiting` (e.g., plan phase ends before approval prompt), the more urgent `waiting` notification now wins.

### Changed
- `terminal-notifier` setup command is context-aware: "Configure macOS terminal-notifier" instead of always "Set Up …". Detects installed state and offers install / reinstall / test banner / open System Settings.
- Settings pane description for `claudeNotifications.macOS.setup` rephrased to neutral "Configure / Verify" wording instead of always recommending a fresh setup.
- osascript fallback no longer requests a sound (the extension already plays one via `afplay` — dropping the OS chime prevents overlap).

## [3.0.0] - 2026-04-15

### Added
- **Notification dedup handshake** — exactly one notification per event, never zero, never two. Extension and hook coordinate via claim markers.
- **Two-type event model** — `waiting` (Notification + PermissionRequest) and `completed` (Stop). Simpler settings, clearer copy.
- **Per-event sound customization** — choose different sounds per event type from bundled, OS system, or custom audio files.
- **"Choose Sound" and "Preview Sound" commands** — browse and test all available sounds.
- **macOS terminal-notifier setup** — one-time prompt, re-runnable command, Settings UI button.
- **`soundWhenFocused` setting** — play a sound even when already on the correct terminal, or stay silent.
- **Auto-fix hook paths** when extension updates (no more silent breakage).
- **Auto-install hooks** on fresh install (zero-interaction setup).
- **Status bar "Set Up" state** when hooks are missing.
- **esbuild bundling** (VSIX reduced from 3.2 MB to ~100 KB).
- **Focus behavior contract** — extension never auto-changes terminal focus without a click.
- Gallery banner, expanded keywords, this changelog.

### Changed
- Volume setting now uses 0–100 scale (was 0.0–1.0)
- Poll interval reduced from 800ms to 400ms for faster claim response
- Three-tier notification: sound only when on correct terminal, in-window toast when on wrong tab, OS notification when in different app

### Removed
- `node-notifier` dependency (was unused, ~3 MB savings)
- Three-type event model (replaced by simpler two-type model)

## [2.1.0] - 2026-04-14

### Added
- PermissionRequest event support
- Status bar mute toggle
- Moved sound and OS notifications to hook.js (runs outside VS Code for reliability)

## [2.0.0] - 2026-04-13

### Added
- Complete rewrite as Node.js-based system
- Cross-platform support (macOS, Windows, Linux)
- PID-based terminal tab matching
- Auto-install hooks command
- Bundled sound files (Glass, Funk)
- JSON signal file format (v2)

## [1.0.0] - 2026-04-03

### Added
- Initial release with shell-script hooks
- macOS support via terminal-notifier
- Basic terminal focus on notification click
