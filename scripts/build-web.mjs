#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'public');
mkdirSync(outdir, { recursive: true });

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

copyFileSync(join(root, 'src/web/index.html'), join(outdir, 'index.html'));
copyFileSync(join(root, 'src/web/styles.css'), join(outdir, 'styles.css'));

console.log('built public/');
