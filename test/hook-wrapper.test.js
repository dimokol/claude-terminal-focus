const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  discoverProfiles,
  stripFromSettings,
  selfDestruct,
  pathExistsSync,
  compareVersions,
  findNewestExtensionHook,
  SELF_IDENTIFIERS
} = require('../bin/hook-wrapper.cjs');

function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-wrapper-'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const ENTRY = (cmd) => ({ matcher: '', hooks: [{ type: 'command', command: cmd }] });
const WRAPPER_HOOK_CMD = 'node "/home/u/.claude/claude-notifications/hook.cjs"';
const WRAPPER_UP_CMD = 'node "/home/u/.claude/claude-notifications/hook-user-prompt.cjs"';
const LEGACY_CMD = 'node "/home/u/.vscode/extensions/dimokol.claude-notifications-3.4.0/dist/hook.js"';
const FOREIGN_CMD = 'python3 /opt/some/other-hook.py';

test('SELF_IDENTIFIERS includes both wrapper paths AND legacy extension dir', () => {
  assert.ok(SELF_IDENTIFIERS.some(s => s.includes('hook.cjs')));
  assert.ok(SELF_IDENTIFIERS.includes('dimokol.claude-notifications'));
});

test('discoverProfiles finds .claude and .claude-* with settings.json, skips backups', () => {
  const home = mkTempHome();
  writeJson(path.join(home, '.claude/settings.json'), {});
  writeJson(path.join(home, '.claude-acct-a/settings.json'), {});
  writeJson(path.join(home, '.claude-backup-2024/settings.json'), {});
  fs.mkdirSync(path.join(home, '.claude-no-settings'), { recursive: true });

  const profiles = discoverProfiles(home).sort();
  assert.deepEqual(profiles, [
    path.join(home, '.claude-acct-a/settings.json'),
    path.join(home, '.claude/settings.json')
  ].sort());
});

test('stripFromSettings removes only matching entries; preserves other hooks + non-hook keys', () => {
  const home = mkTempHome();
  const sp = path.join(home, '.claude/settings.json');
  writeJson(sp, {
    permissions: { allow: ['Bash(*)'] },
    model: 'opus',
    hooks: {
      Stop: [ENTRY(WRAPPER_HOOK_CMD), ENTRY(FOREIGN_CMD)],
      PreToolUse: [ENTRY(FOREIGN_CMD)]
    }
  });

  const changed = stripFromSettings(sp, SELF_IDENTIFIERS);
  assert.equal(changed, true);

  const result = readJson(sp);
  assert.equal(result.permissions.allow[0], 'Bash(*)');
  assert.equal(result.model, 'opus');
  assert.deepEqual(result.hooks.Stop, [ENTRY(FOREIGN_CMD)]);
  assert.deepEqual(result.hooks.PreToolUse, [ENTRY(FOREIGN_CMD)]);
});

test('stripFromSettings drops empty event arrays and drops hooks key when fully empty', () => {
  const home = mkTempHome();
  const sp = path.join(home, '.claude/settings.json');
  writeJson(sp, {
    model: 'opus',
    hooks: {
      Stop: [ENTRY(WRAPPER_HOOK_CMD)],
      UserPromptSubmit: [ENTRY(WRAPPER_UP_CMD)]
    }
  });
  stripFromSettings(sp, SELF_IDENTIFIERS);
  const result = readJson(sp);
  assert.equal(result.hooks, undefined);
  assert.equal(result.model, 'opus');
});

test('stripFromSettings also removes legacy direct-to-extension entries', () => {
  const home = mkTempHome();
  const sp = path.join(home, '.claude/settings.json');
  writeJson(sp, {
    hooks: { Stop: [ENTRY(LEGACY_CMD), ENTRY(FOREIGN_CMD)] }
  });
  stripFromSettings(sp, SELF_IDENTIFIERS);
  const result = readJson(sp);
  assert.deepEqual(result.hooks.Stop, [ENTRY(FOREIGN_CMD)]);
});

test('stripFromSettings returns false on settings.json without hooks (no-op)', () => {
  const home = mkTempHome();
  const sp = path.join(home, '.claude/settings.json');
  writeJson(sp, { model: 'opus' });
  const changed = stripFromSettings(sp, SELF_IDENTIFIERS);
  assert.equal(changed, false);
});

test('stripFromSettings tolerates malformed JSON without throwing', () => {
  const home = mkTempHome();
  const sp = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, '{invalid json');
  const changed = stripFromSettings(sp, SELF_IDENTIFIERS);
  assert.equal(changed, false);
});

