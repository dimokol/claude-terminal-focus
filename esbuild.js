const esbuild = require('esbuild');

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
  })
]).then(() => {
  console.log('Build complete: dist/extension.js, dist/hook.js, dist/hook-user-prompt.js');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
