// lib/terminal-match.js — pick which VS Code terminal a Claude signal belongs to.
//
// Pure function (no VS Code API, no I/O). The caller normalizes VS Code's
// terminal list into `{ index, name, pid, cwd }[]` and passes the parsed
// signal in; we return the index of the best match or null.
//
// Tiers run in order; the first tier that produces exactly one match wins.
// If a tier matches zero or 2+ terminals, fall through. NO fallback to
// "last terminal" — guessing was the v3.3.x bug. Better to do nothing.
//
// Tier order rationale:
//   1. PID match — only reliable when shells aren't wrapped (cmd, native pwsh).
//      Broken on Windows + Git Bash (MSYS2 fork model, see hook.js notes).
//   2. cwd match — VS Code 1.74+ shellIntegration exposes the real cwd.
//      Robust across shell types when shell integration is enabled.
//   3. Claude markers — Claude Code writes ANSI title escapes: '✳' while
//      thinking, '⚒' while running tools, project basename when idle.
//      Free signal that we previously ignored entirely (we only looked for
//      literal 'claude' / 'node' substrings, which Claude never writes).
//   4. Non-default-name — if exactly one terminal isn't named after a stock
//      shell, prefer it. Common on Windows where 'powershell' is opened
//      reflexively and the Claude one has a custom title.

const DEFAULT_SHELL_NAMES = new Set([
  'bash', 'powershell', 'pwsh', 'cmd', 'zsh', 'sh', 'fish',
  'terminal', 'shell', 'git bash', 'command prompt'
]);

const CLAUDE_TITLE_MARKERS = ['✳', '⚒', '▣', '✻'];
const PROJECT_NAME_MIN_LEN = 4; // avoid false positives on short basenames like 'app'

/**
 * @param {{index:number,name:string,pid:?number,cwd:?string}[]} terminals
 * @param {{pids:number[],shellPid?:number,workspaceRoot?:string,projectDir?:string,project?:string}} signal
 * @returns {{index:number, tier:string, reason:string} | null}
 */
function matchTerminal(terminals, signal) {
  if (!Array.isArray(terminals) || terminals.length === 0) return null;
  const sig = signal || {};
  const pidSet = new Set([
    ...(Array.isArray(sig.pids) ? sig.pids : []),
    ...(sig.shellPid ? [sig.shellPid] : [])
  ]);

  // --- Tier 1: PID match (shellPid first, then any signal pid) ---
  const pidMatches = terminals.filter(t => t.pid && pidSet.has(t.pid));
  if (pidMatches.length === 1) {
    const t = pidMatches[0];
    const why = sig.shellPid === t.pid ? `shellPid=${t.pid}` : `pid=${t.pid} in signal.pids`;
    return { index: t.index, tier: 'pid', reason: why };
  }

  // Strict-PID escape for POSIX: signal.shellPid is the OS-level shell
  // PID that hosts Claude. On POSIX (pidChainSource='ps') it's reliable
  // and appears in terminal.processId directly. If no terminal has it,
  // the firing session is NOT in this window's terminal list — falling
  // through to cwd/marker tiers would falsely match a sibling Claude
  // session in the same workspace (e.g. multiple sessions across VS Code
  // windows or external terminals sharing the same cwd). On Windows +
  // Git Bash (pidChainSource='powershell' or null) the chain is indirect
  // because of MSYS2/winpty, so we must keep the existing cwd/marker
  // fallbacks even when shellPid mismatches. Same applies when
  // pidChainSource is missing — be permissive rather than block.
  if (sig.shellPid &&
      pidMatches.length === 0 &&
      sig.pidChainSource === 'ps') {
    return null;
  }

  // --- Tier 2: cwd match via shell integration ---
  const workspaceRoot = normalizePath(sig.workspaceRoot || '');
  const projectDir = normalizePath(sig.projectDir || '');
  if (workspaceRoot || projectDir) {
    const cwdMatches = terminals.filter(t => {
      const cwd = normalizePath(t.cwd || '');
      if (!cwd) return false;
      if (workspaceRoot && cwd === workspaceRoot) return true;
      if (projectDir && cwd === projectDir) return true;
      if (workspaceRoot && cwd.startsWith(workspaceRoot + '/')) return true;
      if (projectDir && cwd.startsWith(projectDir + '/')) return true;
      return false;
    });
    if (cwdMatches.length === 1) {
      const t = cwdMatches[0];
      return { index: t.index, tier: 'cwd', reason: `cwd=${t.cwd}` };
    }
  }

  // --- Tier 3: Claude title markers / project basename in terminal name ---
  const project = (sig.project || '').toLowerCase();
  const projectOk = project.length >= PROJECT_NAME_MIN_LEN;
  const markerMatches = terminals.filter(t => {
    const name = (t.name || '');
    if (!name) return false;
    for (const m of CLAUDE_TITLE_MARKERS) {
      if (name.includes(m)) return true;
    }
    const lower = name.toLowerCase();
    if (lower.includes('claude')) return true;
    if (projectOk && lower.includes(project)) return true;
    return false;
  });
  if (markerMatches.length === 1) {
    const t = markerMatches[0];
    return { index: t.index, tier: 'claude-marker', reason: `name="${t.name}"` };
  }

  // --- Tier 4: single non-default-shell-named terminal ---
  const nonDefault = terminals.filter(t => !isDefaultShellName(t.name));
  if (nonDefault.length === 1) {
    const t = nonDefault[0];
    return { index: t.index, tier: 'non-default-name', reason: `only non-default-named terminal: "${t.name}"` };
  }

  return null;
}

function isDefaultShellName(name) {
  if (!name) return true; // unnamed terminal is treated as default-ish
  const trimmed = name.trim().toLowerCase();
  if (DEFAULT_SHELL_NAMES.has(trimmed)) return true;
  // VS Code sometimes appends ' (1)', ' (2)' to duplicate names.
  const stripped = trimmed.replace(/\s*\(\d+\)\s*$/, '');
  return DEFAULT_SHELL_NAMES.has(stripped);
}

function normalizePath(p) {
  if (!p) return '';
  // Lowercase on Windows-style paths so D:\foo and d:\foo match. Forward
  // slashes only — VS Code's shellIntegration.cwd is forward-slash on
  // Windows already, but be defensive.
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:\//.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}

module.exports = {
  matchTerminal,
  isDefaultShellName,
  normalizePath,
  DEFAULT_SHELL_NAMES,
  CLAUDE_TITLE_MARKERS
};
