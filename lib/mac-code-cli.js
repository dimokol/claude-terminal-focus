// lib/mac-code-cli.js — resolve and persist the CLI for the editor product
// hosting this extension on macOS. hook.js runs outside the editor, so it
// cannot access vscode.env.appRoot / uriScheme directly.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStateDir } = require('./state-paths');

const EDITOR_HOST_FILE = 'editor-host';
const EDITOR_HOST_VERSION = 1;

const SCHEME_CLI_NAMES = {
  vscode: ['code'],
  'vscode-insiders': ['code-insiders'],
  vscodium: ['codium'],
  'vscodium-insiders': ['codium-insiders'],
  'vscode-oss': ['codium', 'code-oss'],
  'code-oss': ['code-oss'],
  cursor: ['cursor'],
  windsurf: ['windsurf']
};

function safeCliName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || path.basename(name) !== name) return '';
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : '';
}

function expandHome(value, homeDir = os.homedir()) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}

function isExecutable(filePath, fsLike = fs) {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    fsLike.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function readApplicationName(appRoot, fsLike = fs) {
  if (!appRoot) return '';
  try {
    const product = JSON.parse(fsLike.readFileSync(path.join(appRoot, 'product.json'), 'utf8'));
    return safeCliName(product && product.applicationName);
  } catch (_) {
    return '';
  }
}

function appRootFromExecPath(execPath) {
  if (typeof execPath !== 'string' || !execPath) return '';
  const normalized = execPath.replace(/\\/g, '/');
  const marker = '/Contents/MacOS/';
  const index = normalized.indexOf(marker);
  if (index < 0) return '';
  return path.join(normalized.slice(0, index), 'Contents', 'Resources', 'app');
}

/**
 * Resolve the current editor's macOS CLI to an absolute executable path.
 * Returns metadata suitable for the hook config / per-workspace host record.
 */
function resolveMacCodeCli({
  overridePath = '',
  appRoot = '',
  uriScheme = '',
  execPath = '',
  homeDir = os.homedir(),
  fsLike = fs
} = {}) {
  const override = expandHome(overridePath, homeDir);
  if (isExecutable(override, fsLike)) {
    return {
      codeCliPath: override,
      cliName: path.basename(override),
      uriScheme: typeof uriScheme === 'string' ? uriScheme : '',
      source: 'override'
    };
  }

  const roots = [];
  const addRoot = (root) => {
    if (typeof root === 'string' && root && !roots.includes(root)) roots.push(root);
  };
  addRoot(appRoot);
  addRoot(appRootFromExecPath(execPath));

  const names = [];
  const addName = (name) => {
    const safe = safeCliName(name);
    if (safe && !names.includes(safe)) names.push(safe);
  };
  for (const root of roots) addName(readApplicationName(root, fsLike));
  const scheme = typeof uriScheme === 'string' ? uriScheme.trim().toLowerCase() : '';
  for (const name of SCHEME_CLI_NAMES[scheme] || []) addName(name);
  addName(scheme);

  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, 'bin', name);
      if (isExecutable(candidate, fsLike)) {
        return {
          codeCliPath: candidate,
          cliName: name,
          uriScheme: typeof uriScheme === 'string' ? uriScheme : '',
          source: 'app-root'
        };
      }
    }
  }
  return null;
}

function getEditorHostPath(workspaceRoot) {
  return path.join(getStateDir(workspaceRoot), EDITOR_HOST_FILE);
}

function normalizeEditorHost(value) {
  if (!value || typeof value !== 'object') return null;
  const codeCliPath = typeof value.codeCliPath === 'string' ? value.codeCliPath : '';
  if (!path.isAbsolute(codeCliPath)) return null;
  return {
    version: EDITOR_HOST_VERSION,
    platform: 'darwin',
    codeCliPath,
    cliName: safeCliName(value.cliName) || path.basename(codeCliPath),
    uriScheme: typeof value.uriScheme === 'string' ? value.uriScheme : '',
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  };
}

function writeEditorHost(workspaceRoot, host, fsLike = fs) {
  const normalized = normalizeEditorHost({ ...host, updatedAt: Date.now() });
  if (!normalized) return false;
  const finalPath = getEditorHostPath(workspaceRoot);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fsLike.mkdirSync(path.dirname(finalPath), { recursive: true });
    fsLike.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2));
    fsLike.renameSync(tmpPath, finalPath);
    return true;
  } catch (_) {
    try { fsLike.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }
}

function readEditorHost(workspaceRoot, fsLike = fs) {
  try {
    return normalizeEditorHost(JSON.parse(fsLike.readFileSync(getEditorHostPath(workspaceRoot), 'utf8')));
  } catch (_) {
    return null;
  }
}

module.exports = {
  EDITOR_HOST_FILE,
  EDITOR_HOST_VERSION,
  SCHEME_CLI_NAMES,
  safeCliName,
  expandHome,
  isExecutable,
  readApplicationName,
  appRootFromExecPath,
  resolveMacCodeCli,
  getEditorHostPath,
  normalizeEditorHost,
  writeEditorHost,
  readEditorHost
};
