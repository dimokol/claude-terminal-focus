const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverProfiles, checkAllProfiles, installHooks, checkHookStatus } = require('../lib/hooks-installer');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-'));
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}');
}

test('discoverProfiles finds default ~/.claude/settings.json', () => {
  const home = makeTempHome();
  touch(path.join(home, '.claude/settings.json'));
  const profiles = discoverProfiles(home);
  assert.deepStrictEqual(profiles, [path.join(home, '.claude/settings.json')]);
});

test('discoverProfiles finds ~/.claude-<name>/settings.json profiles', () => {
  const home = makeTempHome();
  touch(path.join(home, '.claude/settings.json'));
  touch(path.join(home, '.claude-acct-b/settings.json'));
  touch(path.join(home, '.claude-acct-a/settings.json'));
  const profiles = discoverProfiles(home).sort();
  assert.deepStrictEqual(profiles, [
    path.join(home, '.claude-acct-a/settings.json'),
    path.join(home, '.claude-acct-b/settings.json'),
    path.join(home, '.claude/settings.json')
  ]);
});

test('discoverProfiles skips .claude-backup-* directories', () => {
  const home = makeTempHome();
  touch(path.join(home, '.claude/settings.json'));
  touch(path.join(home, '.claude-backup-20260428-123811/settings.json'));
  touch(path.join(home, '.claude-Backup-other/settings.json'));
  const profiles = discoverProfiles(home);
  assert.deepStrictEqual(profiles, [path.join(home, '.claude/settings.json')]);
});

test('discoverProfiles skips dirs without settings.json', () => {
  const home = makeTempHome();
  fs.mkdirSync(path.join(home, '.claude-empty'), { recursive: true });
  touch(path.join(home, '.claude/settings.json'));
  const profiles = discoverProfiles(home);
  assert.deepStrictEqual(profiles, [path.join(home, '.claude/settings.json')]);
});

test('discoverProfiles returns empty array when no profiles exist', () => {
  const home = makeTempHome();
  assert.deepStrictEqual(discoverProfiles(home), []);
});

function writeSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

function buildSettings({ hookPath, includeUserPrompt = true }) {
  const userPromptCmd = `node "${hookPath.replace('hook.js', 'hook-user-prompt.js')}"`;
  const cmd = `node "${hookPath}"`;
  const entry = (c) => ({ matcher: '', hooks: [{ type: 'command', command: c }] });
  const hooks = {
    Stop: [entry(cmd)],
    Notification: [entry(cmd)],
    PermissionRequest: [entry(cmd)]
  };
  if (includeUserPrompt) hooks.UserPromptSubmit = [entry(userPromptCmd)];
  return { hooks };
}

// Realistic paths: as of 3.5.0 hook entries point at the wrapper, not
// the extension dir. Pre-3.5.0 entries (legacy direct-to-extension) live
// inside an extension dir named like `dimokol.claude-notifications-3.4.0`
// and are detected via that substring so they get auto-migrated.
const WRAPPER_HOOK = '/home/u/.claude/claude-notifications/hook.cjs';
const WRAPPER_USER_PROMPT = '/home/u/.claude/claude-notifications/hook-user-prompt.cjs';
const LEGACY_3_4 = '/home/u/.vscode/extensions/dimokol.claude-notifications-3.4.0/dist/hook.js';
const LEGACY_3_3 = '/home/u/.vscode/extensions/dimokol.claude-notifications-3.3.2/dist/hook.js';

function buildWrapperSettings({ includeUserPrompt = true, includeQuestionHook = true } = {}) {
  // Notification hooks carry async:true; PreToolUse question hook present
  // (current valid install shape as of 3.6.0).
  const entry = (c, extra = {}) => ({ matcher: '', hooks: [{ type: 'command', command: c, ...extra }] });
  const cmd = `node "${WRAPPER_HOOK}"`;
  const userPromptCmd = `node "${WRAPPER_USER_PROMPT}"`;
  const hooks = {
    Stop: [entry(cmd, { async: true })],
    Notification: [entry(cmd, { async: true })],
    PermissionRequest: [entry(cmd, { async: true })]
  };
  if (includeQuestionHook) {
    hooks.PreToolUse = [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: cmd, async: true }] }];
  }
  if (includeUserPrompt) hooks.UserPromptSubmit = [entry(userPromptCmd)];
  return { hooks };
}

