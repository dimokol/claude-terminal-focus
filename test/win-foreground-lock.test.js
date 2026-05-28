// test/win-foreground-lock.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  parseFltQuery,
  buildReadCommand,
  buildWriteCommand,
  FLT_VALUE_NAME
} = require('../lib/win-foreground-lock');

test('parseFltQuery reads a standard hex DWORD', () => {
  const out = [
    'HKEY_CURRENT_USER\\Control Panel\\Desktop',
    '    ForegroundLockTimeout    REG_DWORD    0x30d40',
    ''
  ].join('\r\n');
  assert.strictEqual(parseFltQuery(out), 0x30d40); // 200000
});

test('parseFltQuery reads 0x0 as 0', () => {
  const out = '    ForegroundLockTimeout    REG_DWORD    0x0\r\n';
  assert.strictEqual(parseFltQuery(out), 0);
});

test('parseFltQuery returns null when value absent', () => {
  const out = 'HKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    Wallpaper    REG_SZ    C:\\x.jpg\r\n';
  assert.strictEqual(parseFltQuery(out), null);
});

test('parseFltQuery returns null on garbage / error text', () => {
  assert.strictEqual(parseFltQuery('ERROR: The system was unable to find...'), null);
  assert.strictEqual(parseFltQuery(''), null);
  assert.strictEqual(parseFltQuery(null), null);
});

test('buildReadCommand targets HKCU Desktop / ForegroundLockTimeout', () => {
  const cmd = buildReadCommand();
  assert.strictEqual(cmd.bin, 'reg.exe');
  assert.ok(cmd.args.includes('query'));
  assert.ok(cmd.args.some(a => a.includes('Control Panel\\Desktop')));
  assert.ok(cmd.args.includes(FLT_VALUE_NAME));
});

test('buildWriteCommand writes a REG_DWORD with /f', () => {
  const cmd = buildWriteCommand(0);
  assert.strictEqual(cmd.bin, 'reg.exe');
  assert.ok(cmd.args.includes('add'));
  assert.ok(cmd.args.includes('REG_DWORD'));
  assert.ok(cmd.args.includes('/f'));
  const dIdx = cmd.args.indexOf('/d');
  assert.strictEqual(cmd.args[dIdx + 1], '0');
});
