const { test } = require('node:test');
const assert = require('node:assert');
const { matchTerminal, isDefaultShellName, normalizePath } = require('../lib/terminal-match');

const T = (index, name, pid, cwd) => ({ index, name, pid, cwd });

test('returns null on empty terminal list', () => {
  assert.strictEqual(matchTerminal([], { pids: [1] }), null);
});

test('PID tier: signal.shellPid matches terminal.pid', () => {
  const terminals = [T(0, 'bash', 1234, null), T(1, 'powershell', 5678, null)];
  const m = matchTerminal(terminals, { pids: [], shellPid: 1234 });
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'pid');
});

test('PID tier: any pid in signal.pids matches', () => {
  const terminals = [T(0, 'bash', 1234, null), T(1, 'powershell', 5678, null)];
  const m = matchTerminal(terminals, { pids: [9999, 5678] });
  assert.strictEqual(m.index, 1);
  assert.strictEqual(m.tier, 'pid');
});

test('PID tier: ambiguous (two terminals match) falls through', () => {
  // Unlikely in practice but defensive.
  const terminals = [T(0, 'bash', 1234, '/p'), T(1, 'bash', 1234, '/p')];
  const m = matchTerminal(terminals, { pids: [1234], workspaceRoot: '/p' });
  // PID tier matched 2, cwd matches 2, marker matches 0, non-default matches 0
  assert.strictEqual(m, null);
});

test('cwd tier: exact workspaceRoot match', () => {
  const terminals = [
    T(0, 'bash', 1, '/home/u/proj'),
    T(1, 'powershell', 2, '/home/u')
  ];
  const m = matchTerminal(terminals, { pids: [], workspaceRoot: '/home/u/proj' });
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'cwd');
});

test('cwd tier: subdir of workspaceRoot match', () => {
  const terminals = [
    T(0, 'bash', 1, '/home/u/proj/src'),
    T(1, 'powershell', 2, '/somewhere/else')
  ];
  const m = matchTerminal(terminals, { pids: [], workspaceRoot: '/home/u/proj' });
  assert.strictEqual(m.index, 0);
});

test('cwd tier: Windows path case-insensitive drive letter', () => {
  const terminals = [
    T(0, 'bash', 1, 'd:\\SilvWeb Studio\\silvweb.studio'),
    T(1, 'powershell', 2, 'C:\\Users\\u')
  ];
  const m = matchTerminal(terminals, { pids: [], workspaceRoot: 'D:\\SilvWeb Studio\\silvweb.studio' });
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'cwd');
});

test('claude-marker tier: ✳ in name', () => {
  const terminals = [
    T(0, '✳ Debug exported Webflow website on cPanel', 18260, null),
    T(1, 'powershell', 3848, null)
  ];
  const m = matchTerminal(terminals, { pids: [3584, 17332], project: 'silvweb.studio' });
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'claude-marker');
});

test('claude-marker tier: project basename in name', () => {
  const terminals = [
    T(0, 'silvweb.studio', 1, null),
    T(1, 'powershell', 2, null)
  ];
  const m = matchTerminal(terminals, { pids: [], project: 'silvweb.studio' });
  assert.strictEqual(m.index, 0);
});

test('claude-marker tier: project basename too short → not used', () => {
  const terminals = [
    T(0, 'app', 1, null),
    T(1, 'powershell', 2, null)
  ];
  const m = matchTerminal(terminals, { pids: [], project: 'app' });
  // 'app' is 3 chars (< PROJECT_NAME_MIN_LEN). Falls through to non-default-name.
  // 'app' is not in default shell names → it's the single non-default → matches.
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'non-default-name');
});

test('non-default-name tier: single non-default terminal wins', () => {
  const terminals = [
    T(0, 'My Custom Terminal', 1, null),
    T(1, 'powershell', 2, null),
    T(2, 'cmd', 3, null)
  ];
  const m = matchTerminal(terminals, { pids: [] });
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'non-default-name');
});

test('non-default-name tier: two non-default terminals → null (ambiguous)', () => {
  const terminals = [
    T(0, 'Custom A', 1, null),
    T(1, 'Custom B', 2, null)
  ];
  const m = matchTerminal(terminals, { pids: [] });
  assert.strictEqual(m, null);
});

test('non-default-name tier: VS Code numbered suffix is still "default"', () => {
  const terminals = [
    T(0, 'My Claude Session', 1, null),
    T(1, 'powershell (1)', 2, null),
    T(2, 'powershell (2)', 3, null)
  ];
  const m = matchTerminal(terminals, { pids: [] });
  assert.strictEqual(m.index, 0);
});