function buildLegacySettings(legacyExtHookPath, { includeUserPrompt = true } = {}) {
  const upPath = legacyExtHookPath.replace('hook.js', 'hook-user-prompt.js');
  const entry = (c) => ({ matcher: '', hooks: [{ type: 'command', command: c }] });
  const hooks = {
    Stop: [entry(`node "${legacyExtHookPath}"`)],
    Notification: [entry(`node "${legacyExtHookPath}"`)],
    PermissionRequest: [entry(`node "${legacyExtHookPath}"`)]
  };
  if (includeUserPrompt) hooks.UserPromptSubmit = [entry(`node "${upPath}"`)];
  return { hooks };
}

test('checkAllProfiles returns one entry per discovered profile', () => {
  const home = makeTempHome();
  writeSettings(path.join(home, '.claude/settings.json'), buildWrapperSettings());
  writeSettings(path.join(home, '.claude-other/settings.json'), buildLegacySettings(LEGACY_3_3));

  const results = checkAllProfiles(WRAPPER_HOOK, home);
  assert.strictEqual(results.length, 2);

  const normalize = p => p.replace(/\\/g, '/');
  const def = results.find(r => normalize(r.path).endsWith('/.claude/settings.json'));
  const other = results.find(r => normalize(r.path).endsWith('/.claude-other/settings.json'));
  assert.strictEqual(def.status, 'installed');
  // Legacy 3.3 entry → stale-path (still ours, but pointing somewhere else)
  assert.strictEqual(other.status, 'stale-path');
  assert.strictEqual(other.installedPath, LEGACY_3_3);
});

test('checkAllProfiles flags profile missing UserPromptSubmit as partial', () => {
  const home = makeTempHome();
  writeSettings(
    path.join(home, '.claude-acct-b/settings.json'),
    buildLegacySettings(LEGACY_3_4, { includeUserPrompt: false })
  );

  const results = checkAllProfiles(WRAPPER_HOOK, home);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].status, 'partial');
  assert.strictEqual(results[0].installedPath, LEGACY_3_4);
});

test('checkAllProfiles ignores profiles without our hooks', () => {
  const home = makeTempHome();
  writeSettings(path.join(home, '.claude/settings.json'), {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo unrelated' }] }] }
  });
  const results = checkAllProfiles(WRAPPER_HOOK, home);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].status, 'not-installed');
});

// Regression: install → checkHookStatus round-trip on a Windows-style path.
//
// Pre-fix, getHookCommand used JSON.stringify(path) which double-escaped
// backslashes in the in-memory command string. The stored command ended up
// containing "claude-notifications\\hook.cjs" (literal `\\` sequence), while
// OUR_HOOK_IDENTIFIERS uses "claude-notifications\hook.cjs" (single `\`).
// commandReferencesAnyOf never matched → checkHookStatus permanently returned
// 'not-installed' on Windows even after a successful install → every
// activation re-ran installHooks → strip filter found nothing to remove →
// one extra hook entry per VS Code start accumulated indefinitely. A user
// with 12 VS Code restarts ended up with 12 duplicate hook entries per event.
//
// These tests would have caught it: installHooks then checkHookStatus must
// report 'installed', and a second installHooks call must not duplicate.
test('installHooks + checkHookStatus round-trip works on Windows-style paths (backslashes)', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const winWrapper = {
    hookPath:           'C:\\Users\\Ada\\.claude\\claude-notifications\\hook.cjs',
    userPromptHookPath: 'C:\\Users\\Ada\\.claude\\claude-notifications\\hook-user-prompt.cjs'
  };

  const installResult = installHooks(winWrapper, { settingsPath });
  assert.strictEqual(installResult.success, true, installResult.message);

  // The key invariant: after a successful install, the same paths must
  // round-trip back through checkHookStatus as 'installed'.
  const status = checkHookStatus(winWrapper.hookPath, settingsPath);
  assert.strictEqual(status.status, 'installed',
    `expected 'installed' after fresh install on Windows path, got '${status.status}' (installedPath=${status.installedPath})`);
});

