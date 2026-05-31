const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  PROTOCOL_SCHEME,
  buildLaunchUri,
  parseLaunchUri,
  buildRegisterCommands,
  buildUnregisterCommand,
  installWinProtocol,
  uninstallWinProtocol,
  getLauncherDir
} = require('../lib/win-protocol');

test('PROTOCOL_SCHEME is the documented value', () => {
  assert.equal(PROTOCOL_SCHEME, 'claude-notif');
});

test('buildLaunchUri round-trips the payload via parseLaunchUri', () => {
  const payload = {
    sessionId: 'abc-123',
    event: 'completed',
    project: 'my-project',
    pids: [4321, 9999],
    shellPid: 4321,
    workspaceRoot: 'C:\\Users\\Friend\\Code\\my-project',
    projectDir: 'C:\\Users\\Friend\\Code\\my-project',
    aiTitle: 'Refactor — auth middleware',
    timestamp: 1700000000000
  };
  const uri = buildLaunchUri(payload);
  assert.match(uri, /^claude-notif:\/\/click\?marker=/);
  assert.deepEqual(parseLaunchUri(uri), payload);
});

test('buildLaunchUri keeps URI inside toast attribute char set (no <, >, &)', () => {
  const payload = { sessionId: 'x', event: 'waiting', project: 'p', pids: [1], shellPid: 1, workspaceRoot: 'C:\\a', projectDir: 'C:\\a', aiTitle: '', timestamp: 1 };
  const uri = buildLaunchUri(payload);
  assert.equal(uri.includes('<'), false);
  assert.equal(uri.includes('>'), false);
  assert.equal(uri.includes('&'), false);
});

test('parseLaunchUri returns null for unrelated or malformed URIs', () => {
  assert.equal(parseLaunchUri('vscode://file/C:/foo'), null);
  assert.equal(parseLaunchUri(''), null);
  assert.equal(parseLaunchUri('claude-notif://click'), null);
  assert.equal(parseLaunchUri('claude-notif://click?marker=not-base64-!!!'), null);
});

