// lib/code-build.js — single source of truth for "which VS Code build is
// this, and how do I talk to it?".
//
// Given a binary basename from the process-tree snapshot (e.g.
// 'Code - Insiders.exe'), classify the build and look up the two things we
// need to target that SAME build from outside it:
//   - launchScheme: the URI scheme its UriHandler answers (vscode://,
//     vscode-insiders://, ...). Used by hook.js to build the toast's
//     launch=. Stable owns vscode://, so an Insiders user clicking a
//     vscode:// toast gets a fresh STABLE window instead of their Insiders
//     instance (GitHub #4). Emitting the matching scheme fixes that.
//   - cli: the command-line launcher (code, code-insiders, ...). Used by
//     win-click-handler.js#spawnCodeFallback so the fallback opens the
//     right build too.
//
// STAGED: the one-line wiring in hook.js (launchScheme) and
// win-click-handler.js (cli) is applied after the parallel Windows
// foreground-lock work lands, to avoid edit conflicts. Until then this is
// pure, tested logic with no callers.
//
// Pure mapping + an injectable PATH probe so it stays testable off-Windows.

'use strict';

// Order matters: the Insiders pattern must precede the bare-Code pattern.
const BUILDS = [
  { id: 'insiders', re: /^Code - Insiders\.exe$/i, scheme: 'vscode-insiders', cli: 'code-insiders' },
  { id: 'stable',   re: /^Code\.exe$/i,            scheme: 'vscode',          cli: 'code' },
  { id: 'vscodium', re: /^(VSCodium|Codium)\.exe$/i, scheme: 'vscodium',      cli: 'codium' },
  { id: 'cursor',   re: /^Cursor\.exe$/i,          scheme: 'cursor',          cli: 'cursor' },
  { id: 'windsurf', re: /^Windsurf\.exe$/i,        scheme: 'windsurf',        cli: 'windsurf' }
];

// Preference order when the build is unknown. Stable first: most common and
// the safest default for both scheme and CLI.
const CLI_PREFERENCE = ['code', 'code-insiders', 'codium', 'cursor', 'windsurf'];

function buildFor(name) {
  if (typeof name !== 'string' || name === '') return null;
  const base = name.replace(/^.*[/\\]/, '');
  return BUILDS.find(b => b.re.test(base)) || null;
}

/**
 * Classify a binary basename into a build id, or null if unrecognized.
 * @param {string} name
 * @returns {('stable'|'insiders'|'vscodium'|'cursor'|'windsurf')|null}
 */
function classifyBuild(name) {
  const b = buildFor(name);
  return b ? b.id : null;
}

/**
 * The URI launch scheme for the build owning `binaryName`.
 * Falls back to 'vscode' (Stable) when unknown — same as the pre-#4 behavior.
 * Returned WITHOUT the '://' suffix.
 * @param {string} binaryName
 * @param {string} [fallback]
 * @returns {string}
 */
function schemeForBinaryName(binaryName, fallback = 'vscode') {
  const b = buildFor(binaryName);
  return b ? b.scheme : fallback;
}

/**
 * The CLI command for the build owning `binaryName`, or null if unrecognized.
 * @param {string} binaryName
 * @returns {string|null}
 */
function cliForBinaryName(binaryName) {
  const b = buildFor(binaryName);
  return b ? b.cli : null;
}

/**
 * Resolve the CLI command spawnCodeFallback should launch.
 *
 *   1. If the resolved instance's binary maps to a CLI, prefer it. The
 *      mapping comes from the running process, so it is authoritative about
 *      WHICH build to target. Trust it even when `probe` cannot find it on
 *      PATH (shims/aliases that `where` misses are common) UNLESS a probe is
 *      supplied AND positively reports it absent.
 *   2. Otherwise pick the first CLI the probe confirms present, in
 *      CLI_PREFERENCE order.
 *   3. Otherwise return `fallback` ('code') — the pre-#4 behavior.
 *
 * @param {object} opts
 * @param {string} [opts.binaryName]
 * @param {(cli: string) => boolean} [opts.probe]
 * @param {string} [opts.fallback]
 * @returns {string}
 */
function resolveCodeCli({ binaryName, probe, fallback = 'code' } = {}) {
  const mapped = cliForBinaryName(binaryName);
  if (mapped) {
    if (typeof probe !== 'function' || probe(mapped)) return mapped;
  }
  if (typeof probe === 'function') {
    for (const cli of CLI_PREFERENCE) {
      if (probe(cli)) return cli;
    }
  }
  return fallback;
}

module.exports = {
  BUILDS,
  CLI_PREFERENCE,
  classifyBuild,
  schemeForBinaryName,
  cliForBinaryName,
  resolveCodeCli
};