test('installHooks is idempotent on Windows-style paths (no duplicate accumulation)', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const winWrapper = {
    hookPath:           'C:\\Users\\Ada\\.claude\\claude-notifications\\hook.cjs',
    userPromptHookPath: 'C:\\Users\\Ada\\.claude\\claude-notifications\\hook-user-prompt.cjs'
  };

  // Simulate 12 VS Code restarts hitting the install path.
  for (let i = 0; i < 12; i++) {
    const r = installHooks(winWrapper, { settingsPath });
    assert.strictEqual(r.success, true, `install #${i + 1} failed: ${r.message}`);
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'UserPromptSubmit']) {
    assert.strictEqual(
      Array.isArray(settings.hooks[event]) && settings.hooks[event].length,
      1,
      `expected exactly 1 entry for ${event} after 12 installs, got ${settings.hooks[event] && settings.hooks[event].length}`
    );
  }
});

test('installHooks migrates pre-3.5.4 entries with double-escaped backslashes (Ada\'s 13-entry case)', () => {
  // Real-world repro from Ada's Windows live-test 2026-05-21: 12 pre-existing
  // hook entries from 3.5.0–3.5.3 had command strings in memory like
  //   `node "C:\\Users\\Ada\\.claude\\claude-notifications\\hook.cjs"`
  // (literal `\\` two-char sequences from the old JSON.stringify(path) bug).
  // The 3.5.4 OUR_HOOK_IDENTIFIERS only looked for `\hook.cjs` (single
  // backslash) → didn't match → strip filter skipped → 13th entry got
  // appended on next activation. Fix: identifiers now include both the
  // `\hook.cjs` and `\\hook.cjs` substring variants.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  // Pre-existing 12 entries with the legacy double-backslash command form.
  // The literal `\\` in the command string is what JSON.parse returns after
  // reading the old settings.json that JSON.stringify(path) double-escaped.
  const legacyCmd = 'node "C:\\\\Users\\\\Ada\\\\.claude\\\\claude-notifications\\\\hook.cjs"';
  const legacyUpCmd = 'node "C:\\\\Users\\\\Ada\\\\.claude\\\\claude-notifications\\\\hook-user-prompt.cjs"';
  const entry = c => ({ matcher: '', hooks: [{ type: 'command', command: c }] });
  const hooks = {
    Stop: Array(12).fill(0).map(() => entry(legacyCmd)),
    Notification: Array(12).fill(0).map(() => entry(legacyCmd)),
    PermissionRequest: Array(12).fill(0).map(() => entry(legacyCmd)),
    UserPromptSubmit: Array(12).fill(0).map(() => entry(legacyUpCmd))
  };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

  // Run installHooks (simulating the auto-migration on first 3.5.4
  // activation). The strip filter MUST now recognize all 12 legacy
  // entries and collapse to 1.
  const winWrapper = {
    hookPath:           'C:\\Users\\Ada\\.claude\\claude-notifications\\hook.cjs',
    userPromptHookPath: 'C:\\Users\\Ada\\.claude\\claude-notifications\\hook-user-prompt.cjs'
  };
  const result = installHooks(winWrapper, { settingsPath });
  assert.strictEqual(result.success, true, result.message);

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['Stop', 'Notification', 'PermissionRequest', 'UserPromptSubmit']) {
    assert.strictEqual(after.hooks[event].length, 1,
      `${event}: expected exactly 1 entry after migration, got ${after.hooks[event].length}`);
  }

  // checkHookStatus must report 'installed' on the migrated config.
  const status = checkHookStatus(winWrapper.hookPath, settingsPath);
  assert.strictEqual(status.status, 'installed',
    `expected 'installed' post-migration, got '${status.status}'`);
});

