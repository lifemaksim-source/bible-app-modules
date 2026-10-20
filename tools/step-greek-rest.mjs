/**
 * Audited STEP Bible TAGNT for the remaining 23 NT books, Acts–Revelation.
 * Reuses the Gospel TAGNT parser and SQLite writer; no text, morphology,
 * lexical data, or verse alignment is generated.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQL, root } from './common.mjs';
import { fetchPinnedSource, parseTagntGreek, writeTagntDatabase } from './step-greek.mjs';

// Source's official UBS-style labels, documented in STEPBible-Data README.
export const REST_NT_BOOKS = Object.freeze({
  Act: 510, Rom: 520, '1Co': 530, '2Co': 540,
  Gal: 550, Eph: 560, Php: 570, Col: 580,
  '1Th': 590, '2Th': 600, '1Ti': 610, '2Ti': 620,
  Tit: 630, Phm: 640, Heb: 650, Jas: 660,
  '1Pe': 670, '2Pe': 680, '1Jn': 690, '2Jn': 700,
  '3Jn': 710, Jud: 720, Rev: 730,
});

/**
 * Compare against the project's existing canonical addresses.
 * SBL selection may omit traditional verses. Record omissions explicitly,
 * never fill them from TR, KJV, or any model.
 */
export function auditGreekVerseCoverage(parsed, chapterCounts, sourceBooks = REST_NT_BOOKS) {
  const books = Object.values(sourceBooks).sort((a, b) => a - b);
  if (!books.length || new Set(books).size !== books.length) {
    throw new Error('Duplicate/missing source book codes');
  }
  const parsedBooks = parsed.stats.books;
  if (parsedBooks.join(',') !== books.join(',')) {
    throw new Error('TAGNT missing or unexpected books');
  }
  const observed = new Set(parsed.rows.map(r => [r.book, r.chapter, r.verse].join(':')));
  const missingSourceVerses = [];
  const canonicalAddressSet = new Set();
  let canonicalVerses = 0;
  let chapters = 0;
  for (const book of books) {
    const counts = chapterCounts[String(book)];
    if (!Array.isArray(counts) || !counts.length) throw new Error('Missing canonical book: ' + book);
    for (let chapter = 1; chapter <= counts.length; chapter++) {
      chapters++;
      let chapterWords = 0;
      for (let verse = 1; verse <= counts[chapter - 1]; verse++) {
        canonicalVerses++;
        const key = [book, chapter, verse].join(':');
        canonicalAddressSet.add(key);
        if (observed.has(key)) chapterWords++;
        else missingSourceVerses.push(key);
      }
      if (!chapterWords) throw new Error('Missing full source chapter: ' + book + ':' + chapter);
    }
  }
  // TAGNT may have an edition-specific extra source verse (e.g. 3 John 1:15).
  // Keep its exact address; do not silently shift it to the KJV chapter count.
  const extraSourceVerses = [...observed].filter(key => !canonicalAddressSet.has(key)).sort();
  if (extraSourceVerses.some(key => !new Set(['710:1:15','730:12:18']).has(key))) {
    throw new Error('Unexpected noncanonical TAGNT source verse: ' + extraSourceVerses.join(','));
  }
  if (parsed.stats.verses !== canonicalVerses - missingSourceVerses.length + extraSourceVerses.length) {
    throw new Error('TAGNT source reference count differs from canonical plus explicitly retained variants');
  }
  return { books: books.length, chapters, canonicalVerses,
    annotatedVerses: parsed.stats.verses, missingSourceVerses, extraSourceVerses };
}

export async function auditGreekRest({ sqliteSmoke = false, exportLocal = false } = {}) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'sources-step-greek-rest.json'), 'utf8'));
  const canon = JSON.parse(fs.readFileSync(path.join(root, 'canon/eng.json'), 'utf8')).books;
  const expectedBooks = Object.keys(canon).map(Number).filter(n => n >= 510 && n <= 730);
  if (expectedBooks.length !== 23 ||
      expectedBooks.some(n => !Object.values(REST_NT_BOOKS).includes(n))) {
    throw new Error('TAGNT book selection does not cover all remaining NT books');
  }
  const { bytes, sha256 } = await fetchPinnedSource(source);
  if (bytes.length !== source.bytes) throw new Error('TAGNT pinned source size differs');
  const parsed = parseTagntGreek(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    canon, REST_NT_BOOKS);
  const coverage = auditGreekVerseCoverage(parsed, canon);
  if (parsed.stats.kept < 40000 || coverage.annotatedVerses < 3000) {
    throw new Error('TAGNT Acts–Revelation unexpectedly incomplete');
  }
  const result = {
    dataset: source.dataset, sourceSha256: sha256, sourceBytes: bytes.length,
    revision: source.revision, license: source.license, attribution: source.attribution,
    ...parsed.stats, coverage,
    caveat: 'SBL-tagged TAGNT word selection only. Missing source verses are NOT inferred.',
  };
  if (sqliteSmoke || exportLocal) {
    const sql = await SQL();
    const database = writeTagntDatabase(sql, parsed, source.dataset);
    const db = new sql.Database(new Uint8Array(database));
    try {
      const integrity = db.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0];
      const rowCount = db.exec('SELECT COUNT(*) FROM tagnt_tokens')[0]?.values?.[0]?.[0];
      if (integrity !== 'ok' || rowCount !== parsed.rows.length) {
        throw new Error('Acts–Revelation SQLite integrity/count failure');
      }
      result.sqliteRows = rowCount;
      result.sqliteBytes = database.length;
      result.sqliteSha256 = crypto.createHash('sha256').update(database).digest('hex');
      if (exportLocal) {
        const out = path.join(root, 'work', 'step-greek-acts-revelation.db');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, database);
        result.localOutput = 'work/step-greek-acts-revelation.db';
      }
    } finally { db.close(); }
  }
  // No words, translation text or edition readings in source CI logs.
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await auditGreekRest({ sqliteSmoke: process.argv.includes('--sqlite-smoke'),
    exportLocal: process.argv.includes('--export-local') }); }
  catch (error) {
    console.error('STEP TAGNT Acts–Revelation audit failed: ' + error.message);
    process.exitCode = 1;
  }
}
