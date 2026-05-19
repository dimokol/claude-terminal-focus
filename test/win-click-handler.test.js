const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractPayload } = require('../bin/win-click-handler');
const { buildLaunchUri } = require('../lib/win-protocol');

test('extractPayload returns the decoded payload for a valid URI', () => {
  const payload = {
    sessionId: 's', event: 'completed', project: 'p',
    pids: [1], shellPid: 1,
    workspaceRoot: 'C:\\a', projectDir: 'C:\\a',
    aiTitle: '', timestamp: 1
  };
  const uri = buildLaunchUri(payload);
  assert.deepEqual(extractPayload(uri), payload);
});

test('extractPayload returns null for missing argv', () => {
  assert.equal(extractPayload(undefined), null);
  assert.equal(extractPayload(''), null);
});

test('extractPayload returns null for unrelated URIs', () => {
  assert.equal(extractPayload('vscode://file/C:/foo'), null);
});

test('extractPayload rejects payloads missing required workspaceRoot', () => {
  const uri = buildLaunchUri({ sessionId: 's' });
  assert.equal(extractPayload(uri), null);
});

test('extractPayload preserves a workspaceRoot with spaces (verifies the path round-trips intact end-to-end)', () => {
  // Regression: friend's workspaceRoot was
  //   D:\SilvWeb Studio\Projects\2026\SilvWeb Labs\labs.silvweb.studio
  // The wrapper used to mangle this into multiple bogus args, opening
  // untitled placeholder files. The decode side has always been fine —
  // the fix is in the spawn call (single quoted string, not args array).
  // This test guards the decode path against any future regression.
  const payload = {
    sessionId: 's', event: 'completed', project: 'labs.silvweb.studio',
    pids: [1], shellPid: 1,
    workspaceRoot: 'D:\\SilvWeb Studio\\Projects\\2026\\SilvWeb Labs\\labs.silvweb.studio',
    projectDir: 'D:\\SilvWeb Studio\\Projects\\2026\\SilvWeb Labs\\labs.silvweb.studio',
    aiTitle: '', timestamp: 1
  };
  const uri = buildLaunchUri(payload);
  const decoded = extractPayload(uri);
  assert.equal(decoded.workspaceRoot, payload.workspaceRoot);
});
