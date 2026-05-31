const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false
};

Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ['./extension.js'],
    outfile: './dist/extension.js',
    external: ['vscode'],
    minify: true,
    sourcemap: true
  }),
  esbuild.build({
    ...common,
    entryPoints: ['./hook.js'],
    outfile: './dist/hook.js',
    minify: false
  }),
  esbuild.build({
    ...common,
    entryPoints: ['./hook-user-prompt.js'],
    outfile: './dist/hook-user-prompt.js',
    minify: false
  }),
  esbuild.build({
    ...common,
    entryPoints: ['./bin/win-click-handler.js'],
    outfile: './dist/win-click-handler.js',
    minify: false
  }),
  esbuild.build({
    ...common,
    entryPoints: ['./bin/hook-wrapper.cjs'],
    outfile: './dist/hook-wrapper.cjs',
    minify: false
  })
]).then(() => {
  // Copy non-JS assets that ship as part of the dist bundle.
  // hide.vbs is the silent launcher used by the Windows click-handler
  // registry entry — it runs Node hidden so the click handler doesn't
  // flash a console window when the user clicks the OS toast.
  const distDir = path.join(__dirname, 'dist');
  for (const asset of ['hide.vbs']) {
    const src = path.join(__dirname, 'bin', asset);
    const dst = path.join(distDir, asset);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }
  console.log('Build complete: dist/extension.js, dist/hook.js, dist/hook-user-prompt.js, dist/win-click-handler.js, dist/hook-wrapper.cjs, dist/hide.vbs');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