test('checkHookStatus detects legacy double-backslash entries as ours (not "not-installed")', () => {
  // The OTHER half of Ada's bug: even WITHOUT calling installHooks, just
  // checkHookStatus on a settings.json full of legacy entries must report
  // a known status (installed or stale-path), NOT 'not-installed' — which
  // would trigger the first-run install path to APPEND another entry.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const legacyCmd = 'node "C:\\\\Users\\\\Ada\\\\.claude\\\\claude-notifications\\\\hook.cjs"';
  const legacyUpCmd = 'node "C:\\\\Users\\\\Ada\\\\.claude\\\\claude-notifications\\\\hook-user-prompt.cjs"';
  const entry = c => ({ matcher: '', hooks: [{ type: 'command', command: c }] });
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [entry(legacyCmd)],
      Notification: [entry(legacyCmd)],
      PermissionRequest: [entry(legacyCmd)],
      UserPromptSubmit: [entry(legacyUpCmd)]
    }
  }, null, 2));

  const expectedHookPath = 'C:\\Users\\Ada\\.claude\\claude-notifications\\hook.cjs';
  const status = checkHookStatus(expectedHookPath, settingsPath);

  // The legacy command extracted from the regex match will contain the
  // double-backslash path. After path.resolve normalization, it may or may
  // not equal the expected single-backslash path. Either way, the status
  // must NOT be 'not-installed' — that's the bug we're guarding against.
  assert.notStrictEqual(status.status, 'not-installed',
    `pre-fix this returned 'not-installed', causing duplicate-entry append. Got '${status.status}'.`);
});

test('checkHookStatus reports stale-config when our hooks are at the correct path but lack async', () => {
  // The state of every 3.5.x install made BEFORE the async change: hooks
  // point at the correct wrapper path (so it's not stale-path), all events
  // present (so it's not partial), but the notification entries have no
  // async flag. checkHookStatus must flag this so activation rewrites them —
  // otherwise the async feature never reaches already-installed users.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  const entry = (c) => ({ matcher: '', hooks: [{ type: 'command', command: c }] });
  const cmd = `node "${WRAPPER_HOOK}"`;
  const upCmd = `node "${WRAPPER_USER_PROMPT}"`;
  writeSettings(settingsPath, { hooks: {
    Stop: [entry(cmd)],
    Notification: [entry(cmd)],
    PermissionRequest: [entry(cmd)],
    UserPromptSubmit: [entry(upCmd)]
  }});

  const status = checkHookStatus(WRAPPER_HOOK, settingsPath);
  assert.strictEqual(status.status, 'stale-config',
    `expected 'stale-config' for a correct-path install missing async, got '${status.status}'`);
});

test('checkHookStatus reports installed when our hooks have async at the correct path', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  writeSettings(settingsPath, buildWrapperSettings());

  const status = checkHookStatus(WRAPPER_HOOK, settingsPath);
  assert.strictEqual(status.status, 'installed',
    `expected 'installed' for a correct-path async install, got '${status.status}'`);
});

test('installHooks output round-trips to installed (async-aware checkHookStatus)', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const wrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };
  installHooks(wrapper, { settingsPath });
  const status = checkHookStatus(wrapper.hookPath, settingsPath);
  assert.strictEqual(status.status, 'installed',
    `installHooks should produce an async config that checkHookStatus accepts as installed, got '${status.status}'`);
});

test('installHooks marks the notification hooks async (fire-and-forget)', () => {
  // async:true tells Claude Code to fire the hook and not wait for it to
  // exit, so the turn completes without the ~1.2s handshake block (issue #2).
  // The hook still runs its full handshake/claim/notify in the background.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const wrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };
  const r = installHooks(wrapper, { settingsPath });
  assert.strictEqual(r.success, true, r.message);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['Stop', 'Notification', 'PermissionRequest']) {
    const hook = settings.hooks[event][0].hooks[0];
    assert.strictEqual(hook.async, true, `${event} hook should be async`);
  }
});

