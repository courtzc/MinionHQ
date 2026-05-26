#!/usr/bin/env node
// Bundles src/web/app.ts → public/app.js with esbuild, plus copies xterm.css
// from node_modules. Static assets (HTML / CSS / images) live directly in
// public/ — tracked in git — so this script only handles generated output.
import * as esbuild from 'esbuild';
import { copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'public');

await esbuild.build({
  entryPoints: [join(root, 'src/web/app.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  minify: true,
  outfile: join(outdir, 'app.js'),
  absWorkingDir: root,
});

copyFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(outdir, 'xterm.css'));

console.log('built public/app.js + xterm.css');

console.log('built public/');
