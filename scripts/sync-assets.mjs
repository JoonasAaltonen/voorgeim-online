// Copies visual assets from the Figma exports folder (source of truth) into
// public/assets, normalizing spaced filenames to lowercase kebab-case so they
// can be referenced by a predictable convention (e.g. coin-anti-tank-p1.png).
// Re-run after updating the Figma exports:  npm run sync-assets
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../Figma exports');
const DST = resolve(here, '../public/assets');
const KEEP = new Set(['.png', '.svg']);

const norm = (f) => f.toLowerCase().replace(/\s+/g, '-');

mkdirSync(DST, { recursive: true });
let n = 0;
for (const f of readdirSync(SRC)) {
  if (!KEEP.has(extname(f).toLowerCase())) continue;
  copyFileSync(resolve(SRC, f), resolve(DST, norm(f)));
  n++;
}
console.log(`sync-assets: copied ${n} files -> public/assets`);
