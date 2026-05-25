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
copyFileSync(join(root, 'src/web/chimes.html'), join(outdir, 'chimes.html'));
copyFileSync(join(root, 'src/web/styles.css'), join(outdir, 'styles.css'));
copyFileSync(join(root, 'src/web/favicon.svg'), join(outdir, 'favicon.svg'));
copyFileSync(join(root, 'src/web/minion.jpg'), join(outdir, 'minion.jpg'));
copyFileSync(join(root, 'src/web/minion-loader.svg'), join(outdir, 'minion-loader.svg'));

// Numbered minion badges (m1.svg…m12.svg). Tabs reference these via CSS.
mkdirSync(join(outdir, 'minions'), { recursive: true });
for (let n = 1; n <= 12; n++) {
  copyFileSync(join(root, `src/web/minions/m${n}.svg`), join(outdir, `minions/m${n}.svg`));
}

console.log('built public/');
