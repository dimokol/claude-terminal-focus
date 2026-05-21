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
  touch(path.join(home, '.claude-andreas/settings.json'));
  touch(path.join(home, '.claude-dimo/settings.json'));
  const profiles = discoverProfiles(home).sort();
  assert.deepStrictEqual(profiles, [
    path.join(home, '.claude-andreas/settings.json'),
    path.join(home, '.claude-dimo/settings.json'),
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

function buildWrapperSettings({ includeUserPrompt = true } = {}) {
  const entry = (c) => ({ matcher: '', hooks: [{ type: 'command', command: c }] });
  const cmd = `node "${WRAPPER_HOOK}"`;
  const userPromptCmd = `node "${WRAPPER_USER_PROMPT}"`;
  const hooks = {
    Stop: [entry(cmd)],
    Notification: [entry(cmd)],
    PermissionRequest: [entry(cmd)]
  };
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

  const def = results.find(r => r.path.endsWith('/.claude/settings.json'));
  const other = results.find(r => r.path.endsWith('/.claude-other/settings.json'));
  assert.strictEqual(def.status, 'installed');
  // Legacy 3.3 entry → stale-path (still ours, but pointing somewhere else)
  assert.strictEqual(other.status, 'stale-path');
  assert.strictEqual(other.installedPath, LEGACY_3_3);
});

test('checkAllProfiles flags profile missing UserPromptSubmit as partial', () => {
  const home = makeTempHome();
  writeSettings(
    path.join(home, '.claude-andreas/settings.json'),
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
  for (const event of ['Stop', 'Notification', 'PermissionRequest', 'UserPromptSubmit']) {
    assert.strictEqual(
      Array.isArray(settings.hooks[event]) && settings.hooks[event].length,
      1,
      `expected exactly 1 entry for ${event} after 12 installs, got ${settings.hooks[event] && settings.hooks[event].length}`
    );
  }
});

test('installHooks is idempotent on POSIX paths (no duplicate accumulation)', () => {
  const home = makeTempHome();
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const posixWrapper = {
    hookPath:           '/Users/dimo/.claude/claude-notifications/hook.cjs',
    userPromptHookPath: '/Users/dimo/.claude/claude-notifications/hook-user-prompt.cjs'
  };

  for (let i = 0; i < 5; i++) {
    const r = installHooks(posixWrapper, { settingsPath });
    assert.strictEqual(r.success, true);
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['Stop', 'Notification', 'PermissionRequest', 'UserPromptSubmit']) {
    assert.strictEqual(settings.hooks[event].length, 1);
  }
});