test('tier ordering: PID beats cwd', () => {
  const terminals = [
    T(0, 'bash', 1, '/some/other/dir'),
    T(1, 'bash', 9999, '/home/u/proj')
  ];
  const m = matchTerminal(terminals, { pids: [1], workspaceRoot: '/home/u/proj' });
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'pid');
});

test('tier ordering: cwd beats claude-marker', () => {
  const terminals = [
    T(0, '✳ busy task', 1, '/wrong/dir'),
    T(1, 'bash', 2, '/home/u/proj')
  ];
  const m = matchTerminal(terminals, { pids: [], workspaceRoot: '/home/u/proj' });
  assert.strictEqual(m.index, 1);
  assert.strictEqual(m.tier, 'cwd');
});

test('no fallback: nothing matches → returns null (not "last terminal")', () => {
  const terminals = [
    T(0, 'powershell', 1, '/somewhere'),
    T(1, 'cmd', 2, '/elsewhere')
  ];
  const m = matchTerminal(terminals, { pids: [9999], workspaceRoot: '/home/u/proj', project: 'proj' });
  assert.strictEqual(m, null);
});

test('real-world scenario: her bug report log', () => {
  // From the v3.3.2 user report on Windows + Git Bash.
  const terminals = [
    T(0, '✳ Debug exported Webflow website on cPanel', 18260, null),
    T(1, 'powershell', 3848, null)
  ];
  const signal = {
    pids: [3584, 17332, 14576, 18832, 14100],
    workspaceRoot: 'd:\\SilvWeb Studio\\silvweb.studio',
    project: 'silvweb.studio'
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.index, 0, 'should pick the Git Bash terminal where Claude is running');
  assert.strictEqual(m.tier, 'claude-marker');
});

// Strict-PID rule (v3.5.4): when signal has a reliable shellPid (POSIX-style
// pidChainSource='ps') and NO terminal has matching pid, do NOT fall through
// to cwd/marker tiers — they would falsely match a sibling Claude session
// sharing the same workspace.

test('strict-pid (POSIX): shellPid set, no terminal pid matches → null even if cwd would', () => {
  // User has two Claude sessions in the same workspace. Window's active
  // terminal is session A. Signal fires from session B (different shellPid).
  // tier=pid would miss (B's shellPid not in window's terminals), tier=cwd
  // would match A's cwd → false positive without strict rule.
  const terminals = [T(0, '✳ Session A', 200, '/Users/u/proj')];
  const signal = {
    pids: [400, 300, 250, 1],
    shellPid: 250,                  // session B's shell — not present here
    workspaceRoot: '/Users/u/proj',
    pidChainSource: 'ps'
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m, null, 'POSIX with reliable shellPid + no match must return null');
});

test('strict-pid (POSIX): shellPid set, terminal pid matches → returns the match', () => {
  // Sanity check: positive case still works.
  const terminals = [T(0, '✳ Session B', 250, '/Users/u/proj')];
  const signal = {
    pids: [400, 300, 250, 1],
    shellPid: 250,
    workspaceRoot: '/Users/u/proj',
    pidChainSource: 'ps'
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'pid');
});

test('strict-pid does NOT apply on Windows (pidChainSource="powershell")', () => {
  // Git Bash + Windows: shellPid is set but masked by MSYS2/winpty, so it
  // won't match terminal.processId. The cwd/marker fallbacks must still
  // work — that was the original v3.4.0 use case.
  const terminals = [T(0, '✳ Session', 999, 'd:/proj')];
  const signal = {
    pids: [400, 300, 250, 1],
    shellPid: 250,                  // masked, doesn't appear in terminal.pid
    workspaceRoot: 'd:/proj',
    pidChainSource: 'powershell'    // Windows snapshot
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'cwd');
});

test('strict-pid does NOT apply when signal lacks pidChainSource (legacy / unknown)', () => {
  // Defensive: missing field should not block matching — be permissive.
  const terminals = [T(0, '✳ Session', 999, '/Users/u/proj')];
  const signal = {
    pids: [400, 300, 250, 1],
    shellPid: 250,
    workspaceRoot: '/Users/u/proj'
    // pidChainSource omitted
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.tier, 'cwd', 'unknown chain source should fall through to cwd');
});

test('strict-pid: signal without shellPid → not applied (no claim of reliability)', () => {
  // If hook.js couldn't determine shellPid, we have nothing to be strict
  // about — fall through to cwd/marker as before.
  const terminals = [T(0, '✳ Session', 999, '/Users/u/proj')];
  const signal = {
    pids: [400, 300, 250, 1],
    workspaceRoot: '/Users/u/proj',
    pidChainSource: 'ps'
    // shellPid omitted
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.tier, 'cwd');
});

