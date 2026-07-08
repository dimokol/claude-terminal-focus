const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Sandboxes HOME — the cache lives under the state dir.
require('./helpers');
const {
  isCustomTerminalName,
  getTerminalNamesPath,
  writeTerminalNamesCache,
  readTerminalNamesCache,
  lookupCustomName,
  NAME_CACHE_STALE_MS,
  MAX_CUSTOM_NAME_LEN
} = require('../lib/terminal-names');

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tn-'));
}

// --- isCustomTerminalName ---

test('stock shell names are not custom (incl. " (n)" duplicates)', () => {
  for (const name of ['zsh', 'bash', 'powershell', 'pwsh', 'cmd', 'fish', 'Git Bash', 'zsh (2)', '  bash  ']) {
    assert.equal(isCustomTerminalName(name), false, name);
  }
});

test('Claude-written titles are not custom (glyphs, claude substring, aiTitle, project idle title)', () => {
  const ctx = { aiTitle: 'Refactor the auth middleware', project: 'api-server' };
  assert.equal(isCustomTerminalName('✳ Refactor the auth middleware', ctx), false, 'busy glyph');
  assert.equal(isCustomTerminalName('⚒ Running tests', ctx), false, 'tool glyph');
  assert.equal(isCustomTerminalName('claude', ctx), false);
  assert.equal(isCustomTerminalName('Claude Code', ctx), false);
  assert.equal(isCustomTerminalName('Refactor the auth middleware', ctx), false, 'bare aiTitle');
  assert.equal(isCustomTerminalName('api-server', ctx), false, 'idle title == project');
  assert.equal(isCustomTerminalName('api-server (2)', ctx), false, 'idle title with dup suffix');
});

test('user-typed names are custom', () => {
  const ctx = { aiTitle: 'Refactor the auth middleware', project: 'api-server' };
  assert.equal(isCustomTerminalName('deploy-bot', ctx), true);
  assert.equal(isCustomTerminalName('API server work', ctx), true);
  assert.equal(isCustomTerminalName('Ada: windows tests', ctx), true);
});

test('empty/garbage names are not custom', () => {
  assert.equal(isCustomTerminalName(''), false);
  assert.equal(isCustomTerminalName('   '), false);
  assert.equal(isCustomTerminalName(null), false);
  assert.equal(isCustomTerminalName(42), false);
});

// --- cache round-trip ---

test('write + read round-trips the pid→name map', () => {
  const root = tmpWorkspace();
  assert.equal(writeTerminalNamesCache(root, { 123: 'deploy-bot', 456: 'zsh' }), true);
  const cache = readTerminalNamesCache(root);
  assert.ok(cache);
  assert.equal(cache.names['123'], 'deploy-bot');
  assert.equal(cache.names['456'], 'zsh');
  assert.ok(fs.existsSync(getTerminalNamesPath(root)));
});

test('read returns null for missing, malformed, or stale caches', () => {
  const root = tmpWorkspace();
  assert.equal(readTerminalNamesCache(root), null, 'missing');

  writeTerminalNamesCache(root, { 1: 'x' });
  fs.writeFileSync(getTerminalNamesPath(root), '{torn');
  assert.equal(readTerminalNamesCache(root), null, 'malformed');

  writeTerminalNamesCache(root, { 1: 'x' });
  const p = getTerminalNamesPath(root);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.updatedAt = Date.now() - (NAME_CACHE_STALE_MS + 1000);
  fs.writeFileSync(p, JSON.stringify(data));
  assert.equal(readTerminalNamesCache(root), null, 'stale (VS Code likely gone)');
});

// --- lookupCustomName ---

test('lookup prefers shellPid, falls back to chain pids, skips non-custom names', () => {
  const cache = { names: { '10': 'zsh', '20': 'deploy-bot', '30': 'release captain' } };
  const ctx = { aiTitle: 'Fix bug', project: 'proj' };
  assert.equal(lookupCustomName(cache, { shellPid: 20, pids: [30] }, ctx), 'deploy-bot', 'shellPid wins');
  assert.equal(lookupCustomName(cache, { shellPid: 10, pids: [30] }, ctx), 'release captain',
    'shellPid name is a stock shell → fall through to chain pids');
  assert.equal(lookupCustomName(cache, { shellPid: 10, pids: [10] }, ctx), '', 'nothing custom');
  assert.equal(lookupCustomName(cache, { shellPid: 99, pids: [] }, ctx), '', 'unknown pid');
  assert.equal(lookupCustomName(null, { shellPid: 20 }, ctx), '', 'no cache');
});

test('lookup truncates very long custom names for banner width', () => {
  const long = 'my extremely descriptive terminal name that goes on and on and on forever';
  const cache = { names: { '5': long } };
  const hit = lookupCustomName(cache, { shellPid: 5 }, {});
  assert.ok(hit.length <= MAX_CUSTOM_NAME_LEN);
  assert.ok(hit.endsWith('…'));
});

test('lookup respects the per-signal context (aiTitle can disqualify a name)', () => {
  const cache = { names: { '7': 'Refactor the auth middleware' } };
  assert.equal(lookupCustomName(cache, { shellPid: 7 }, { aiTitle: 'Refactor the auth middleware' }), '',
    'name matching the aiTitle is Claude-written, not custom');
  assert.equal(lookupCustomName(cache, { shellPid: 7 }, { aiTitle: 'Something else' }),
    'Refactor the auth middleware', 'same name is custom for a session with a different aiTitle');
});
