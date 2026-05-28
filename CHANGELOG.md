# Changelog

## [3.5.5] - 2026-05-23

### Fixed
- **Windows: OS-banner toast never appeared on real Claude Code sessions.** 3.5.4's commit `6dbf134` introduced direct `spawn('powershell.exe', ..., { windowsCreateProcessFlags: ['CREATE_BREAKAWAY_FROM_JOB', 'DETACHED_PROCESS', 'CREATE_NO_WINDOW'] })` to escape Claude Code's hook job object without the cmd/start console flash. Caught live on Windows 10 + Node 24.3.0: `spawn` succeeds (no throw), Claude Code's job-object teardown still kills the PowerShell child before WinRT's `Show($toast)` reaches the OS. Proof: temp `.ps1` left undeleted in `%TEMP%` (its own `finally { Remove-Item }` never ran) and `LastNotificationAddedTime` never advanced for the firing AUMID. BREAKAWAY is silently ineffective on Claude Code's job — the documented `ERROR_ACCESS_DENIED` would have surfaced as a sync throw and caught the fallback, but it doesn't on this job configuration. Fix: replace the two-path spawn (Node ≥22.5 windowsCreateProcessFlags / Node <22.5 cmd-start) with a single proven-working chain — `cmd /c start "" /B wscript.exe hide.vbs powershell.exe -File <tmp>`. `start /B` is the only escape that actually works for Claude's job; wrapping the PS spawn in `wscript.exe hide.vbs` (the silent launcher we already ship for the click handler) runs PowerShell with `intWindowStyle=0` at CreateProcess time, so no console window is ever allocated — eliminating the "PowerShell flash" / "desktop refresh" Ada and the 2026-05-23 tester both reported on plain cmd/start.
- **Windows: notification sound never played.** Same root cause as the toast — sound spawn used direct `spawn('powershell', ..., { detached, windowsHide })` without job escape, so Claude Code's hook job kill landed before WPF's `MediaPlayer.Play()` reached the audio device. Wrapped sound spawn in the same `cmd /c start /B wscript hide.vbs powershell -File <tmp>` chain. Sound now fires reliably with no console flash.
- **Windows: clicking the OS-banner toast did nothing.** 3.4.0's `claude-notif://` URI scheme works fine when invoked via `Start-Process` (registry is correct, `wscript.exe → hide.vbs → node → win-click-handler.js` chain runs and writes the click marker) — but the Windows toast click activation pipeline silently drops custom URI schemes on Win10 + the `Microsoft.Windows.Shell.RunDialog` AUMID we use. Tried adding an explicit `<action activationType="protocol">` button — also silent. Fix: switch the toast `launch=` attribute to `vscode://dimokol.claude-notifications/click?marker=<base64>`, and register `vscode.window.registerUriHandler` in the extension. When the user clicks the banner, Windows shell routes the URI to VS Code, VS Code routes it to our extension's `UriHandler.handleUri`, which parses the marker payload and focuses the matching terminal in-process — no file mediation, no preemptive write. This also fixes a regression briefly considered in development (writing the click marker preemptively + using `vscode://file/<workspace>` as launch URI) where the extension's polling loop would pick up the marker BEFORE the user actually clicked the banner — switching terminals while VS Code was still in the background. The UriHandler approach requires an explicit click by design. Trade-off: VS Code shows its one-time "external application wants to open this URI" prompt on first banner click after upgrade — user clicks "Open" and ticks "Do not ask me again for this extension" to make it permanently silent.
- **Windows: VS Code didn't come to the foreground over fullscreen apps on banner click.** With the UriHandler architecture, VS Code's URI activation receives the URI but its main window stays behind whatever fullscreen app the user was using (only the taskbar button flashes). This is the Windows foreground-stealing restriction — VS Code's extension host receives the URI in the background and doesn't have foreground rights. Fix: extracted the existing `bin/win-click-handler.js` AttachThreadInput-based focus-steal logic into a shared `lib/win-focus.js`, and the UriHandler now spawns a detached PowerShell helper that resolves Code.exe's HWND from the marker's PID chain and calls `AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow`. The PS helper temporarily merges its input queue with whatever's currently in foreground, gaining the focus privilege long enough to bring VS Code in front.
- **Uninstall left stale hook entries in non-default Claude profiles.** `cmdUninstall` and "Remove Hooks" only stripped hooks from `~/.claude/settings.json`. Users with additional profiles (`.claude-work`, `.claude-other`, etc.) were left with dangling hook entries pointing at the deleted wrapper — Claude would silently error on every message until the user manually edited those files. Both commands now iterate `discoverProfiles()` and strip from every discovered profile.
- **`.backup` files from hook installs were never removed.** `installHooks` writes a `.backup` alongside every settings.json it modifies. `cmdUninstall` and the wrapper's `selfDestruct` now delete those backup files during cleanup so no trace is left behind.
- **Windows: OS-banner click can now raise VS Code to the foreground (opt-in), not just flash the taskbar.** Root-caused 2026-05-28: the long-standing "only the taskbar flashes" behavior was due to Windows' `HKCU\Control Panel\Desktop\ForegroundLockTimeout` (default `200000`ms), which forbids background processes — including our extension-host click handler — from calling `SetForegroundWindow`. No technique beats it while it's non-zero (AttachThreadInput, Alt-key tap, protocol-activation, or even VS Code's own `vscode://file/` handler all reduce to a taskbar flash). New opt-in setting `claudeNotifications.windows.forceForeground` (default `false`) sets it to `0` — verified to apply live without re-login — after which the existing correct-window HWND-targeting (`lib/win-focus.js` + `lib/code-instance-resolver.js`) raises the exact VS Code instance on the first try. A one-time prompt explains the change (safe, instantly reversible); the original value is saved and restored on opt-out or uninstall. New `lib/win-foreground-lock.js` with unit tests.
- **Windows: removed the "Windows Script Host — Can not find script file hide.vbs" error dialog.** When `%LOCALAPPDATA%\claude-notifications\hide.vbs` was missing, the toast/sound spawn invoked `wscript.exe <missing>` and Windows popped a blocking error dialog while the notification silently failed. The spawn now checks for `hide.vbs` and falls back to a plain `cmd /c start /B powershell` chain (brief console flash, but the notification always fires) when it's absent.

## [3.5.4] - 2026-05-22

### Fixed
- **Windows: dedup auto-migration didn't fire for pre-3.5.4 entries** — left users with 13 duplicate hook entries per event on upgrade. Phase 0.2 of Ada's Windows live-test (2026-05-21) reproduced this exactly: a fresh 3.5.4 install on a machine that already had 12 pre-3.5.4 entries appended a 13th instead of collapsing to 1. Root cause: `OUR_HOOK_IDENTIFIERS` only listed the single-backslash form `claude-notifications\hook.cjs`, but pre-3.5.4 entries had been written via the `JSON.stringify(path)` bug — their command strings contain double backslashes in memory after JSON round-trip (`claude-notifications\\hook.cjs`). The substring match missed → `checkHookStatus` returned `'not-installed'` → the install path appended a fresh entry instead of stripping the legacy ones. Fix: added the `\\hook.cjs` and `\\hook-user-prompt.cjs` variants to the identifier list. Two new regression tests reproduce Ada's 12→13 scenario and assert the migration now collapses to 1 entry per event AND that `checkHookStatus` no longer reports `not-installed` on legacy-only configs.
- **Windows: PowerShell console window flashes on every notification.** The cmd/start indirection added in 2eef937 to escape Claude Code's hook job object causes PowerShell to allocate a fresh console because hidden cmd has no console to inherit, and `-WindowStyle Hidden` hides it only after creation. Fix: switched to direct `spawn('powershell.exe', ..., { windowsCreateProcessFlags: ['CREATE_BREAKAWAY_FROM_JOB', 'DETACHED_PROCESS', 'CREATE_NO_WINDOW'] })` on Node ≥ 22.5. The BREAKAWAY flag escapes the job (preserving 2eef937's toast-survival fix), and `CREATE_NO_WINDOW` + `DETACHED_PROCESS` together suppress console allocation at `CreateProcess` time — no window is ever created, so there's nothing to flash. On Node < 22.5 the legacy cmd/start path is kept as a fallback. Caught in Ada's Bug A.
- **Windows: Node console window flashes on every OS-banner click + click failed to actually focus VS Code** — two distinct bugs in the click-handler path, both fixed:
  1. **Console flash:** the registry handler invoked `node.exe launcher.js %1` directly. Node is a console-subsystem binary so Windows always allocates a console window for it, even for fire-and-forget scripts. Fix: shipping a tiny `bin/hide.vbs` wrapper (bundled to `dist/hide.vbs` and copied to `%LOCALAPPDATA%\claude-notifications\` on activation) and registering the handler as `wscript.exe "<vbs>" "<node>" "<launcher>" "%1"`. `wscript.exe` is a windowless host and `WScript.Shell.Run(..., 0, False)` launches Node fully hidden. Fallback to direct-node-invocation if `hide.vbs` is missing (e.g., older builds).
  2. **Focus stealing:** a background process can only flash the taskbar button via `SetForegroundWindow` — Windows blocks actual focus changes from non-foreground processes. Fix: added `AttachThreadInput` + `BringWindowToTop` to the P/Invoke chain in `bin/win-click-handler.js`. Briefly attaching to the foreground window's thread merges input queues and lets us inherit focus permission long enough for `SetForegroundWindow` to succeed; we detach immediately after to avoid input lock-up. Caught in Ada's Bug B.
- **OS-banner click landed on the wrong terminal (or did nothing) when multiple Claude sessions share a workspace.** Caught live during testing: with two `✳ ...` Claude terminals open in the same workspace, the OS-banner click handler called `focusMatchingTerminal` which ran `matchTerminal` — tier=pid missed (firing session's `shellPid` not present), tier=cwd matched both terminals (ambiguous → fall through), generic claude-marker tier matched both ✳ terminals (also ambiguous → fall through), tier=non-default-name same → matcher returned `null`, no terminal switch. Fix: new `ai-title` tier (priority 2.5, between cwd and the generic claude-marker tiers) does a substring match on the signal's `aiTitle` — Claude Code writes the session's auto-generated task title to the terminal name via ANSI title escapes, so each running session has a **unique** title. With multiple Claude terminals in one workspace, this is often the only unique discriminator. Min length 4 to avoid spurious substring collisions, ambiguous matches still fall through, strict-PID rule still short-circuits when applicable. 5 new tests including the multi-session repro fixture.
- **No Focus-Terminal toast when on a sibling Claude terminal in the same workspace.** Two-part fix:
  1. `lib/terminal-match.js` — added a strict-PID escape: when `signal.shellPid` is present and the signal carries `pidChainSource='ps'` (POSIX, where shellPid reliably appears in `terminal.processId`), a tier=PID miss is treated as a definitive negative match and the matcher returns `null` instead of falling through to the looser cwd/marker tiers. Windows + Git Bash setups (where `pidChainSource='powershell'` and the chain is masked by MSYS2/winpty indirection) are unaffected — the cwd/marker fallbacks remain active there. 5 new tests cover the rule (POSIX strict-null, POSIX positive, Windows-not-strict, missing chain-source, missing shellPid).
  2. `extension.js#handleSignal` — Case A now passes ALL window terminals to `matchTerminal` (not just the active one) and then compares the match's index to the active terminal's index. Active matches → sound-only branch (current behaviour). A different terminal in this window matches → fall through to the Focus-Terminal toast. No terminal matches → also fall through to toast. This eliminates the false-positive that fired sound-only when the user was on a sibling Claude session's terminal — the matcher had only seen the active terminal's cwd which (correctly) matched the workspace, but couldn't tell it was the wrong Claude session.
- **Duplicate sound for every `AskUserQuestion`.** Caught live during a real-time diagnostic session: Claude Code fires `PermissionRequest` then `Notification` for the same multi-choice question, but the gap between them on macOS (and reportedly Windows multi-monitor) can be 3–10+ seconds — far longer than the 3-second `STAGE_ESCAPE_VALVE_MS` window. The escape valve was firing for the trailing `Notification`, treating it as a brand-new attention point, so the user heard two sounds (or saw two banners) for one logical question. Fix: targeted `PR_NOTIFICATION_BURST_MS = 30s` guard in `lib/stage-dedup.js#shouldNotify` that collapses `PermissionRequest`→`Notification` and `PreToolUse`→`Notification` pairs for the same session. The generic 3-second escape valve is unchanged for all other transitions (Stop+Notification platform burst, genuine new attention points after gap, etc.), so legitimate new events aren't suppressed. 7 new tests assert the guard fires for PR→Notification within window, does NOT fire outside the window, does NOT widen Stop→Notification, does NOT suppress a second PR (new tool call), applies to PreToolUse the same way, and that `UserPromptSubmit` correctly clears the PR-context so the next event starts fresh.

### Added
- **`claudeNotifications.toastWhenFocused` setting** (default `false`). When you're already on the terminal Claude just wrote to, the existing default behaviour (audio cue only, no visible UI) is unchanged. Flip this to `true` to also get an in-window info toast in that branch — useful for multi-monitor / small-terminal-panel layouts or accessibility, where the audio alone can be missed. The toast is info-only (no "Focus Terminal" action button — that would be a no-op since the matcher already confirmed you're on the right terminal). The companion `soundWhenFocused` setting continues to control audio independently. Both settings respect the per-event `action` (Sound + Notification / Sound only / Notification only / Nothing), so e.g. setting `waiting.action = "Notification only"` + `toastWhenFocused = true` gives you visual-only attention cues across all terminal-match scenarios.