test('buildRegisterCommands returns three reg ADD invocations', () => {
  const cmds = buildRegisterCommands({
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    launcherPath: 'C:\\Users\\Friend\\AppData\\Local\\claude-notifications\\win-click-handler.js'
  });
  assert.equal(cmds.length, 3);
  assert.equal(cmds.every(c => c.bin === 'reg.exe'), true);
  assert.match(cmds[0].args.join(' '), /HKCU\\Software\\Classes\\claude-notif .* URL:Claude Notifications/);
  assert.equal(cmds[1].args.includes('URL Protocol'), true);
  assert.match(cmds[2].args.join(' '), /HKCU\\Software\\Classes\\claude-notif\\shell\\open\\command/);
  const valueArg = cmds[2].args[cmds[2].args.indexOf('/d') + 1];
  assert.match(valueArg, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(valueArg, /"C:\\Users\\Friend\\AppData\\Local\\claude-notifications\\win-click-handler\.js"/);
  assert.match(valueArg, /"%1"/);
});

test('buildUnregisterCommand deletes the whole subtree with /f', () => {
  const cmd = buildUnregisterCommand();
  assert.deepEqual(cmd.args, ['DELETE', 'HKCU\\Software\\Classes\\claude-notif', '/f']);
});

test('getLauncherDir uses LOCALAPPDATA when set', () => {
  const dir = getLauncherDir({ LOCALAPPDATA: 'C:\\Users\\F\\AppData\\Local' });
  assert.equal(dir, path.join('C:\\Users\\F\\AppData\\Local', 'claude-notifications'));
});

test('getLauncherDir falls back to ~/AppData/Local when LOCALAPPDATA is missing', () => {
  const dir = getLauncherDir({}, '/home/u');
  assert.equal(dir, path.join('/home/u', 'AppData', 'Local', 'claude-notifications'));
});

test('installWinProtocol writes the launcher file and invokes three reg ADDs', () => {
  const writes = [];
  const regCalls = [];
  const fsLike = {
    mkdirSync: (p, opts) => writes.push({ kind: 'mkdir', p, opts }),
    writeFileSync: (p, content) => writes.push({ kind: 'write', p, len: content.length })
  };
  const runRegLike = (bin, args) => { regCalls.push({ bin, args }); return { status: 0 }; };
  const result = installWinProtocol({
    bundledLauncherPath: '/ext/dist/win-click-handler.js',
    launcherSource: 'console.log("launcher")',
    nodeExe: 'C:\\nodejs\\node.exe',
    env: { LOCALAPPDATA: 'C:\\u\\AppData\\Local' },
    fsLike,
    runRegLike
  });
  assert.equal(result.ok, true);
  assert.equal(writes.filter(w => w.kind === 'mkdir').length, 1);
  // Only launcher when hideVbsSource omitted and bundledHideVbsPath not provided
  assert.equal(writes.filter(w => w.kind === 'write').length, 1);
  assert.equal(regCalls.length, 3);
  assert.equal(regCalls.every(c => c.bin === 'reg.exe'), true);
  // Registry value should fall back to direct node when no hide.vbs.
  const cmdCall = regCalls[2]; // third reg ADD is shell\open\command
  const cmdValue = cmdCall.args[cmdCall.args.indexOf('/d') + 1];
  assert.ok(!cmdValue.includes('wscript.exe'), 'fallback path should NOT route through wscript');
  assert.ok(cmdValue.startsWith('"C:\\nodejs\\node.exe"'), 'fallback path should start with quoted node.exe');
  assert.equal(result.hideVbsPath, null, 'hideVbsPath should be null when no vbs source');
});

test('installWinProtocol with hideVbsSource writes vbs + registers wscript-based command', () => {
  const writes = [];
  const regCalls = [];
  const fsLike = {
    mkdirSync: () => {},
    writeFileSync: (p, content) => writes.push({ p, len: content.length })
  };
  const runRegLike = (bin, args) => { regCalls.push({ bin, args }); return { status: 0 }; };
  const result = installWinProtocol({
    bundledLauncherPath: '/ext/dist/win-click-handler.js',
    launcherSource: 'console.log("launcher")',
    hideVbsSource: '\' hide.vbs\nObjShell.Run cmd, 0, False',
    nodeExe: 'C:\\nodejs\\node.exe',
    env: { LOCALAPPDATA: 'C:\\u\\AppData\\Local' },
    fsLike,
    runRegLike
  });
  assert.equal(result.ok, true);
  // Two writes: launcher.js + hide.vbs
  assert.equal(writes.length, 2);
  assert.ok(writes.some(w => w.p.endsWith('win-click-handler.js')));
  assert.ok(writes.some(w => w.p.endsWith('hide.vbs')));
  // hideVbsPath returned
  assert.ok(result.hideVbsPath && result.hideVbsPath.endsWith('hide.vbs'));
  // Registry command should go through wscript.exe
  const cmdCall = regCalls[2];
  const cmdValue = cmdCall.args[cmdCall.args.indexOf('/d') + 1];
  assert.ok(cmdValue.startsWith('wscript.exe '), `expected wscript-prefixed command, got: ${cmdValue}`);
  assert.ok(cmdValue.includes('hide.vbs'), 'wscript command should reference hide.vbs');
  assert.ok(cmdValue.includes('C:\\nodejs\\node.exe'), 'wscript command should pass nodeExe as arg');
  assert.ok(cmdValue.endsWith('"%1"'), 'wscript command should terminate with %1 placeholder');
});

test('installWinProtocol returns ok:false when reg.exe fails', () => {
  const fsLike = { mkdirSync: () => {}, writeFileSync: () => {} };
  const runRegLike = () => ({ status: 1, stderr: 'access denied' });
  const result = installWinProtocol({
    bundledLauncherPath: '/ext/dist/win-click-handler.js',
    launcherSource: '',
    nodeExe: 'node.exe',
    env: { LOCALAPPDATA: 'C:\\u\\AppData\\Local' },
    fsLike,
    runRegLike
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /access denied|reg/);
});

test('uninstallWinProtocol invokes reg DELETE and returns ok on success', () => {
  const calls = [];
  const runRegLike = (bin, args) => { calls.push({ bin, args }); return { status: 0 }; };
  const result = uninstallWinProtocol({ runRegLike });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['DELETE', 'HKCU\\Software\\Classes\\claude-notif', '/f']);
});

test('uninstallWinProtocol treats "key not found" exit code as success', () => {
  const runRegLike = () => ({ status: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' });
  const result = uninstallWinProtocol({ runRegLike });
  assert.equal(result.ok, true);
});
