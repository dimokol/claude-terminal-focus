'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyBuild,
  schemeForBinaryName,
  cliForBinaryName,
  resolveCodeCli
} = require('../lib/code-build');

test('classifyBuild identifies each build from its binary basename', () => {
  assert.equal(classifyBuild('Code.exe'), 'stable');
  assert.equal(classifyBuild('Code - Insiders.exe'), 'insiders');
  assert.equal(classifyBuild('VSCodium.exe'), 'vscodium');
  assert.equal(classifyBuild('Codium.exe'), 'vscodium');
  assert.equal(classifyBuild('Cursor.exe'), 'cursor');
  assert.equal(classifyBuild('Windsurf.exe'), 'windsurf');
  assert.equal(classifyBuild('explorer.exe'), null);
  assert.equal(classifyBuild(''), null);
  assert.equal(classifyBuild(undefined), null);
});

test('classifyBuild is case-insensitive and basename-only', () => {
  assert.equal(classifyBuild('code - insiders.EXE'), 'insiders');
  assert.equal(classifyBuild('C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe'), 'insiders');
});

test('schemeForBinaryName maps the build to its URI scheme (this is the #4 fix)', () => {
  assert.equal(schemeForBinaryName('Code.exe'), 'vscode');
  assert.equal(schemeForBinaryName('Code - Insiders.exe'), 'vscode-insiders');
  assert.equal(schemeForBinaryName('VSCodium.exe'), 'vscodium');
  assert.equal(schemeForBinaryName('Cursor.exe'), 'cursor');
  assert.equal(schemeForBinaryName('Windsurf.exe'), 'windsurf');
});

test('schemeForBinaryName falls back to vscode (Stable) when unknown', () => {
  assert.equal(schemeForBinaryName('some-shell.exe'), 'vscode');
  assert.equal(schemeForBinaryName(''), 'vscode');
  assert.equal(schemeForBinaryName(undefined), 'vscode');
  assert.equal(schemeForBinaryName('x', 'vscode-insiders'), 'vscode-insiders');
});

test('cliForBinaryName maps each build to its CLI command', () => {
  assert.equal(cliForBinaryName('Code.exe'), 'code');
  assert.equal(cliForBinaryName('Code - Insiders.exe'), 'code-insiders');
  assert.equal(cliForBinaryName('VSCodium.exe'), 'codium');
  assert.equal(cliForBinaryName('Cursor.exe'), 'cursor');
  assert.equal(cliForBinaryName('Windsurf.exe'), 'windsurf');
  assert.equal(cliForBinaryName('explorer.exe'), null);
});

test('resolveCodeCli: Insiders binary maps to code-insiders without a probe', () => {
  assert.equal(resolveCodeCli({ binaryName: 'Code - Insiders.exe' }), 'code-insiders');
});

test('resolveCodeCli: trusts the mapping when the probe confirms presence', () => {
  const probe = (cli) => cli === 'code-insiders';
  assert.equal(resolveCodeCli({ binaryName: 'Code - Insiders.exe', probe }), 'code-insiders');
});

test('resolveCodeCli: mapped CLI absent on PATH falls through to an available one', () => {
  const probe = (cli) => cli === 'code';
  assert.equal(resolveCodeCli({ binaryName: 'Code - Insiders.exe', probe }), 'code');
});

test('resolveCodeCli: no binary name picks first available in preference order', () => {
  const probe = (cli) => cli === 'codium' || cli === 'cursor';
  assert.equal(resolveCodeCli({ probe }), 'codium');
});

test('resolveCodeCli: nothing on PATH returns the fallback', () => {
  const none = () => false;
  assert.equal(resolveCodeCli({ binaryName: 'Code - Insiders.exe', probe: none }), 'code');
  assert.equal(resolveCodeCli({ probe: none }), 'code');
  assert.equal(resolveCodeCli({ probe: none, fallback: 'code-insiders' }), 'code-insiders');
});

test('resolveCodeCli: empty opts returns code', () => {
  assert.equal(resolveCodeCli(), 'code');
  assert.equal(resolveCodeCli({}), 'code');
});
