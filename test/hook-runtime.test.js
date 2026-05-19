const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  installHookRuntime,
  uninstallHookRuntime,
  getRuntimeDir,
  getWrapperHookPath,
  getWrapperUserPromptPath,
  getStateFilePath,
  WRAPPER_VERSION
} = require('../lib/hook-runtime');

function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-runtime-'));
}

function mkTempExtension() {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-ext-'));
  fs.mkdirSync(path.join(ext, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'dist/hook.js'), '// real hook bundle');
  fs.writeFileSync(path.join(ext, 'dist/hook-user-prompt.js'), '// real user-prompt hook bundle');
  fs.writeFileSync(path.join(ext, 'dist/hook-wrapper.cjs'), '// the wrapper source\nmodule.exports = {};');
  return ext;
}

test('getRuntimeDir returns ~/.claude/claude-notifications', () => {
  const home = '/tmp/h';
  assert.equal(getRuntimeDir(home), path.join('/tmp/h', '.claude', 'claude-notifications'));
});

test('installHookRuntime writes two wrappers (identical source) + state.json', () => {
  const home = mkTempHome();
  const ext = mkTempExtension();

  const result = installHookRuntime(ext, { extensionVersion: '3.5.0', home });
  assert.equal(result.ok, true);
  assert.equal(result.wrapperDir, getRuntimeDir(home));

  // Both wrapper files exist and contain identical contents.
  const hookSrc = fs.readFileSync(getWrapperHookPath(home), 'utf8');
  const upSrc = fs.readFileSync(getWrapperUserPromptPath(home), 'utf8');
  assert.equal(hookSrc, upSrc);
  assert.match(hookSrc, /the wrapper source/);

  // State.json points at the extension's real hook bundles.
  const state = JSON.parse(fs.readFileSync(getStateFilePath(home), 'utf8'));
  assert.equal(state.wrapperVersion, WRAPPER_VERSION);
  assert.equal(state.extensionHookPath, path.join(ext, 'dist/hook.js'));
  assert.equal(state.extensionUserPromptHookPath, path.join(ext, 'dist/hook-user-prompt.js'));
  assert.equal(state.extensionVersion, '3.5.0');
  assert.ok(typeof state.installedAt === 'number' && state.installedAt > 0);
});

test('installHookRuntime is idempotent — second call overwrites state', () => {
  const home = mkTempHome();
  const ext1 = mkTempExtension();
  const ext2 = mkTempExtension();

  installHookRuntime(ext1, { extensionVersion: '3.5.0', home });
  const state1 = JSON.parse(fs.readFileSync(getStateFilePath(home), 'utf8'));

  // Second install (e.g. extension upgraded to 3.5.1 in a new path) overwrites.
  installHookRuntime(ext2, { extensionVersion: '3.5.1', home });
  const state2 = JSON.parse(fs.readFileSync(getStateFilePath(home), 'utf8'));

  assert.notEqual(state2.extensionHookPath, state1.extensionHookPath);
  assert.equal(state2.extensionVersion, '3.5.1');
});

test('installHookRuntime returns ok:false when bundled wrapper is missing', () => {
  const home = mkTempHome();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-ext-bad-'));
  // No dist/hook-wrapper.cjs

  const result = installHookRuntime(ext, { home });
  assert.equal(result.ok, false);
  assert.match(result.error, /read bundled wrapper/);
});

test('uninstallHookRuntime removes the directory', () => {
  const home = mkTempHome();
  const ext = mkTempExtension();
  installHookRuntime(ext, { home });
  assert.equal(fs.existsSync(getRuntimeDir(home)), true);

  const result = uninstallHookRuntime({ home });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(getRuntimeDir(home)), false);
});

test('uninstallHookRuntime is idempotent — no-op when dir absent', () => {
  const home = mkTempHome();
  const result = uninstallHookRuntime({ home });
  assert.equal(result.ok, true);
});
