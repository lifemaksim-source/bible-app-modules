// Read-only audit for the remaining three pinned STEPBible TAHOT OT sources.
// The companion Gen–Deu probe is in step-hebrew.mjs (PR #15).
// The data and temporary SQLite files are never committed, released or uploaded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQL, root } from './common.mjs';
import { parseTahotLines, exportTahotSqlite, readPinnedSource, validateHebrewVerses } from './step-hebrew.mjs';

// Codes below come from the STEPBible-Data README (not inferred from AI);
// numbers are from the project's canon/books.json, 10–460.
export const BOOK_GROUPS = Object.freeze({
  'Gen-Deu': Object.freeze({ Gen: 10, Exo: 20, Lev: 30, Num: 40, Deu: 50 }),
  'Jos-Est': Object.freeze({
    Jos: 60, Jdg: 70, Rut: 80, '1Sa': 90, '2Sa': 100,
    '1Ki': 110, '2Ki': 120, '1Ch': 130, '2Ch': 140,
    Ezr: 150, Neh: 160, Est: 190,
  }),
  'Job-Sng': Object.freeze({ Job: 220, Psa: 230, Pro: 240, Ecc: 250, Sng: 260 }),
  'Isa-Mal': Object.freeze({
    Isa: 290, Jer: 300, Lam: 310, Ezk: 330, Dan: 340,
    Hos: 350, Jol: 360, Amo: 370, Oba: 380, Jon: 390,
    Mic: 400, Nam: 410, Hab: 420, Zep: 430, Hag: 440,
    Zec: 450, Mal: 460,
  }),
});

/** Fail closed on absent, extra, duplicated or miscoded source books. */
export function validateBookGroups(groups, canonBooks) {
  const expected = new Set(canonBooks.filter(b => b.n < 470).map(b => b.n));
  const encountered = new Set();
  for (const [range, entries] of Object.entries(groups)) {
    if (!Object.keys(entries).length) throw new Error('Empty TAHOT book group: ' + range);
    for (const n of Object.values(entries)) {
      if (!expected.has(n) || encountered.has(n)) throw new Error('Unknown/duplicated TAHOT book number: ' + n);
      encountered.add(n);
    }
  }
  if (encountered.size !== expected.size) throw new Error('TAHOT book groups missing canonical Old Testament books');
  return encountered.size;
}

/** Exact chapter *identities*, not merely the number of different chapters. */
export function validateSourceCoverage(parsed, sourceBooks, expectedChapters, range) {
  const expected = Object.values(sourceBooks).sort((a, b) => a - b);
  if (parsed.stats.books.join(',') !== expected.join(',')) {
    throw new Error('TAHOT ' + range + ': source contains missing or unexpected books');
  }
  if (!parsed.rows.length || parsed.stats.malformed || parsed.stats.verses < expected.length) {
    throw new Error('TAHOT ' + range + ': absent or malformed source rows (rows=' + parsed.stats.rows + ', malformed=' + parsed.stats.malformed + ', verses=' + parsed.stats.verses + ', refs=' + JSON.stringify(parsed.stats.malformedSamples) + ')');
  }
  if (Object.keys(parsed.stats.columnWidths).some(n => n !== '17')) {
    throw new Error('TAHOT ' + range + ': unexpected TSV field count (expected 17 columns)');
  }
  // Check *every* chapter is represented by at least one source row. Do not
  // assume KJV and Hebrew verse counts match: they do not in many places.
  const observed = new Map();
  for (const row of parsed.rows) {
    let chapters = observed.get(row.book);
    if (!chapters) { chapters = new Set(); observed.set(row.book, chapters); }
    chapters.add(row.chapter);
  }
  for (const n of expected) {
    const total = expectedChapters[String(n)]?.length;
    if (!total) throw new Error('Missing local canonical book ' + n);
    const have = observed.get(n) || new Set();
    for (let chapter = 1; chapter <= total; chapter++) {
      if (!have.has(chapter)) throw new Error('TAHOT ' + range + ': book ' + n + ' missing chapter ' + chapter);
    }
    if (have.size !== total) throw new Error('TAHOT ' + range + ': unexpected chapter count in book ' + n);
  }
  return { books: expected.length, chapters: [...observed.values()].reduce((n, ch) => n + ch.size, 0) };
}

