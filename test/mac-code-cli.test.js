'use strict';

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  appRootFromExecPath,
  getEditorHostPath,
  readEditorHost,
  resolveMacCodeCli,
  writeEditorHost
} = require('../lib/mac-code-cli');

function makeApp(applicationName, cliName = applicationName) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-mac-app-'));
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'product.json'), JSON.stringify({ applicationName }));
  const cliPath = path.join(appRoot, 'bin', cliName);
  fs.writeFileSync(cliPath, '#!/bin/sh\n');
  fs.chmodSync(cliPath, 0o755);
  return { appRoot, cliPath };
}

test('resolveMacCodeCli uses an executable override (including ~ expansion)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-mac-home-'));
  const binDir = path.join(home, 'custom');
  fs.mkdirSync(binDir);
  const cliPath = path.join(binDir, 'codium-special');
  fs.writeFileSync(cliPath, '#!/bin/sh\n');
  fs.chmodSync(cliPath, 0o755);

  const result = resolveMacCodeCli({
    overridePath: '~/custom/codium-special',
    homeDir: home,
    uriScheme: 'vscodium'
  });
  assert.equal(result.codeCliPath, cliPath);
  assert.equal(result.cliName, 'codium-special');
  assert.equal(result.source, 'override');
});

test('resolveMacCodeCli trusts product.json for VS Code and unknown forks', () => {
  for (const cliName of ['code', 'code-insiders', 'codium', 'codium-insiders', 'cursor', 'windsurf', 'acme-code']) {
    const { appRoot, cliPath } = makeApp(cliName);
    const result = resolveMacCodeCli({ appRoot, uriScheme: 'unknown-scheme' });
    assert.equal(result.codeCliPath, cliPath, cliName);
    assert.equal(result.cliName, cliName);
  }
});

test('resolveMacCodeCli falls back to the host URI scheme mapping', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-mac-vscodium-'));
  fs.mkdirSync(path.join(appRoot, 'bin'));
  const cliPath = path.join(appRoot, 'bin', 'codium');
  fs.writeFileSync(cliPath, '#!/bin/sh\n');
  fs.chmodSync(cliPath, 0o755);

  const result = resolveMacCodeCli({ appRoot, uriScheme: 'vscodium' });
  assert.equal(result.codeCliPath, cliPath);
});

test('resolveMacCodeCli derives appRoot from the running app executable path', () => {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-mac-bundle-'));
  const appRoot = path.join(bundle, 'Acme.app', 'Contents', 'Resources', 'app');
  const macOSDir = path.join(bundle, 'Acme.app', 'Contents', 'MacOS');
  fs.mkdirSync(path.join(appRoot, 'bin'), { recursive: true });
  fs.mkdirSync(macOSDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'product.json'), JSON.stringify({ applicationName: 'acme' }));
  const cliPath = path.join(appRoot, 'bin', 'acme');
  fs.writeFileSync(cliPath, '#!/bin/sh\n');
  fs.chmodSync(cliPath, 0o755);
  const execPath = path.join(macOSDir, 'Electron');

  assert.equal(appRootFromExecPath(execPath), appRoot);
  assert.equal(resolveMacCodeCli({ execPath }).codeCliPath, cliPath);
});

test('resolveMacCodeCli ignores invalid paths and returns null when no host launcher exists', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-mac-empty-'));
  fs.mkdirSync(path.join(appRoot, 'bin'));
  assert.equal(resolveMacCodeCli({
    overridePath: 'relative/codium',
    appRoot,
    uriScheme: 'vscodium'
  }), null);
});

test('per-workspace editor host record round-trips atomically', () => {
  const workspaceRoot = path.join(os.tmpdir(), `cn-workspace-${process.pid}-${Date.now()}`);
  const host = {
    codeCliPath: '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
    cliName: 'codium',
    uriScheme: 'vscodium'
  };
  assert.equal(writeEditorHost(workspaceRoot, host), true);
  assert.equal(path.basename(getEditorHostPath(workspaceRoot)), 'editor-host');
  assert.deepEqual(readEditorHost(workspaceRoot), {
    version: 1,
    platform: 'darwin',
    ...host,
    updatedAt: readEditorHost(workspaceRoot).updatedAt
  });
  assert.ok(readEditorHost(workspaceRoot).updatedAt > 0);
});

test('readEditorHost rejects malformed or relative-path records', () => {
  const workspaceRoot = path.join(os.tmpdir(), `cn-invalid-workspace-${process.pid}-${Date.now()}`);
  const hostPath = getEditorHostPath(workspaceRoot);
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.writeFileSync(hostPath, JSON.stringify({ codeCliPath: 'codium' }));
  assert.equal(readEditorHost(workspaceRoot), null);
});