// ai-title tier (v3.5.4) — Claude Code writes the session task name to the
// terminal title. With multiple Claude sessions in one workspace, this is
// often the ONLY unique discriminator (tier=pid may miss for shell-wrapped
// or cross-window scenarios; tier=cwd matches every workspace terminal;
// generic ✳ marker matches every Claude terminal). aiTitle, written by
// Claude itself, is unique per session.

test('ai-title tier: unique title substring picks the right Claude terminal', () => {
  // Three terminals all in same workspace, all with ✳ marker (multi-Claude
  // scenario). Without ai-title, tier=cwd and tier=claude-marker would both
  // go ambiguous and fall through. ai-title picks the one matching signal.
  const terminals = [
    T(0, '✳ Address claude notifications open issues', 100, '/Users/u/proj'),
    T(1, '✳ Investigate stray node processes', 200, '/Users/u/proj'),
    T(2, 'zsh', 300, '/Users/u/proj')
  ];
  const signal = {
    pids: [400, 1],                    // none of these match terminals
    workspaceRoot: '/Users/u/proj',
    project: 'proj',
    aiTitle: 'Address claude notifications open issues'
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m.tier, 'ai-title');
});

test('ai-title tier: ambiguous (two terminals share title substring) falls through', () => {
  const terminals = [
    T(0, '✳ Some Task', 100, '/Users/u/proj'),
    T(1, '✳ Some Task', 200, '/Users/u/proj')
  ];
  const signal = {
    pids: [1],
    workspaceRoot: '/Users/u/proj',
    project: 'proj',
    aiTitle: 'Some Task'
  };
  const m = matchTerminal(terminals, signal);
  // Two terminals with same title → ambiguous → falls through to
  // claude-marker tier (both have ✳, also ambiguous) → falls through to
  // non-default-name tier (both non-default, ambiguous) → null.
  assert.strictEqual(m, null);
});

test('ai-title tier: short title (<4 chars) is ignored to avoid false positives', () => {
  // Very short aiTitles could spuriously match unrelated terminal-name
  // substrings. We require >=4 chars before honoring this tier.
  const terminals = [
    T(0, 'no.js helper terminal', 100, '/Users/u/proj'),
    T(1, '✳ Real Claude session', 200, '/Users/u/proj')
  ];
  const signal = {
    pids: [1],
    workspaceRoot: '/Users/u/proj',
    project: 'proj',
    aiTitle: 'no'  // 2 chars — too short
  };
  const m = matchTerminal(terminals, signal);
  // Should fall through to claude-marker (only [1] has ✳) → match [1]
  assert.strictEqual(m.index, 1);
  assert.strictEqual(m.tier, 'claude-marker');
});

test('ai-title tier: missing aiTitle falls through gracefully', () => {
  // Two terminals so cwd is ambiguous; only one has ✳ marker so
  // claude-marker tier resolves uniquely. Without aiTitle, ai-title
  // tier is silently skipped.
  const terminals = [
    T(0, '✳ Foo', 100, '/Users/u/proj'),
    T(1, 'zsh', 200, '/Users/u/proj')
  ];
  const signal = {
    pids: [1],
    workspaceRoot: '/Users/u/proj',
    project: 'proj'
    // no aiTitle
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m.tier, 'claude-marker');
});

test('ai-title tier: runs AFTER strict-PID escape (POSIX shellPid mismatch still nulls)', () => {
  // Defensive: when POSIX strict-PID returns null because the firing
  // session is definitively NOT in this window's terminals, we MUST
  // continue to return null — even if aiTitle would have matched. The
  // strict-PID rule is the more reliable signal in that scenario.
  const terminals = [T(0, '✳ Address foo', 100, '/Users/u/proj')];
  const signal = {
    pids: [400],
    shellPid: 999,                    // not in any terminal
    workspaceRoot: '/Users/u/proj',
    pidChainSource: 'ps',             // strict-PID applies
    aiTitle: 'Address foo'            // would match if reached
  };
  const m = matchTerminal(terminals, signal);
  assert.strictEqual(m, null, 'strict-PID must short-circuit BEFORE ai-title tier runs');
});

test('isDefaultShellName covers common shells', () => {
  for (const n of ['bash', 'Bash', ' powershell ', 'pwsh', 'cmd', 'zsh', 'fish', 'sh']) {
    assert.ok(isDefaultShellName(n), `${n} should be default`);
  }
  assert.ok(!isDefaultShellName('Custom'));
  assert.ok(!isDefaultShellName('✳ task'));
});

test('normalizePath lowercases Windows drive letter and strips trailing slashes', () => {
  assert.strictEqual(normalizePath('D:\\foo\\bar\\'), 'd:/foo/bar');
  assert.strictEqual(normalizePath('/home/u/proj/'), '/home/u/proj');
});