export async function auditRemainingHebrew({ sqliteSmoke = false, exportLocal = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sources-step-hebrew.json'), 'utf8'));
  const canonBooks = JSON.parse(fs.readFileSync(path.join(root, 'canon/books.json'), 'utf8'));
  const chapterCounts = JSON.parse(fs.readFileSync(path.join(root, 'canon/eng.json'), 'utf8')).books;
  validateBookGroups(BOOK_GROUPS, canonBooks);
  const expectedRanges = ['Jos-Est', 'Job-Sng', 'Isa-Mal'];
  if (manifest.files.length !== 4 || new Set(manifest.files.map(f => f.range)).size !== 4 ||
      expectedRanges.some(r => !manifest.files.some(f => f.range === r))) {
    throw new Error('TAHOT pinned four-file manifest is incomplete');
  }
  const results = [];
  for (const range of expectedRanges) {
    const entry = manifest.files.find(f => f.range === range);
    const { bytes, sha256 } = await readPinnedSource(manifest, entry);
    const parsed = parseTahotLines(new TextDecoder('utf-8', { fatal: true }).decode(bytes), BOOK_GROUPS[range]);
    const coverage = validateSourceCoverage(parsed, BOOK_GROUPS[range], chapterCounts, range);
    const verseCoverage = validateHebrewVerses(parsed, chapterCounts, BOOK_GROUPS[range], range);
    const report = {
      range, sha256, bytes: bytes.length,
      ...parsed.stats, coverage, verseCoverage,
      method: 'Exact source-row retention; no inferred word alignment or verse remapping',
    };
    if (sqliteSmoke || exportLocal) {
      const sql = await SQL();
      const buffer = exportTahotSqlite(sql, parsed, {
        dataset: manifest.dataset, range, revision: manifest.revision, sha256,
        license: manifest.license, attribution: manifest.attribution,
      });
      const db = new sql.Database(new Uint8Array(buffer));
      try {
        const integrity = db.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0];
        const rows = db.exec('SELECT COUNT(*) FROM tahot_rows')[0]?.values?.[0]?.[0];
        if (integrity !== 'ok' || rows !== parsed.rows.length) {
          throw new Error('TAHOT ' + range + ': SQLite validation mismatch');
        }
        report.sqliteRows = rows;
        report.databaseBytes = buffer.length;
        report.sqliteSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        if (exportLocal) {
          const local = path.join(root, 'work', 'step-hebrew-' + range.toLowerCase() + '.db');
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, buffer);
          report.localOutput = 'work/step-hebrew-' + range.toLowerCase() + '.db';
        }
      } finally { db.close(); }
    }
    // Do not print any Hebrew/Aramaic words, variant readings, glosses or records.
    console.log(JSON.stringify(report));
    results.push(report);
  }
  const total = {
    auditedFiles: results.length,
    books: results.reduce((s, x) => s + x.coverage.books, 0),
    chapters: results.reduce((s, x) => s + x.coverage.chapters, 0),
    rows: results.reduce((s, x) => s + x.rows, 0),
    verses: results.reduce((s, x) => s + x.verses, 0),
    canonicalVerses: results.reduce((s, x) => s + x.verseCoverage.canonicalVerses, 0),
    psalmSuperscriptionAddresses: results.reduce((s, x) => s + x.verseCoverage.psalmSuperscriptionAddresses, 0),
    provenance: 'STEP Bible / Tyndale House Cambridge, CC BY 4.0',
  };
  console.log(JSON.stringify({ totals: total }));
  return { results, total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await auditRemainingHebrew({ sqliteSmoke: process.argv.includes('--sqlite-smoke'), exportLocal: process.argv.includes('--export-local') }); }
  catch (error) {
    console.error('Remaining TAHOT QA failed: ' + error.message);
    process.exitCode = 1;
  }
}
