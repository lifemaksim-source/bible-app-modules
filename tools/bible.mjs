// Bible translation: eBible.org USFM → MyBible-style SQLite (info, books, verses, stories, notes).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SQL, get, writeInfo } from './common.mjs';
import { parseBook } from './usfm.mjs';
import { books, validate } from './validate.mjs';

/**
 * @param src   entry of sources.json (type "bible")
 * @param ctx   { work: folder for downloads, base: eBible base URL }
 * @returns {{ bytes: Buffer, meta: object, summary: string, warnings: string[] }}
 */
export async function buildBible(src, { work, base }) {
  const zip = path.join(work, 'usfm.zip');
  await get(`${base}/${src.ebible}_usfm.zip`, zip);
  execFileSync('unzip', ['-q', '-o', zip, '-d', path.join(work, 'usfm')]);

  // Which file is which book: by the \id line, not by file name.
  const byBook = new Map();
  const headings = new Map();
  const notes = new Map();
  for (const f of fs.readdirSync(path.join(work, 'usfm')).filter((x) => /\.(usfm|sfm)$/i.test(x))) {
    const parsed = parseBook(fs.readFileSync(path.join(work, 'usfm', f), 'utf8'));
    const b = books.find((x) => x.usfm === parsed.id);
    if (!b) continue;
    byBook.set(b.n, parsed.verses);
    headings.set(b.n, parsed.headings);
    notes.set(b.n, parsed.notes);
  }
  const v = validate(byBook, src.numbering);
  if (v.errors.length) throw new Error(`проверка не пройдена:\n  ${v.errors.slice(0, 15).join('\n  ')}`);

  const db = new (await SQL()).Database();
  writeInfo(db, {
    description: src.name, language: src.language, origin: `eBible.org (${src.ebible})`, license: src.license,
    year: src.year, code: src.code, numbering: src.numbering, app_format: '1',
  });
  db.run(`CREATE TABLE books (book_color TEXT, book_number NUMERIC, short_name TEXT, long_name TEXT, is_present NUMERIC);
    CREATE TABLE verses (book_number NUMERIC, chapter NUMERIC, verse NUMERIC, text TEXT, PRIMARY KEY (book_number, chapter, verse));
    CREATE TABLE stories (book_number NUMERIC, chapter NUMERIC, verse NUMERIC, order_if_several NUMERIC, title TEXT);
    CREATE TABLE notes (book_number NUMERIC, chapter NUMERIC, verse NUMERIC, text TEXT);`);
  db.run('BEGIN');
  for (const b of books) {
    const vs = byBook.get(b.n);
    if (!vs) continue;
    db.run('INSERT INTO books VALUES (?, ?, ?, ?, 1)', ['', b.n, b.usfm, b.src]);
    const keys = [...vs.keys()].map((k) => k.split(':').map(Number)).sort((a, z) => a[0] - z[0] || a[1] - z[1]);
    for (const [c, vv] of keys) db.run('INSERT INTO verses VALUES (?, ?, ?, ?)', [b.n, c, vv, vs.get(`${c}:${vv}`)]);
    for (const [k, t] of headings.get(b.n)) {
      const [c, vv] = k.split(':').map(Number);
      db.run('INSERT INTO stories VALUES (?, ?, ?, 0, ?)', [b.n, c, vv, t]);
    }
    for (const [k, ns] of notes.get(b.n)) {
      const [c, vv] = k.split(':').map(Number);
      for (const t of ns) db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [b.n, c, vv, t]);
    }
  }
  db.run('COMMIT');
  db.run('CREATE INDEX IF NOT EXISTS verses_bc ON verses (book_number, chapter)');
  const bytes = Buffer.from(db.export());
  db.close();
  return {
    bytes,
    meta: { code: src.code, name: src.name, language: src.language, numbering: src.numbering, year: src.year, scope: v.scope, verses: v.verses, source: `https://ebible.org/find/details.php?id=${src.ebible}` },
    summary: `${v.verses} стихов, ${v.scope}`,
    warnings: v.warnings,
  };
}
