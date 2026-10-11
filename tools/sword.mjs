// SWORD decoding belongs to pysword (MIT), pinned in requirements-sword.txt.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPinned, root } from './common.mjs';
import { books } from './validate.mjs';
import { buildBibleData } from './bible.mjs';

export async function buildSword(src, { work }) {
  const zip = path.join(work, 'sword.zip');
  await getPinned(src.url, src.sha256, zip);
  const decoded = path.join(work, 'sword.json');
  execFileSync('python3', [path.join(root, 'tools/sword-export.py'), zip, src.sword, decoded], { stdio: 'inherit' });
  const full = JSON.parse(fs.readFileSync(path.join(root, `canon/abbr/${src.language}-long.json`), 'utf8'));
  const abbr = JSON.parse(fs.readFileSync(path.join(root, `canon/abbr/${src.language}.json`), 'utf8'));
  const byBook = new Map(), headings = new Map(), notes = new Map(), names = new Map();
  for (const source of JSON.parse(fs.readFileSync(decoded, 'utf8'))) {
    const b = books.find((b) => b.osis.toLowerCase() === source.osis.toLowerCase());
    if (!b) throw new Error(`Unknown SWORD book ${source.osis}`);
    byBook.set(b.n, new Map(source.verses.map(([c, v, text]) => [`${c}:${v}`, text])));
    headings.set(b.n, new Map()); notes.set(b.n, new Map());
    names.set(b.n, { toc2: full[b.usfm], toc3: abbr[b.usfm] });
  }
  return buildBibleData(src, { byBook, headings, notes, names }, work);
}
