# CLAUDE.md — Project guide for AI agents

> Project: **Claude Notifications** — VS Code extension (publisher `dimokol`, id `dimokol.claude-notifications`).
> Repo name on disk: `claude-terminal-focus` (legacy directory name; do not rename, the publisher id is what users see).
> Current version: **3.2.0**.
> User: solo maintainer, dev machine is macOS, target users are Claude Code users on macOS / Windows / Linux.

This file is the entry point for any Claude / AI coding agent working in this repo. Read it before touching code or doing release work.

---

## What this extension does (in one paragraph)

Claude Code (Anthropic's CLI) fires hooks on `Stop`, `Notification`, `PermissionRequest`, and `UserPromptSubmit`. This extension installs those hooks (`~/.claude/settings.json`) so they invoke its bundled `dist/hook.js` (and `dist/hook-user-prompt.js`). When Claude needs your attention, the hook either lets the running VS Code extension claim the event (in-window toast + sound + optional Focus-Terminal action) or fires an OS banner itself if VS Code isn't focused. The two sides race for an atomic claim marker so exactly one notification fires per stage. Stage-ID dedup (v3.2.0) suppresses re-fires of the same event until the user acknowledges (clicks the banner, uses Focus Terminal, or is already on the matching terminal) or sends a new prompt.

Read **`README.md`** for the user-facing description; this file focuses on what an agent needs to keep the project healthy.

---

## Architecture map

```
~/.claude/settings.json (Claude Code's hook config — written by the installer)
   └─ on Stop / Notification / PermissionRequest → node dist/hook.js
   └─ on UserPromptSubmit                       → node dist/hook-user-prompt.js

repo root
├── extension.js              # VS Code extension entry. Polls signal files at 400 ms.
├── hook.js                   # Out-of-process Claude Code hook (Stop/Notification/PermissionRequest).
├── hook-user-prompt.js       # Out-of-process Claude Code hook (UserPromptSubmit). Tiny — only advances stageId.
├── esbuild.js                # Bundles all three entry points into dist/.
├── package.json              # version, scripts, contributes (commands/settings), extensionDependencies.
│
├── lib/
│   ├── signals.js            # Signal-file parsing + atomic claim marker (`O_EXCL`).
│   ├── state-paths.js        # ~/.claude/focus-state/<sha1(workspace).slice(0,12)>/ path derivation.
│   ├── stage-dedup.js        # Stage-ID state machine (shouldNotify, advanceOnPrompt, markResolved).
│   ├── hooks-installer.js    # Read/write ~/.claude/settings.json hook entries.
│   └── sounds.js             # Cross-platform sound playback.
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
  signal       # JSON v2 signal file (event, sessionId, pids, project, state)
  clicked      # zero-byte marker dropped by terminal-notifier -execute
  claimed      # atomic claim marker (O_EXCL, 5 s lifespan)
  sessions     # JSON map: { sessionId: { stageId, lastEvent, resolved, lastNotifiedAt, updatedAt } }
```

This location is **outside** any workspace's `.vscode/` directory and therefore can never appear in `git status`. Do not move it back inside the workspace.

### Stage-ID state machine (`lib/stage-dedup.js`)

```
shouldNotify(workspaceRoot, sessionId, currentEvent):
  - no sessionId            → notify (can't dedup safely)
  - no entry for session    → create stage 1, notify
  - lastEvent === null      → set lastEvent=current, notify (post-prompt fresh stage)
  - resolved || lastEvent !== current → stageId++, notify
  - else                    → SUPPRESS

advanceOnPrompt(workspaceRoot, sessionId):  # called by hook-user-prompt.js
  stageId++, lastEvent=null, resolved=false

markResolved(workspaceRoot, sessionId):     # called by extension at ack paths
  resolved=true
```

The unit tests in `test/stage-dedup.test.js` are the authoritative spec — if you change the state machine, update the tests and verify they still describe the intended behavior.

### Notification ownership invariant

For every stage, **exactly one** of these fires (never zero, never two):

1. The extension claims (VS Code focused) — in-window toast or sound-only.
2. `hook.js` claims (VS Code unfocused/closed) — OS banner + sound.

The race is resolved by `claimHandled()` in `lib/signals.js` using `fs.writeFileSync(claimPath, ..., {flag: 'wx'})` (POSIX `O_EXCL`). Whoever creates the marker first wins; the loser exits silently.

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

Currently 14 tests across `state-paths` and `stage-dedup`. There is **no UI test harness** for the extension itself — `extension.js` is verified manually via the steps in the relevant plan's "End-to-end manual verification" task. If you add new pure logic, write `node:test` tests for it.

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
- [ ] **`extensionDependencies`** in `package.json` actually resolve in the Marketplace. The current value `["anthropic.claude-code"]` forces the Claude Code VS Code extension to be installed alongside ours. If that ID disappears from the Marketplace, our extension becomes un-installable. **Verify by visiting** `https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code` before each publish. Remove the dependency if uncertain.
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

- **Sessions file is read-modify-write, not atomic.** Two simultaneous hook invocations for the same workspace can clobber each other's writes. In practice the atomic claim marker serializes the meaningful work; a clobber here only loses an `updatedAt` timestamp. If this turns into a real bug, switch to `fs.writeFileSync` with a temp file + `fs.renameSync` (atomic on POSIX/Windows) and a small retry loop.
- **Silent write failures.** `lib/stage-dedup.js#writeSessions` swallows errors. If `~/.claude/focus-state/` becomes unwritable, dedup silently degrades to "always notify". An optional `console.error` to stderr from hook.js (where it lands in Claude's hook log) would surface this. Not critical.
- **No automated UI tests.** `extension.js` is exercised manually. The `vscode-test` harness is heavy and the manual checklist has been good enough so far.
- **Workspace root heuristic.** `hook.js` walks up looking for a `.vscode/` directory. If the user runs Claude from a deeply nested subdirectory of a non-VS-Code repo, they get an isolated state dir per `claude` invocation. Acceptable.
- **`extensionDependencies` is fragile.** See the bonus section at the bottom of this file and the publish checklist.

---

## Where to look when something breaks

| Symptom | First place to check |
|---|---|
| Duplicate banners | `~/.claude/focus-state/<hash>/sessions` — is `resolved` getting set on ack? Read `extension.js` ack paths. Re-check `stage-dedup.js#shouldNotify`. |
| No banners at all | `~/.claude/settings.json` hook entries (`hooks.Stop[*].hooks[*].command` should point at `dist/hook.js`). Then check `hook.js` for early-exits (muted, event disabled, dedup suppressed). |
| Wrong terminal focused | "Claude Notifications" Output channel. Look for `pids=[...]` and `Active terminal after switch`. The PID match logic is in `extension.js#focusMatchingTerminal`. |
| Hook never fires | `~/.claude/settings.json` — was the hook installed? Did the user restart their `claude` session after install? |
| Build error | `node esbuild.js` output. Most often a require pointing at a deleted file — grep the `lib/` tree. |
| Marketplace install error | `extensionDependencies` resolution. See publish checklist. |

---

## Project context (for the agent)

- **User's role:** solo developer; this is a personal/portfolio extension. Not yet published to the VS Code Marketplace at the time of this writing — currently distributed by VSIX install.
- **Quality bar:** ship-quality but not enterprise. The user prefers concise, decisive recommendations to long deliberation. Confirm before destructive ops; otherwise proceed.
- **Testing reality:** primary dev machine is macOS. Windows testing happens later, on a separate machine. Keep platform-specific code in clearly labeled branches.
- **No production users yet** as of v3.2.0 — clean cutovers are preferred over migration shims.

---

## When in doubt

1. Read the relevant plan in `docs/superpowers/plans/`.
2. Run `npm test` after any change to `lib/`.
3. Run `npm run build` after any change to anything bundled.
4. If a change spans more than 3 files or affects the hook/extension contract, propose a plan first.
5. Don't add `node_modules` runtime deps.
6. Don't move state back into `.vscode/`.
7. Don't bypass the `O_EXCL` claim marker — it's the only thing keeping notifications from doubling up under races.
