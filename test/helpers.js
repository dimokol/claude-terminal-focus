// test/helpers.js — shared test scaffolding.
//
// Sandboxes HOME (and USERPROFILE, for Windows) into a per-run temp dir so
// tests never write into the real ~/.claude/focus-state/. Before this,
// every `npm test` run scattered hashed junk dirs into the developer's
// actual home (hundreds accumulated). lib/state-paths resolves the state
// root lazily via os.homedir(), so requiring this module before the test
// bodies run is enough — require order relative to the lib modules does
// not matter. Forked worker fixtures inherit the sandboxed env.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-test-home-'));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

const { getStateDir } = require('../lib/state-paths');
module.exports = { stateDir: getStateDir, sandboxHome };