test('installHooks does NOT mark UserPromptSubmit async', () => {
  // UserPromptSubmit only advances the stageId synchronously (no handshake
  // sleep), so async buys nothing and synchronous ordering keeps the
  // stage-advance happens-before relative to the next Stop clean.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const wrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };
  installHooks(wrapper, { settingsPath });

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
  assert.notStrictEqual(hook.async, true, 'UserPromptSubmit hook should not be async');
});

test('installHooks is idempotent on POSIX paths (no duplicate accumulation)', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const posixWrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };

  for (let i = 0; i < 5; i++) {
    const r = installHooks(posixWrapper, { settingsPath });
    assert.strictEqual(r.success, true);
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'UserPromptSubmit']) {
    assert.strictEqual(settings.hooks[event].length, 1);
  }
});

// --- 3.6.0 question hook (PreToolUse / AskUserQuestion) ---

test('installHooks writes a PreToolUse entry scoped to AskUserQuestion only', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const wrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };
  const r = installHooks(wrapper, { settingsPath });
  assert.strictEqual(r.success, true, r.message);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const preToolUse = settings.hooks.PreToolUse;
  assert.strictEqual(preToolUse.length, 1);
  assert.strictEqual(preToolUse[0].matcher, 'AskUserQuestion',
    'question hook must be scoped to AskUserQuestion — a bare matcher would fire for every tool call');
  assert.strictEqual(preToolUse[0].hooks[0].async, true, 'question hook should be async');
  assert.ok(preToolUse[0].hooks[0].command.includes('hook.cjs'));
});

test('installHooks preserves foreign PreToolUse entries (user\'s own hooks)', () => {
  // Users commonly have their own PreToolUse hooks (guards, linters). The
  // strip-before-push filter must only remove OUR entries from that array.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh "/Users/acctA/.claude-shared/hooks/no-auto-merge.sh"' }] };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [foreign] } }, null, 2));

  const wrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };
  installHooks(wrapper, { settingsPath });
  installHooks(wrapper, { settingsPath }); // idempotency with a foreign entry present

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(settings.hooks.PreToolUse.length, 2, 'foreign + ours');
  assert.deepStrictEqual(settings.hooks.PreToolUse[0], foreign, 'foreign entry must survive untouched');
  assert.strictEqual(settings.hooks.PreToolUse[1].matcher, 'AskUserQuestion');
});

test('checkHookStatus reports stale-config for a 3.5.x install missing the question hook', () => {
  // Auto-migration driver: a correct-path async install WITHOUT the
  // PreToolUse question hook (i.e. any 3.5.x install) must be flagged so
  // activation rewrites it — otherwise existing users never gain the
  // redundant question announcement channel.
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  writeSettings(settingsPath, buildWrapperSettings({ includeQuestionHook: false }));

  const status = checkHookStatus(WRAPPER_HOOK, settingsPath);
  assert.strictEqual(status.status, 'stale-config',
    `expected 'stale-config' for a pre-3.6.0 install without the question hook, got '${status.status}'`);
});

test('uninstallHooks removes our PreToolUse entry but keeps foreign ones', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh "/Users/acctA/hooks/guard.sh"' }] };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [foreign] } }, null, 2));

  const wrapper = {
    hookPath:           '/Users/acctA/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/acctA/.claude/claude-notifications/hook-user-prompt.cjs'
  };
  installHooks(wrapper, { settingsPath });

  const { uninstallHooks } = require('../lib/hooks-installer');
  const r = uninstallHooks(settingsPath);
  assert.strictEqual(r.success, true);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepStrictEqual(settings.hooks.PreToolUse, [foreign],
    'only the foreign PreToolUse entry should remain after uninstall');
  assert.strictEqual(settings.hooks.Stop, undefined, 'our Stop entry should be gone');
});