test('selfDestruct cleans every profile + focus-state + wrapper dir', () => {
  const home = mkTempHome();
  const wrapperDir = path.join(home, '.claude/claude-notifications');
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, 'hook.cjs'), 'placeholder');
  fs.writeFileSync(path.join(wrapperDir, 'state.json'), '{}');

  // Two profiles, each with our hooks plus a foreign hook.
  writeJson(path.join(home, '.claude/settings.json'), {
    permissions: { allow: ['Bash(*)'] },
    hooks: {
      Stop: [ENTRY(WRAPPER_HOOK_CMD), ENTRY(FOREIGN_CMD)],
      UserPromptSubmit: [ENTRY(WRAPPER_UP_CMD)]
    }
  });
  writeJson(path.join(home, '.claude-acct-a/settings.json'), {
    hooks: {
      Stop: [ENTRY(LEGACY_CMD)]
    }
  });

  fs.mkdirSync(path.join(home, '.claude/focus-state/abc123'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/focus-state/abc123/signal'), '{}');

  selfDestruct({ home, wrapperDir });

  // Default profile: foreign hook preserved, ours gone, permissions kept.
  const def = readJson(path.join(home, '.claude/settings.json'));
  assert.deepEqual(def.permissions.allow, ['Bash(*)']);
  assert.deepEqual(def.hooks.Stop, [ENTRY(FOREIGN_CMD)]);
  assert.equal(def.hooks.UserPromptSubmit, undefined);

  // Second profile: legacy entry gone, hooks key dropped (was only ours).
  const acctA = readJson(path.join(home, '.claude-acct-a/settings.json'));
  assert.equal(acctA.hooks, undefined);

  // Focus-state gone.
  assert.equal(pathExistsSync(path.join(home, '.claude/focus-state')), false);

  // On POSIX wrapperDir is removed inline; on Windows we'd schedule
  // detached cleanup so it might still exist at this point.
  if (process.platform !== 'win32') {
    assert.equal(pathExistsSync(wrapperDir), false);
  }
});

test('selfDestruct is idempotent — second call on already-clean state does not throw', () => {
  const home = mkTempHome();
  const wrapperDir = path.join(home, '.claude/claude-notifications');
  selfDestruct({ home, wrapperDir });
  selfDestruct({ home, wrapperDir });
  // No throw is the assertion.
  assert.ok(true);
});

// --- update-window re-point (v3.6.0) ---
//
// When VS Code replaces the extension's version dir during an update, the
// wrapper's recorded hook path goes missing BEFORE the new extension
// activates and rewrites state.json. A Claude hook firing in that window
// used to trigger a FULL self-destruct — hooks stripped from every profile
// mid-session. The wrapper must instead re-point at the newest installed
// version and only self-destruct when NO version remains (true uninstall).

function mkExtRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-extroot-'));
}

function mkExtVersion(extRoot, version, { withHook = true, withUserPrompt = true } = {}) {
  const dist = path.join(extRoot, `dimokol.claude-notifications-${version}`, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  if (withHook) fs.writeFileSync(path.join(dist, 'hook.js'), '// hook');
  if (withUserPrompt) fs.writeFileSync(path.join(dist, 'hook-user-prompt.js'), '// up');
  return path.join(dist, 'hook.js');
}

test('compareVersions orders dotted versions numerically', () => {
  assert.ok(compareVersions('3.10.0', '3.9.9') > 0, '3.10.0 > 3.9.9');
  assert.ok(compareVersions('3.5.5', '3.6.0') < 0);
  assert.equal(compareVersions('3.6.0', '3.6.0'), 0);
  assert.ok(compareVersions('3.6', '3.6.0') === 0, 'missing segment = 0');
});

test('findNewestExtensionHook picks the highest installed version', () => {
  const extRoot = mkExtRoot();
  mkExtVersion(extRoot, '3.5.5');
  const newestHook = mkExtVersion(extRoot, '3.6.0');
  mkExtVersion(extRoot, '3.5.4');
  // Recorded path points at a REMOVED version dir.
  const recorded = path.join(extRoot, 'dimokol.claude-notifications-3.5.3', 'dist', 'hook.js');

  const found = findNewestExtensionHook(recorded, false);
  assert.ok(found, 'must find an installed version');
  assert.equal(found.hookPath, newestHook);
  assert.equal(found.version, '3.6.0');
});

test('findNewestExtensionHook resolves the user-prompt bundle when asked', () => {
  const extRoot = mkExtRoot();
  mkExtVersion(extRoot, '3.6.0');
  const recorded = path.join(extRoot, 'dimokol.claude-notifications-3.5.5', 'dist', 'hook.js');
  const found = findNewestExtensionHook(recorded, true);
  assert.ok(found.hookPath.endsWith(path.join('dist', 'hook-user-prompt.js')));
});

test('findNewestExtensionHook skips version dirs whose dist bundle is missing', () => {
  const extRoot = mkExtRoot();
  mkExtVersion(extRoot, '3.7.0', { withHook: false, withUserPrompt: false }); // broken/partial install
  const goodHook = mkExtVersion(extRoot, '3.6.0');
  const recorded = path.join(extRoot, 'dimokol.claude-notifications-3.5.5', 'dist', 'hook.js');
  const found = findNewestExtensionHook(recorded, false);
  assert.equal(found.hookPath, goodHook, 'must fall back to the newest COMPLETE install');
});

test('findNewestExtensionHook returns null when no version is installed (true uninstall)', () => {
  const extRoot = mkExtRoot();
  const recorded = path.join(extRoot, 'dimokol.claude-notifications-3.5.5', 'dist', 'hook.js');
  assert.equal(findNewestExtensionHook(recorded, false), null);
});

test('findNewestExtensionHook tolerates bogus recorded paths', () => {
  assert.equal(findNewestExtensionHook('', false), null);
  assert.equal(findNewestExtensionHook(null, false), null);
  assert.equal(findNewestExtensionHook('/nonexistent/x/y/z/hook.js', false), null);
});
