const esbuild = require('esbuild');

// Bundle the extension (loaded by VS Code) and the hook script
// (invoked by Claude Code from outside VS Code). Both are packaged into
// single self-contained files so lib/** can stay out of the VSIX.
Promise.all([
  esbuild.build({
    entryPoints: ['./extension.js'],
    bundle: true,
    outfile: './dist/extension.js',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    format: 'cjs',
    minify: true,
    sourcemap: true
  }),
  esbuild.build({
    entryPoints: ['./hook.js'],
    bundle: true,
    outfile: './dist/hook.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: false,   // keep readable for stack traces in Claude logs
    sourcemap: false // invoked via `node dist/hook.js`, no shebang needed
  })
]).then(() => {
  console.log('Build complete: dist/extension.js, dist/hook.js');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