### Fixed
- **Duplicate sound after clicking an OS banner for an `AskUserQuestion`.** Real-world reproduce caught in a live diagnostic session: Claude Code fires `PermissionRequest` and `Notification` ~1s apart for the same AskUserQuestion. If the user clicks the OS banner fast (after PR but before Notification arrives), `handleClickedSignal` calls `markResolved`, the dedup state machine's `resolved=true` branch then treats the immediately-following Notification as a fresh new stage and fires it again — user hears two sounds for one question. v3.3.1 fixed exactly this pattern for the correct-terminal sound-only path but the banner-click path went uncovered. Fix: in the `resolved=true` branch of `shouldNotify`, if the ack landed inside the burst window (`now - lastNotifiedAt < STAGE_ESCAPE_VALVE_MS`), suppress as a burst-duplicate instead of advancing stage. Outside the window (a real new attention point arriving later), advance + notify as before. Two new tests assert the guard and two existing tests now backdate `lastNotifiedAt` to exercise the post-window path explicitly.
- **Windows: hook entries accumulated as duplicates with every VS Code restart.** A friend on Windows + Git Bash reported "no notifications at all" — diagnostic dump showed her `~/.claude/settings.json` had the same hook command registered **12 times** for every event type. Root cause: `lib/hooks-installer.js#getHookCommand` was building the command string via `` `node ${JSON.stringify(wrapperHookPath)}` ``. On POSIX paths (no backslashes) this round-trips fine, but on a Windows path like `C:\Users\Ada\.claude\claude-notifications\hook.cjs`, `JSON.stringify` produces a JS string with literal **double** backslashes (`C:\\Users\\...`). After settings.json round-trip the stored command in memory contained `claude-notifications\\hook.cjs` (two `\` characters), while `OUR_HOOK_IDENTIFIERS` checks for the substring `claude-notifications\hook.cjs` (one `\`). Two consequences cascaded:
  1. `checkHookStatus` permanently returned `'not-installed'` after every install — the identifier match failed against the just-written command.
  2. `installHooks`'s strip-before-push filter (line 200-208) found nothing to strip, so every activation appended a new entry to an already-installed array.
  Effect: N VS Code launches → N hook entries → N hook processes spawned per Claude event (with the O_EXCL claim race deduping the actual notification, but each process still doing useless work and amplifying the existing Windows toast-survival race). Fix: replace `JSON.stringify(path)` with plain `"${path}"` quoting in both `getHookCommand` and `getUserPromptHookCommand`. macOS unaffected.
- **Windows: OS-banner toast often never appeared after 3.5.1.** 3.5.1 removed the `cmd /c start "" /B powershell ...` wrapper that 3.5.0 used to launch the toast PowerShell, on the reasoning that `process.exit(0)` + `detached: true` + `unref()` would let the PS child survive Claude Code's hook process tearing down. That reasoning was incorrect: Windows job-object teardown isn't gated on the parent process being alive — it's gated on the **job handle** being closed. When Claude Code's hook subsystem closes its handle to the hook's job (immediately after the hook exits), `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills every process in the job, including our still-cold PowerShell that hasn't reached `ToastNotificationManager.Show()` yet. The empirical proof: the friend who reported 3.5.2 silently failed notifications on Git Bash *and* native PowerShell setups. The cmd/start wrapper detaches the eventual PS into a fresh process group that breaks away from the inherited job, so PS survives long enough to register the toast with the OS. Trade-off: under Git Bash this re-introduces the brief PS console flash 3.5.1 fixed — accepted as the lesser evil until we can require Node 22.5+ (`windowsCreateProcessFlags: ['CREATE_BREAKAWAY_FROM_JOB']` would give us a flash-free job break).

### Added
- `test/hooks-installer.test.js` regressions (3 cases): the install→checkHookStatus round-trip on a Windows-style path now passes; installHooks is provably idempotent across 12 sequential calls on both Windows and POSIX paths. These would have caught the double-backslash bug — pre-fix the round-trip case fails on `checkHookStatus` returning `'not-installed'`.

## [3.5.3] - 2026-05-20

### Fixed
- **Duplicate notification on the FIRST event of a session.** Two concurrent races, each with a single-winner check in isolation, lined up to let both Stop and Notification hooks fire for the same logical "Claude finished" moment — most visible at session start where there's no prior state to dampen the race. Race #1 was a classic read-modify-write hole in `lib/stage-dedup.js#shouldNotify`: Claude Code fires Stop and Notification as separate hook processes ~100ms apart, both read `sessions.json` before either writes, both see "no entry", both decide `notify=true`. Race #2 was in `lib/signals.js#claimHandled`'s stale-recovery branch — the `stat → unlink → writeFileSync(wx)` sequence let two processes that both passed the staleness check both end up succeeding when their unlinks and writes interleaved just right. Fixed both:
  - **`stage-dedup.js`** now wraps `shouldNotify`/`advanceOnPrompt`/`markResolved` in an O_EXCL lock-file critical section (`<state-dir>/dedup.lock`), serializing per-workspace dedup state mutations. Stale locks (>2s, indicating a process crash) get stolen automatically. Sessions writes are temp+rename atomic.
  - **`signals.js`** restructures the stale-claim recovery so `unlink` itself is the contention point (POSIX guarantees exactly one unlinker on a given inode), then races the create under O_EXCL. Two single-winner steps, no interleaving window.
- The **AskUserQuestion escape valve** (same-stage event after >3s triggers a fresh-stage notify) is fully preserved — explicit `escape-valve` test in the new concurrency suite verifies a 3.5s gap still fires.

### Added
- `test/stage-dedup-concurrency.test.js` (4 cases): 50 forked workers all calling `shouldNotify` on a brand-new session — asserts exactly 1 returns `notify=true`. Post-prompt burst, mixed Stop/Notification burst, escape-valve preservation.
- `test/signals.test.js` claim tests (4 cases): single caller / fresh-marker rejection / stale-marker steal / 50-worker concurrent stale-steal — exactly 1 winner.

## [3.5.2] - 2026-05-20

### Fixed
- **Windows: OS-banner click now focuses the EXACT VS Code instance that produced the notification, even when multiple VS Code windows are open.** Previously the click launcher invoked `code "<workspace>"`, which routes through VS Code's per-user CLI pipe and lands on whichever instance was most recently focused — not the one Claude was actually running in. With Instance B firing the banner and Instance A focused on a different monitor (or the same monitor, or a different desktop), Instance A would intercept the click and open the workspace itself, leaving the user staring at the wrong terminal panel. The launcher now: (1) reads the original Claude session's process-ancestor chain from the click marker; (2) walks up to find that instance's renderer `Code.exe` (`lib/code-instance-resolver.js`, deterministic per-instance — each VS Code window has its own renderer process tree); (3) shells out to PowerShell with inline Win32 P/Invoke (`EnumWindows` + `GetWindowThreadProcessId` + `SetForegroundWindow`) to focus that specific HWND. Multi-instance Windows now behaves identically to multi-instance macOS — clicks always land on the originating instance. Falls back to the legacy `code <workspace>` path automatically on any failure (process gone, no HWND found, P/Invoke error, PS timeout >3s), so the worst case is exactly 3.5.1's behaviour — never worse.

### Added
- `claudeNotifications.windows.clickBehavior` setting (default `"hwnd"`, alternative `"cli"`). Forces the click-routing strategy up front. Useful as an escape hatch if the HWND path misbehaves on a specific Windows build — flip to `"cli"` and you're identical to 3.5.1.
- `lib/code-instance-resolver.js` — pure-JS PID-chain → renderer-Code.exe resolver. Supports Code stable, Code Insiders, VSCodium / Codium, Cursor, Windsurf. 12 `node:test` cases including a multi-instance regression fixture.

## [3.5.1] - 2026-05-19

### Fixed
- **Windows: PowerShell console flashed before every notification under Git Bash.** The OS-banner toast was launched via `cmd.exe /c start "" /B powershell.exe -File <tmp>` — the cmd/start indirection was originally a workaround so PowerShell would survive being inside Claude Code's job object. But because `cmd.exe` itself was launched with `windowsHide: true` (no console), `start /B` had no parent console to attach to and the OS allocated a fresh console for PowerShell; `-WindowStyle Hidden` then hid it AFTER allocation, causing a visible flash. Under native PowerShell shells the chain happened to allocate the console invisibly, but Git Bash exposed it consistently. The job-escape workaround is no longer needed — 3.5.0's explicit `process.exit(0)` + detached + unref guarantees the child outlives the parent. The toast now spawns `powershell.exe` directly with Node's `windowsHide: true`, which passes `CREATE_NO_WINDOW` to `CreateProcess` so no console is ever allocated. No flash, no focus-steal.
- **Windows: clicking the OS banner opened bogus untitled placeholder files instead of focusing the workspace.** The `claude-notif://` click launcher used `spawn('code', [workspaceRoot], { shell: true })`. With `shell: true` + args-as-array, Node joins args with literal spaces and *does not quote them*. A workspaceRoot like `D:\SilvWeb Studio\Projects\2026\SilvWeb Labs\labs.silvweb.studio` (5 spaces) became 6 bogus CLI args, and VS Code created untitled placeholder tabs with those names instead of focusing the workspace. The launcher now builds a single fully-quoted command string and passes it to `spawn`, so paths with spaces survive intact through cmd.exe.

### Notes
- Multi-desktop Windows behaviour (banner click on Desktop A activates a VS Code instance on Desktop B and switches you to B) is OS behaviour, not extension behaviour — Windows always brings the originating app's window to focus on the desktop it lives on. We can't override that.

## [3.5.0] - 2026-05-19

### Changed
- **Hook contract: `settings.json` now points at a stable-location wrapper, not at the extension's `dist/` directory.** The wrapper lives at `~/.claude/claude-notifications/{hook.cjs,hook-user-prompt.cjs}` and reads a sibling `state.json` to find the current extension's real hook bundles. On every Claude hook fire, the wrapper checks whether the extension is still installed:
  - **Yes** → it `require()`s the real bundle in-process (one fs.readFile + JSON.parse + require — under 10ms overhead). Behaviour identical to pre-3.5.0.
  - **No** (extension uninstalled / dir deleted) → it self-destructs: strips its own hook entries from every discovered Claude profile (`~/.claude/settings.json` and every `~/.claude-*/settings.json`, skipping `.claude-backup*`), removes `~/.claude/focus-state/`, removes the Windows `claude-notif://` registry handler + `%LOCALAPPDATA%\claude-notifications\` if present, and removes its own directory. Exits with empty stdout so Claude Code sees a clean hook completion. The next message is fully silent — no `MODULE_NOT_FOUND` spam, no manual cleanup script.
- **Auto-migration on upgrade.** First 3.5.0 activation detects pre-3.5.0 direct-to-extension hook entries (by matching `dimokol.claude-notifications` in the command string) and rewrites them to point at the wrapper. Stale hook entries from old extension dirs no longer accumulate across upgrades.
- The existing **"Claude Notifications: Uninstall"** palette command now also removes the wrapper dir — and is now strictly optional rather than required for clean uninstall, because the wrapper handles cleanup on its own.

### Added
- `lib/hook-runtime.js` — `installHookRuntime(extensionPath)` / `uninstallHookRuntime()`. Manages the wrapper directory + `state.json`. Both injectable-fs for testing.
- `bin/hook-wrapper.cjs` — the self-contained wrapper script bundled to `dist/hook-wrapper.cjs` and copied to the runtime dir on activation. Dependency-free (only `node:` builtins) so it runs without any install step.
- `test/hook-wrapper.test.js` (9 cases) — wrapper self-destruct invariants on a temp-dir mock home: foreign hooks preserved, legacy direct-to-extension entries detected, malformed settings.json tolerated, idempotent.
- `test/hook-runtime.test.js` (6 cases) — install/uninstall + idempotency of the runtime dir.

### Why
VS Code provides no uninstall hook — `deactivate()` fires on every window close too, so an extension cannot reliably tell unload from uninstall. Until 3.5.0 this meant hook entries in `~/.claude/settings.json` outlived the extension dir, causing `MODULE_NOT_FOUND` on every Claude message after uninstall (and a "running stop hook" stall in extreme cases). The wrapper inverts the ownership: `settings.json` references a path *we* control, and we know how to clean ourselves up the next time we fire and find the extension gone.

## [3.4.0] - 2026-05-19

### Fixed
- **CRITICAL: Stop hook no longer blocks Claude Code for seconds (or minutes on Windows).** The sound-playback subprocess was launched via `execFile(file, args, callback)`, which keeps Node's event loop alive until the child closes its stdio handles. On macOS this added ~1 s per hook fire (afplay's playback duration). On Windows it was much worse — PowerShell cold-start + WPF `MediaPlayer` setup + WAV duration routinely tipped past 5 s per message, and a latent bug in the PS script (`[System.Uri]::new('C:\…', Absolute)` is not a valid absolute URI, so the fast WPF path threw and fell into the catch with `SoundPlayer.PlaySync()`) combined with `while (-not $p.NaturalDuration.HasTimeSpan)` having no watchdog meant a flaky load could spin forever, leaving Claude Code stuck at `running stop hook · X minutes` until the user hit ESC. All three sound spawns (`afplay`, `powershell` WPF, `paplay`/`aplay`) now use `spawn(..., { detached: true, stdio: 'ignore', windowsHide: true })` + `child.unref()`; the PowerShell script uses a proper `file:///` URI and bounds its readiness loop with a 3-second deadline; and the hook ends with an explicit `process.exit(0)` so any subprocess slow to release handles can't block the parent.
- **Windows: OS-banner click now focuses the existing VS Code window and the matching Claude terminal — no more "An external application wants to open …" prompt.** The toast previously used `launch="vscode://file/<path>"`, which (1) trips VS Code's `security.promptForLocalFileProtocolHandling` (default `true` since 1.78) every time, and (2) opens the path as a *new* VS Code window instead of switching to an existing window that already has the workspace open — particularly painful in the "empty VS Code + folders dragged in" workflow where the path isn't a recognized workspace root. The toast now uses a custom `claude-notif://` URI handler registered per-user under `HKCU\Software\Classes\` on first extension activation. The bundled launcher at `%LOCALAPPDATA%\claude-notifications\win-click-handler.js` writes the click marker (so the extension's existing `handleClickedSignal` flow runs and focuses the right terminal — same UX as macOS) and shells out to the `code` CLI (which does *not* trip the security prompt). Registration is self-healing — every activation rewrites the registry value with the current launcher and node paths, so reinstalls and updates never leave orphan keys. A new **"Claude Notifications: Uninstall"** command in the palette cleans up hooks, registry, launcher dir, and state dir in one shot.
- **Windows: notification text mojibake (`Claude Code â€" Done`).** The OS-banner script was written to a temp `.ps1` as UTF-8 without a BOM, and Windows PowerShell 5.1 reads BOM-less `.ps1` files as the system ANSI code page (CP1252) — so the em-dash (`—`, UTF-8 `E2 80 94`) was decoded as `â€"`. `hook.js` now prepends a UTF-8 BOM (`﻿`) so PS 5.1 reads the script as UTF-8.
- **Windows: PowerShell console window flashed briefly before each notification.** Sound playback shells out to `powershell` via `execFile`, which on Windows allocates a console window unless `windowsHide` is set. Both call sites (`hook.js` OS-fallback sound, `lib/sounds.js` settings-preview sound) now pass `{ windowsHide: true }`.
- **Wrong terminal focused on Windows + Git Bash (and other wrapped shells).** When Claude Code was running in a Git Bash terminal inside VS Code, clicking the "Focus Terminal" toast or an OS banner opened the wrong terminal (typically a stray PowerShell) instead of the Git Bash where Claude was working. The same matching failure also surfaced a Focus-Terminal toast in cases where the user had "Sound only when focused" configured and *was* on the Claude terminal. Root cause: `terminal.processId` on Git Bash is the launcher process whose PID does NOT appear in the hook's PID ancestor chain (MSYS2 fork model / winpty / ConPTY break the link). When PID match failed, the extension fell through `"claude"`/`"node"` substring matching (Claude Code writes neither) to a "last terminal" fallback. Fixed in two layers: (1) `hook.js` now takes a single cross-platform process-tree snapshot (`Get-CimInstance Win32_Process` on Windows, `ps -A` on POSIX) and emits process names alongside pids plus an explicit `shellPid` for the first shell ancestor (`bash.exe`, `pwsh.exe`, `cmd.exe`, etc.); (2) `extension.js` now picks the matching terminal via a four-tier strategy — PID match → shell-integration `cwd` match → Claude title markers (`✳`/`⚒`/project basename, written by Claude Code via ANSI title escapes) → single non-default-shell-named terminal — and **removes the "last terminal" fallback entirely**. Better to do nothing than switch to an arbitrary shell.

### Added
- **Session title in notifications and logs.** Notifications and the "Claude Notifications" Output channel now include Claude Code's auto-generated session title (the `aiTitle` record from the transcript), so banners and toasts read like `Task completed in: my-project — Refactor the auth middleware` instead of just the project name. Resolved from `transcript_path` on each hook fire via a tail-scan for the most recent `ai-title` record; falls back to project-only text when the transcript is missing, malformed, or has no `ai-title` entries. Truncated to 60 chars to fit the macOS subtitle width.
- `lib/process-tree.js` — cross-platform process-tree snapshot plus pure `walkUp` / `walkDown` helpers. Replaces the per-PID `wmic`/`ps` loop that was slow, silent on failure, and broken on Windows 11 23H2+ where `wmic` may be absent.
- `lib/terminal-match.js` — pure tiered terminal-matching with `node:test` coverage including a fixture for the original v3.3.2 user report.
- Signal payload v2 now carries `pidNames` (pid → process name), `shellPid`, and `pidChainSource` for diagnosis.
- One-line stderr diagnostic from `hook.js` (`claude-notifications: chain depth=… source=… shellPid=… tip=…`). Claude Code captures hook stderr.

### Fixed
- **`AskUserQuestion` multi-choice prompts no longer get silently swallowed by stage dedup.** When Claude Code asked a follow-up multi-choice question seconds after a prior `Stop`/`Notification` event in the same stage, the dedup state machine treated it as a fresh-burst duplicate and suppressed it — the user got no sound, no banner, no in-window toast. Root cause: `AskUserQuestion` does not fire `PreToolUse`/`PostToolUse` hooks (upstream [anthropics/claude-code#15872](https://github.com/anthropics/claude-code/issues/15872)), so the extension never sees the user's answer and the stage stays unresolved across multiple genuinely-distinct waits. `lib/stage-dedup.js#shouldNotify` now applies a 3-second escape valve: an event arriving in the same unresolved stage but more than `STAGE_ESCAPE_VALVE_MS` after `lastNotifiedAt` is treated as a new stage and notifies. The Stop/Notification platform-duplicate burst fires within ~100–200ms so it still collapses to a single alert. When #15872 ships, revert this and wire a `PostToolUse` hook that calls `advanceOnPrompt` on `AskUserQuestion` completion — see `CLAUDE.md` for the revert plan.

## [3.3.2] - 2026-05-08

### Fixed
- **Windows: in-window toasts and the claim race were silently broken.** The state-directory hash is computed from the workspace path, but the two layers feed it different strings: `hook.js` receives `CLAUDE_PROJECT_DIR` from Claude Code (forward-slash, often uppercase drive — e.g. `C:/WebDev/foo`), while `extension.js` reads VS Code's `folder.uri.fsPath` (backslash, kernel drive case — e.g. `c:\WebDev\foo`). The two SHA1s diverge, the extension's polling loop watches an empty directory, and the OS-banner fallback in `hook.js` always wins — giving the user sound only, no in-window toast, no Output-channel logs, and no claim race to deduplicate against. `lib/state-paths.js` now normalizes the path before hashing: forward-slashes, lowercased Windows drive letter, no trailing slash. macOS and Linux are unaffected — the normalization is a no-op on POSIX paths.
- **Windows: OS-banner toast didn't reliably fire from `hook.js`.** Sound played, no banner appeared, and the toast often didn't even show up in Action Center. Root cause: the WinRT `ToastNotificationManager.CreateToastNotifier(...).Show(...)` call was made from a PowerShell process spawned with `spawn(..., {detached: true, stdio: 'ignore'})` running an inline `-Command <script>` — but on Windows that pattern leaves the child inside the parent's job object, so when Claude Code tore down its hook process tree the still-warming-up PowerShell child got killed before WinRT finished registering the toast. Fix: `hook.js` now writes the toast script to a temp `.ps1` and launches it via `cmd /c start "" /B powershell -File <tmp>`, which fully detaches via `start`'s new process group; the script ends with a small `Start-Sleep` to give WinRT room to complete and self-deletes the temp file in a `try/finally`. Matches the pattern the v2 PS1 setup used (which is where we know it worked).

### Added
- `normalizeWorkspaceRoot()` exported from `lib/state-paths.js` plus `node:test` coverage that every plausible Windows path-style variant (`C:/`, `c:/`, `C:\`, `c:\`, with/without trailing slash) hashes to a single state directory.

## [3.3.1] - 2026-05-06

### Fixed
- **OS-banner click focused the wrong terminal in multi-session workspaces.** When two or more Claude Code sessions were running in the same VS Code workspace, clicking a banner from session B would sometimes leave the terminal panel on session A. The click marker created by `terminal-notifier`'s `-execute` was an empty `touch` file with no payload, so `handleClickedSignal` had to read the per-workspace `signal` file to recover which terminal to focus — but that file is shared across sessions and gets overwritten by every hook firing. The marker now embeds a JSON payload of the originating session's `pids`, `sessionId`, `event`, and `project`. The signal file remains as a best-effort fallback for legacy/empty/stale markers.
- **Duplicate sound on the "already on correct terminal" path.** The extension was calling `markResolved()` whenever it claimed a signal while the matching terminal was active. Setting `resolved=true` corrupted the dedup state machine: the immediate follow-up event in the same stage (e.g. Notification right after Stop, ~1 s apart) hit the resolved branch in `shouldNotify`, advanced to a new stageId, and re-fired as a second sound. `markResolved` is now reserved for *explicit* user acks (Focus-Terminal click, OS-banner click); the auto-correct-terminal path lets the dedup state machine collapse Stop→Notification naturally.

### Added
- `lib/click-marker.js` — `parseClickMarker` / `buildClickMarkerPayload` with `node:test` coverage for the legacy empty-touch fallback, JSON shell-escape round-trip, stale-timestamp rejection, and pid sanitization.
- Click-handler logs now show `Click-to-focus [marker]` vs `[signal-fallback]` so it's obvious in the Output channel which source supplied the pids.

### Changed
- `CLAUDE.md` updated: the stage-dedup spec now matches the actual code (different event types within an unresolved stage are *suppressed*, not promoted to a new stage), and a new troubleshooting row covers click-marker provenance.

## [3.3.0] - 2026-05-03

### Added
- **Multi-profile hook auto-fix.** The extension now scans every Claude Code config profile on the machine (`~/.claude/` plus any `~/.claude-*` directory used via `CLAUDE_CONFIG_DIR`) and updates stale hook paths or adds the missing `UserPromptSubmit` hook in each. Previously only the default profile (`~/.claude/settings.json`) was migrated, so users with multiple Claude accounts or workspace profiles silently broke after every extension upgrade — every hook fire in the un-migrated profile would `MODULE_NOT_FOUND`. `~/.claude-backup-*` directories are skipped (treated as user-owned backups, not active profiles).

### Changed
- `lib/hooks-installer.js` — `checkHookStatus`, `installHooks`, and `uninstallHooks` accept an optional `settingsPath`. New exports `discoverProfiles()` and `checkAllProfiles(extensionPath)`.

## [3.2.1] - 2026-05-01

### Fixed
- **Duplicate banner when `Stop` is followed by `Notification("waiting for your input")`.** Claude Code commonly emits both events seconds apart for the same logical attention point. v3.2.0's stage-ID dedup treated the event-type change as a new stage and fired a second banner — frequently after the user had already glanced at the terminal for the first one and stepped away. `lib/stage-dedup.js` no longer treats event-type change as a stage boundary; only user-prompt or explicit ack advances the stage. The legitimate "permission interrupts a wait" case is unaffected because both hook events normalize to the same `waiting` bucket in `hook.js`.

### Changed
- **`extensionDependencies` → `extensionPack`** for `anthropic.claude-code`. Same install-time pull-in, but Claude Code can now be uninstalled without breaking this extension and a future rename/unpublish of the upstream ID can no longer brick installs of this one.
- **README leads with two GIFs** (OS-banner-to-terminal and in-VS-Code-toast-to-terminal) so the Marketplace listing shows the actual behavior above the fold.
- **Added `hooks` keyword** to package.json for Marketplace search.

## [3.2.0] - 2026-04-25

### Changed
- **Stage-ID dedup replaces the 5-second session timer.** Each session now tracks a `stageId` that advances on (a) `UserPromptSubmit`, (b) a different event type than the last notified one, or (c) the previous stage being resolved by user acknowledgment (banner click, Focus Terminal action, or having focus on the matching terminal). Same-event re-fires on an unresolved stage are suppressed at the source — no banner, no sound. Removes the "ghosts long after I already clicked the first one" failure mode the 5s window couldn't catch.
- **All coordination state moved out of `.vscode/`** into `~/.claude/focus-state/<sha1(workspace).slice(0,12)>/`. The signal, click marker, claim marker, and sessions file no longer touch the workspace and can never appear in a repo's git changes.

### Added
- New `UserPromptSubmit` hook (`dist/hook-user-prompt.js`) that advances the session's stageId so the next event after a user prompt always fires a fresh notification.
- `node:test` unit tests for `lib/state-paths.js` and `lib/stage-dedup.js` (`npm test`).

### Removed
- The "Add signal files to global gitignore?" prompt and the `claudeNotifications.setupGitignore` command — no longer needed now that state lives outside the workspace.
- `lib/gitignore-setup.js` module.

## [3.1.4] - 2026-04-23

### Fixed
- **Phantom double-notifications on Claude 2.1.x.** Recent Claude CLI builds fire duplicate hooks per turn — `Stop` immediately followed by `Notification("Claude is waiting for your input")`, `PermissionRequest` followed by `Notification("Claude needs your permission…")`, and occasionally multiple `Stop` events in rapid succession. The result was two (sometimes three) OS banners and sounds for one logical event. `hook.js` now deduplicates per `session_id` via a small on-disk map at `.vscode/.claude-focus-sessions`: the first hook in a 5-second window notifies; subsequent hooks for the same session within that window exit silently. A new turn — user response → Claude work → next event — realistically takes longer than 5 s, so legitimate notifications still fire.

### Added
- **Diagnostic fields in signals.** Signal files now carry `hookEventName`, `hookMessage`, and `sessionId` verbatim from Claude's hook stdin. The extension's Output channel logs the raw event name (e.g. `event=waiting(Notification)`) and an 8-char session tag alongside the normalized event, making it straightforward to diagnose duplicate-hook patterns from a single log paste.

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
