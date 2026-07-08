# CLAUDE.md — Project guide for AI agents

> Project: **Claude Notifications** — VS Code extension (publisher `dimokol`, id `dimokol.claude-notifications`).
> Repo name on disk: `claude-terminal-focus` (legacy directory name; do not rename, the publisher id is what users see).
> Current version: **3.6.0**.
> User: solo maintainer, dev machine is macOS, target users are Claude Code users on macOS / Windows / Linux.

This file is the entry point for any Claude / AI coding agent working in this repo. Read it before touching code or doing release work.

---

## What this extension does (in one paragraph)

Claude Code (Anthropic's CLI) fires hooks on `Stop`, `Notification`, `PermissionRequest`, `PreToolUse` (installed with an exact `AskUserQuestion` matcher — the redundant question channel), and `UserPromptSubmit`. This extension installs those hooks (`~/.claude/settings.json`) so they invoke its bundled `dist/hook.js` (and `dist/hook-user-prompt.js`). When Claude needs your attention, the hook either lets the running VS Code extension claim the event (in-window toast + sound + optional Focus-Terminal action) or fires an OS banner itself if VS Code isn't focused. The two sides race for an atomic claim marker so exactly one notification fires per stage. Stage-ID dedup (v3.2.0) suppresses re-fires of the same event until the user acknowledges (clicks the banner, uses Focus Terminal, or is already on the matching terminal) or sends a new prompt.

Read **`README.md`** for the user-facing description; this file focuses on what an agent needs to keep the project healthy.

---

## Architecture map

```
~/.claude/settings.json (Claude Code's hook config — written by the installer)
   └─ on Stop / Notification / PermissionRequest → node hook wrapper → dist/hook.js
   └─ on PreToolUse (matcher: AskUserQuestion)   → node hook wrapper → dist/hook.js
   └─ on UserPromptSubmit                        → node hook wrapper → dist/hook-user-prompt.js

repo root
├── extension.js              # VS Code extension entry. Polls signal files at 400 ms.
├── hook.js                   # Out-of-process Claude Code hook (Stop/Notification/PermissionRequest/PreToolUse[AskUserQuestion]).
├── hook-user-prompt.js       # Out-of-process Claude Code hook (UserPromptSubmit). Tiny — only advances stageId.
├── esbuild.js                # Bundles all three entry points into dist/.
├── package.json              # version, scripts, contributes (commands/settings), extensionDependencies.
│
├── lib/
│   ├── signals.js            # Signal-file parsing + atomic claim marker (`O_EXCL`, sessionId:stageId tags).
│   ├── state-paths.js        # ~/.claude/focus-state/<sha1(workspace).slice(0,12)>/ path derivation (lazy root for test sandboxing).
│   ├── hook-input.js         # Pure hook-stdin classification: notification_type semantics + AskUserQuestion question extraction.
│   ├── terminal-names.js     # User-renamed-tab detection + pid→name cache (extension writes, hook.js reads for banner labels).
│   ├── stage-dedup.js        # Stage-ID state machine (shouldNotify, advanceOnPrompt, markResolved).
│   ├── click-marker.js       # Parse/build the JSON payload terminal-notifier writes on click.
│   ├── process-tree.js       # Cross-platform process snapshot + walkUp/walkDown. Replaces per-PID wmic/ps.
│   ├── terminal-match.js     # Tiered terminal-matching (PID → cwd → Claude markers → non-default-name).
│   ├── hooks-installer.js    # Read/write ~/.claude/settings.json hook entries. As of 3.5.0 entries point at the wrapper (see bin/hook-wrapper.cjs), not at the extension's dist/.
│   ├── hook-runtime.js       # installHookRuntime / uninstallHookRuntime — manages the stable-location wrapper dir at ~/.claude/claude-notifications/.
│   ├── win-protocol.js       # claude-notif:// URI scheme + HKCU registry CRUD (Windows-only side effects; pure helpers tested on macOS).
│   └── sounds.js             # Cross-platform sound playback.
│
├── bin/
│   ├── hook-wrapper.cjs      # Stable-location wrapper invoked by Claude Code's hook subsystem. Detects extension-uninstalled and self-destructs. Bundled to dist/.
│   └── win-click-handler.js  # Launcher invoked by Windows shell when the user clicks the OS toast. Bundled to dist/.
│
├── test/                     # node:test unit tests for state-paths and stage-dedup. Run with `npm test`.
├── docs/
│   ├── publish-checklist.md          # Pre-publish checklist. Always run through it before vsce publish.
│   ├── superpowers/plans/             # Implementation plans for non-trivial work.
│   └── claude-notifications.md        # Older design doc.
├── sounds/                   # Bundled .wav files (notification.wav, task-complete.wav).
├── images/                   # Icon + screenshots.
└── dist/                     # Build output (committed for the VSIX). Never hand-edit.
```

### State directory (runtime, per workspace)

```
~/.claude/focus-state/<sha1(workspaceRoot).slice(0,12)>/
  signal          # JSON v2 signal file (event, sessionId, stageId, pids, question, customName, state) — shared per workspace
  clicked         # JSON click marker written by terminal-notifier -execute. Carries the originating
                  #   session's pids/sessionId/event/project so click-to-focus targets the right
                  #   terminal even if a sibling session has since overwritten `signal`. Empty
                  #   pre-v3.3.1 markers fall back to the signal file.
  claimed         # atomic claim marker (O_EXCL, content `<ts>:<sessionId>:<stageId>`; same-tag stale 5s, cross-tag steal 2s)
  sessions        # JSON map: { sessionId: { stageId, lastEvent, lastHookEventName, resolved, lastNotifiedAt, updatedAt } }
  terminal-names  # JSON { updatedAt, names: { pid: terminalName } } — written by the extension's poll
                  #   (on change + 60s heartbeat); hook.js reads it to put user-renamed tab names on
                  #   OS banners. Stale after 5 min (VS Code closed → expires).
```

This location is **outside** any workspace's `.vscode/` directory and therefore can never appear in `git status`. Do not move it back inside the workspace.

### Stage-ID state machine (`lib/stage-dedup.js`)

```
shouldNotify(workspaceRoot, sessionId, currentEvent, currentHookEventName):
  - no sessionId                            → notify (can't dedup safely)
  - no entry for session                    → create stage 1, notify
  - lastEvent === null                      → set lastEvent=current, notify (post-prompt fresh stage)
  - PR/PreToolUse→Notification within 30s   → SUPPRESS (trailing Notification of a request)
  - resolved === true:
       within burst window OR Notification  → SUPPRESS (trailer / re-fire after ack)
       else (primary after window)          → stageId++, resolved=false, notify
  - unresolved, >3s AND not a Notification  → stageId++, resolved=false, notify
                                              (primary escape — new question/completion)
  - else (within window, OR any Notification) → update lastEvent=current, SUPPRESS

advanceOnPrompt(workspaceRoot, sessionId):  # called by hook-user-prompt.js
  stageId++, lastEvent=null, resolved=false

markResolved(workspaceRoot, sessionId):     # called by extension on EXPLICIT user ack only
  resolved=true
```

**Primary vs trailer (the rule that guarantees exactly one notification per attention point).** Empirically (instrumented 2026-05-29), every attention point is announced by a PRIMARY event — `Stop` (completion) or `PermissionRequest`/`PreToolUse` (a new question / tool request; **every `AskUserQuestion` fires its own `PermissionRequest`**). A bare `Notification` is ALWAYS a trailer or a "still waiting" re-fire of the primary that already notified ("Claude is waiting for your input" / "Claude needs your permission"). So a `Notification` never escapes the burst window — it is always suppressed — while a primary arriving after the window is a genuinely new point and notifies. This guarantees **at least one** notification per question/completion and **at most one** (trailers and late re-fires collapse).

**Question redundancy (3.6.0).** The old premise "#15872: AskUserQuestion fires no PreToolUse" is dead — the issue was closed not_planned (2026-03-15) and `PreToolUse` officially fires for `AskUserQuestion` (documented; since claude-code v2.1.85). Meanwhile AskUserQuestion is documented as NOT permission-gated, so its `PermissionRequest` firing is an implementation artifact upstream could drop any release. We therefore install BOTH: `PermissionRequest` (matcher `''`) and `PreToolUse` (matcher exactly `AskUserQuestion` — never a bare matcher, that would fire for every tool call). When both fire for one question (~simultaneously), the burst window collapses them to one notification; if either disappears upstream, the other still announces the question. **Answering a question does not emit `UserPromptSubmit`** (still true), so back-to-back questions notify via the primary-escape branch. `STAGE_ESCAPE_VALVE_MS = 3000` is just the burst window (collapses the platform pair and the lock-ordering race); it doesn't decide "new vs re-fire" by time.

**notification_type semantics (3.6.0, `lib/hook-input.js`).** `Notification` hook input carries `notification_type`. Status-only types (`auth_success`, `elicitation_complete`, `elicitation_response`) are skipped before dedup. `agent_needs_input` / `agent_completed` (background agents, claude-code ≥2.1.198) and `elicitation_dialog` have NO primary of their own, so they're reclassified as synthetic primaries (dedup name ≠ 'Notification') — otherwise the trailer rule would suppress them forever. `permission_prompt` / `idle_prompt` / unknown stay trailers. Note: Claude Code only fires a dialog's Notification after ~6s of user inactivity, so it was never a reliable channel anyway.

**Important — what counts as an "ack" for `markResolved`:** Focus-Terminal toast click,
OS-banner click. The "Already on correct terminal" sound-only path **does not** call
`markResolved`; doing so would prematurely re-open the gate and let the immediate
follow-up event in the same stage (e.g. Notification right after Stop) re-fire as a
duplicate sound. v3.3.1 fixed exactly this regression.

The unit tests in `test/stage-dedup.test.js` are the authoritative spec — if you change the state machine, update the tests and verify they still describe the intended behavior.

### Terminal-matching tiers (`lib/terminal-match.js`)

When the extension needs to pick *which* VS Code terminal a Claude signal belongs to (Case-A "are you already on the right terminal?" check, Focus-Terminal toast click, OS-banner click), it runs through these tiers in order. The first tier that matches **exactly one** terminal wins; ambiguous tiers (matching 0 or 2+) fall through.

```
1. pid               — terminal.processId is signal.shellPid OR appears in signal.pids
2. cwd               — terminal.shellIntegration.cwd equals (or is under) signal.workspaceRoot / projectDir
3. claude-marker     — terminal name contains ✳, ⚒, ▣, ✻, "claude", or the project basename (≥ 4 chars)
4. non-default-name  — exactly one terminal has a name not in {bash, powershell, pwsh, cmd, zsh, sh, fish, ...}
5. (none)            — return null. NO "last terminal" fallback — switching to a random shell is worse than not switching.
```

Why this exists: on Windows + Git Bash, `terminal.processId` returns a launcher PID that is *not* an ancestor of `node hook.js` (MSYS2 fork model / winpty / ConPTY indirection break the link), so the PID tier silently misses. The cwd and Claude-marker tiers are the recovery path — Claude Code writes its title via ANSI escapes (`✳` busy / `⚒` tool / project basename idle), so any terminal hosting Claude has a distinctive name we can match against.

The PID chain is built in `hook.js#getPidChain` from a single `lib/process-tree.snapshot()` call (one `Get-CimInstance` on Windows, one `ps -A` on POSIX) rather than per-PID subprocesses. The hook also writes a short diagnostic line to stderr — Claude Code captures hook stderr to its hook log, so future "wrong terminal" reports give us `chain depth=… source=… shellPid=… tip=…` without instrumentation.

### Notification ownership invariant

For every stage, **exactly one** of these fires (never zero, never two):

1. The extension claims (VS Code focused) — in-window toast or sound-only.
2. `hook.js` claims (VS Code unfocused/closed) — OS banner + sound.

The race is resolved by `claimHandled()` in `lib/signals.js` using `fs.writeFileSync(claimPath, ..., {flag: 'wx'})` (POSIX `O_EXCL`). Whoever creates the marker first wins; the loser exits silently.

**Claim tags (3.6.0).** The marker content is `<ts>:<sessionId>:<stageId>`. A claimant whose tag MATCHES the marker (same attention point — the extension racing the approved hook, or a crash leftover) defers until `CLAIM_STALE_MS` (5s). A claimant with a DIFFERENT tag is a new, already-dedup-approved attention point and may steal after `CLAIM_CROSS_STAGE_STEAL_MS` (2s). Without the tags, any event approved 3–5s after the previous notification (dedup escape at 3s < claim staleness at 5s) was silently swallowed — zero notifications, the invariant's "never zero" half broken. Untagged (legacy/no-session) claims keep the conservative 5s rule.

---

## Development workflow

### Build

```bash
npm run build         # node esbuild.js — produces dist/extension.js, dist/hook.js, dist/hook-user-prompt.js
```

`dist/` is committed so the VSIX can ship without `node_modules`. Always rebuild after editing `extension.js`, `hook.js`, `hook-user-prompt.js`, or anything in `lib/`.

### Test

```bash
npm test              # node --test test/*.test.js
```

Currently ~230 tests across 17 files (state-paths, stage-dedup + concurrency, signals/claims, hooks-installer, hook-wrapper, hook-runtime, hook-input, click-marker, terminal-match, process-tree, code-build, code-instance-resolver, transcript-title, win-protocol, win-click-handler). The suite sandboxes `HOME` into a temp dir via `test/helpers.js` — any new test that touches state paths must `require('./helpers')`. There is **no UI test harness** for the extension itself — `extension.js` is verified manually via the steps in the relevant plan's "End-to-end manual verification" task. If you add new pure logic, write `node:test` tests for it.

### Manual smoke-test the hook outside VS Code

```bash
mkdir -p /tmp/fake-proj
echo '{"hook_event_name":"Stop","session_id":"smoke-1","message":""}' \
  | CLAUDE_PROJECT_DIR=/tmp/fake-proj node dist/hook.js
cat ~/.claude/focus-state/*/sessions
# cleanup
rm -rf ~/.claude/focus-state/ /tmp/fake-proj
```

### Iterating in a real Claude Code session

After editing the extension or hook, you must:

1. `npm run build` to refresh `dist/`.
2. Reload the VS Code window (`Cmd+R` / `Ctrl+R` in dev host) — the extension reads from `dist/extension.js` at activation.
3. Restart any **active** Claude Code sessions in the terminal. Claude Code reads `~/.claude/settings.json` once on startup; until you restart `claude`, your hooks are stale.

If you forget step 3, you'll edit `hook.js`, rebuild, and wonder why nothing changed — Claude is still invoking the previous bundle's hooks (or no hooks at all).

---

## Pre-publish checklist (canonical)

Always run through this before `vsce publish` (or `vsce package` for a manual VSIX). Mirrors `docs/publish-checklist.md` with v3.2.0 additions.

- [ ] **`version` bumped** in `package.json` (semver: patch for fixes, minor for additions, major for breaking changes to the user contract — settings, command names, hook behavior).
- [ ] **`CHANGELOG.md` updated** with a section for the new version (Changed / Added / Removed / Fixed). Date in `YYYY-MM-DD`.
- [ ] **`README.md` "What's New" section** replaced (not appended) when the new version brings something significant. Keep it scannable — bullets only, lead with the change a user would notice.
- [ ] **`git status` clean.** No staged or unstaged changes.
- [ ] **`npm run build` clean.** No errors, no warnings.
- [ ] **`npm test` green.** All `node:test` tests pass.
- [ ] **`extensionPack`** in `package.json` actually resolves in the Marketplace. The current value `["anthropic.claude-code"]` bundles the Claude Code VS Code extension on install (soft — users can uninstall it without breaking ours, unlike `extensionDependencies`). If that ID disappears from the Marketplace, the *bundle* breaks but our extension still installs. **Verify by visiting** `https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code` before each publish. Remove the entry if uncertain.
- [ ] **Dry-run the package**:
  ```bash
  vsce ls           # lists every file that will ship in the VSIX
  vsce package      # writes claude-notifications-X.Y.Z.vsix
  ```
- [ ] **Inspect the VSIX contents.** Confirm these are NOT in the output:
  - `extension.js`, `hook.js`, `hook-user-prompt.js` (source files — only `dist/*` should ship)
  - `lib/**`, `node_modules/**`, `test/**`, `esbuild.js`
  - `*.vsix`, internal `*.md` files (only README.md, CHANGELOG.md, LICENSE)
  - `CLAUDE.md`
  - `images/icon.svg` (only the rendered PNG should ship)
  - `*.mov` (raw screen recordings — only the converted GIFs in `images/` ship)

  `.vscodeignore` should handle this; verify with `vsce ls`.
- [ ] **Bundles run cross-platform.** If a change touched `dist/hook.js` or `dist/hook-user-prompt.js`, run the hook manually on macOS at minimum (and Windows if accessible) before publish.
- [ ] **Tag the release** in git after `vsce publish`:
  ```bash
  git tag v3.X.Y && git push origin v3.X.Y
  ```

---

## Conventions and constraints

- **No new runtime dependencies.** The extension and hooks must remain `node_modules`-free at runtime — `esbuild` produces self-contained bundles. New dev-time deps (e.g. test helpers) are fine; check `package.json` is in `devDependencies`.
- **Cross-platform paths.** Always `path.join` and `os.homedir()`. Never assume `/` or `\`. Don't hardcode user paths.
- **Atomic file writes.** Anything coordination-related (claim marker, sessions file, signal file) must use atomic primitives or be safe under interleaved reads. `lib/signals.js#claimHandled` uses `O_EXCL`; the sessions file is currently read-modify-write (known race tolerated; see "Known limitations" below).
- **Don't mutate `.vscode/` in user workspaces.** All ephemeral state lives under `~/.claude/focus-state/<hash>/`. The only `.vscode/` interaction is the workspace-root walk that uses `.vscode/` as a heuristic marker.
- **Conventional Commits.** Commit messages: `feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `build:` / `test:`. Optional scope in parens. Used by humans, not automation, so don't optimize for tooling.
- **Comments**: only when the *why* is non-obvious. The codebase has plenty of "// keep readable for stack traces" / "// O_EXCL atomic" / "// 0–100 → amplitude (NOT 0–255)" — those rescue future debuggers from rediscovering past bugs. Don't add narration of *what* the code does.
- **Plans and docs.** Non-trivial work goes through a written plan in `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. The most recent: `docs/superpowers/plans/2026-04-24-v3.2.0-stage-dedup.md`.

---

## Known limitations and tech debt

- **Silent write failures.** `lib/stage-dedup.js#writeSessions` swallows errors. If `~/.claude/focus-state/` becomes unwritable, dedup silently degrades to "always notify". An optional `console.error` to stderr from hook.js (where it lands in Claude's hook log) would surface this. Not critical.
- **`node` must be on Claude Code's PATH for hooks to run.** Hook commands are `node "<wrapper>"`; a machine where `claude` is a native binary and Node.js isn't installed (or isn't on the PATH Claude inherits) gets zero notifications with no in-product error. Claude Code's hook log shows the spawn failure. No fix planned — pinning an absolute node path breaks on version-manager updates.
- **Linux has no click-to-focus.** `notify-send` banners carry no action; clicking does nothing. Sound + banner only.
- **Remote/WSL/SSH is untested.** The extension likely runs on the remote host (no `extensionKind` declared); in-window toasts should work, OS banners/sounds run on the remote side and may be silent on headless hosts. WSLg setups reportedly show notify-send banners.
- **No automated UI tests.** `extension.js` is exercised manually. The `vscode-test` harness is heavy and the manual checklist has been good enough so far.
- **Workspace root heuristic.** `hook.js` walks up looking for a `.vscode/` directory. If the user runs Claude from a deeply nested subdirectory of a non-VS-Code repo, they get an isolated state dir per `claude` invocation. Acceptable.
- **`extensionPack` is softer than `extensionDependencies` was, but still tied to the upstream ID.** If `anthropic.claude-code` is renamed or unpublished, the install-time bundle breaks (our extension still installs fine). See the publish checklist.

---

## Where to look when something breaks

| Symptom | First place to check |
|---|---|
| Duplicate banners | `~/.claude/focus-state/<hash>/sessions` — is `resolved` getting set on ack? Read `extension.js` ack paths. Re-check `stage-dedup.js#shouldNotify`. |
| No banners at all | `~/.claude/settings.json` hook entries (should point at the `~/.claude/claude-notifications/` wrapper). Then check `hook.js` for early-exits (muted, event disabled, dedup suppressed, skip-type notification). Confirm `node` is on Claude's PATH. |
| Questions (AskUserQuestion) don't notify | Both channels should announce them: `PermissionRequest` (matcher `''`) AND `PreToolUse` (matcher `AskUserQuestion`) entries must exist in settings.json. Check the sessions file `lastHookEventName`. Also check the user's claude version: 2.1.198–2.1.199 auto-answered questions after 60s idle (looks like a missed notification; upstream, fixed by updating). |
| Wrong terminal focused | "Claude Notifications" Output channel. Look for `pids=[...]` and `Active terminal after switch`. The PID match logic is in `extension.js#focusMatchingTerminal`. |
| Windows OS-banner click does nothing / opens unexpected window | `reg query "HKCU\Software\Classes\claude-notif\shell\open\command"` — does it exist and point at `%LOCALAPPDATA%\claude-notifications\win-click-handler.js`? Then check the "Claude Notifications" Output channel for `Windows click-handler registered:` at activation. If registration failed (e.g. node not on PATH at activation time), the OS-banner click reverts to no-op. The launcher is rewritten + the registry re-registered on every activation, so a VS Code reload usually self-heals. |
| Wrong terminal after OS-banner click | Look for `Click-to-focus [marker]` vs `[signal-fallback]` in the log. `[marker]` should be the common path. `[signal-fallback]` means the click marker was empty/stale/corrupt — the per-workspace signal file is shared and may point at a sibling session. The marker payload itself is built in `hook.js` (terminal-notifier `-execute`) and parsed by `lib/click-marker.js`. |
| "Already on correct terminal" duplicate sound | The auto-correct-terminal path in `extension.js` MUST NOT call `markResolved`. If it does, the next event in the same stage (Stop→Notification) will re-fire because `shouldNotify` sees `resolved=true` and bumps to a new stage. See v3.3.1 fix. |
| Hook never fires | `~/.claude/settings.json` — was the hook installed? Should point at `~/.claude/claude-notifications/hook.cjs` (wrapper), not at the extension dir directly. Did the user restart their `claude` session after install? |
| `MODULE_NOT_FOUND` errors in Claude after uninstall | Should be impossible as of 3.5.0 — the wrapper self-destructs on first fire after extension removal. If it does happen, the wrapper itself was deleted before it could self-clean. Manual remedy: run the cleanup steps from `cmdUninstall` in `extension.js` (uninstallHooks + uninstallHookRuntime + uninstallWinProtocol + rm focus-state). |
| Build error | `node esbuild.js` output. Most often a require pointing at a deleted file — grep the `lib/` tree. |
| Marketplace install error | `extensionDependencies` resolution. See publish checklist. |

---

## Project context (for the agent)

- **User's role:** solo developer; this is a personal/portfolio extension. **Published on the VS Code Marketplace** (v3.5.5 live as of 2026-07-07: ~1,400 installs, 5.0 rating).
- **Quality bar:** ship-quality but not enterprise. The user prefers concise, decisive recommendations to long deliberation. Confirm before destructive ops; otherwise proceed.
- **Testing reality:** primary dev machine is macOS. Windows testing happens later, on a separate machine. Keep platform-specific code in clearly labeled branches.
- **There ARE production users now** — every schema/behavior change needs an auto-migration path (the `stale-config` / `partial` detection in `hooks-installer.js` is the mechanism; new hook entries or entry-shape changes must be flagged there so existing installs upgrade on activation).

---

## When in doubt

1. Read the relevant plan in `docs/superpowers/plans/`.
2. Run `npm test` after any change to `lib/`.
3. Run `npm run build` after any change to anything bundled.
4. If a change spans more than 3 files or affects the hook/extension contract, propose a plan first.
5. Don't add `node_modules` runtime deps.
6. Don't move state back into `.vscode/`.
7. Don't bypass the `O_EXCL` claim marker — it's the only thing keeping notifications from doubling up under races.
