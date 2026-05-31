// lib/hook-runtime.js — manages the stable-location wrapper directory.
//
// On every extension activation, installHookRuntime copies the bundled
// wrapper from dist/hook-wrapper.cjs into ~/.claude/claude-notifications/
// (as both hook.cjs and hook-user-prompt.cjs — same source, the wrapper
// self-routes by __filename) and writes state.json with the current
// extension's hook paths. settings.json hook entries then point at the
// wrapper instead of the extension's dist/, so the hook contract
// survives extension uninstalls/upgrades without leaving stale paths.
//
// The wrapper itself handles cleanup: when it next fires after the
// extension is gone, it self-destructs. See bin/hook-wrapper.cjs.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const WRAPPER_VERSION = 1;

function getRuntimeDir(home = os.homedir()) {
  return path.join(home, '.claude', 'claude-notifications');
}

function getWrapperHookPath(home = os.homedir()) {
  return path.join(getRuntimeDir(home), 'hook.cjs');
}

function getWrapperUserPromptPath(home = os.homedir()) {
  return path.join(getRuntimeDir(home), 'hook-user-prompt.cjs');
}

function getStateFilePath(home = os.homedir()) {
  return path.join(getRuntimeDir(home), 'state.json');
}

/**
 * Install/refresh the wrapper dir. Idempotent — always rewrites.
 *
 * @param {string} extensionPath - context.extensionPath
 * @param {object} [opts]
 * @param {string} [opts.extensionVersion]
 * @param {string} [opts.home]
 * @param {object} [opts.fsLike] - injectable for tests
 * @returns {{ ok: boolean, error?: string, wrapperDir?: string,
 *             wrapperHookPath?: string, wrapperUserPromptPath?: string }}
 */
function installHookRuntime(extensionPath, opts = {}) {
  const home = opts.home || os.homedir();
  const fsLike = opts.fsLike || fs;
  const wrapperDir = getRuntimeDir(home);
  const wrapperHookPath = getWrapperHookPath(home);
  const wrapperUserPromptPath = getWrapperUserPromptPath(home);

  const extHookPath = path.join(extensionPath, 'dist', 'hook.js');
  const extUserPromptPath = path.join(extensionPath, 'dist', 'hook-user-prompt.js');
  const bundledWrapperPath = path.join(extensionPath, 'dist', 'hook-wrapper.cjs');

  let wrapperSource;
  try {
    wrapperSource = fs.readFileSync(bundledWrapperPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `read bundled wrapper: ${e.message}` };
  }

  try {
    fsLike.mkdirSync(wrapperDir, { recursive: true });
    fsLike.writeFileSync(wrapperHookPath, wrapperSource);
    fsLike.writeFileSync(wrapperUserPromptPath, wrapperSource);
    const state = {
      wrapperVersion: WRAPPER_VERSION,
      extensionHookPath: extHookPath,
      extensionUserPromptHookPath: extUserPromptPath,
      extensionVersion: opts.extensionVersion || '',
      installedAt: Date.now()
    };
    fsLike.writeFileSync(getStateFilePath(home), JSON.stringify(state, null, 2));
  } catch (e) {
    return { ok: false, error: `write wrapper: ${e.message}` };
  }

  return { ok: true, wrapperDir, wrapperHookPath, wrapperUserPromptPath };
}

/**
 * Remove the wrapper directory. Idempotent.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {object} [opts.fsLike] - injectable for tests
 * @returns {{ ok: boolean, error?: string }}
 */
function uninstallHookRuntime(opts = {}) {
  const home = opts.home || os.homedir();
  const fsLike = opts.fsLike || fs;
  const wrapperDir = getRuntimeDir(home);
  try {
    fsLike.rmSync(wrapperDir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

module.exports = {
  WRAPPER_VERSION,
  getRuntimeDir,
  getWrapperHookPath,
  getWrapperUserPromptPath,
  getStateFilePath,
  installHookRuntime,
  uninstallHookRuntime
};
