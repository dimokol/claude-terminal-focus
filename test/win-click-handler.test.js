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
