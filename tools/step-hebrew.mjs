// Read-only, pinned STEPBible TAHOT audit: first five books of the Hebrew OT.
// Raw TAHOT word rows may represent morphemes + Ketiv/Qere alternatives.
// Keep ALL source fields, including uncertain alternatives, unmodified.
// No Hebrew text, translations, or generated SQLite are committed or published.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQL, root } from './common.mjs';

export const FIRST_BOOKS = Object.freeze({ Gen: 10, Exo: 20, Lev: 30, Num: 40, Deu: 50 });
const MAX_BYTES = 27 * 1024 * 1024;
const HEBREW = /[\u0590-\u05ff]/u;
const ANCHORED_REFERENCE = /^([A-Z][a-z]{2})\.(\d+)\.(\d+)(?:\([^)]*\))?#(\d+)(?:=([^\t]*))?$/;

/** Preserve exact source indicators; do not guess which Ketiv/Qere variant is primary. */
export function parseTahotLines(text, expectedBooks = FIRST_BOOKS) {
  if (typeof text !== 'string' || !text.replace(/^\uFEFF/, '').startsWith('TAHOT')) {
    throw new Error('Not a TAHOT dataset');
  }
  const rows = [];
  const chapters = new Map();
  const seenBooks = new Set();
  const verseKeys = new Set();
  const histogram = {};
  let malformed = 0;
  let meaningVariants = 0;
  let spellingVariants = 0;
  let ketivRefs = 0;
  let qereRefs = 0;
  let aramaicGrammar = 0;

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const cols = lines[lineNo].split('\t');
    const rawRef = cols[0] ?? '';
    const m = ANCHORED_REFERENCE.exec(rawRef);
    if (!m) {
      if (/^[A-Z][a-z]{2}\.\d+\.\d+/.test(rawRef) && rawRef.includes('#')) malformed++;
      continue; // headers, commentaries and non-record content
    }
    const book = expectedBooks[m[1]];
    const chapter = Number(m[2]), verse = Number(m[3]), position = Number(m[4]);
    if (!book || !Number.isSafeInteger(chapter) || chapter < 1 || chapter > 180 ||
        !Number.isSafeInteger(verse) || verse < 1 || verse > 200 ||
        !Number.isSafeInteger(position) || position < 1 || position > 400) {
      throw new Error('TAHOT reference outside first-five-books scope at line ' + (lineNo + 1) + ': ' + [m[1],chapter,verse,position].join('/'));
    }
    if (cols.length < 6 || !HEBREW.test(cols[1] ?? '')) {
      malformed++;
      continue;
    }
    // Full original TAHOT reference contains edition and source indicators
    // (including Ketiv "K" and Qere "Q"). Do not strip or reinterpret them.
    const flags = m[5] ?? '';
    if (/(^|[^a-z])K/.test(flags)) ketivRefs++;
    if (/(^|[^a-z])Q/.test(flags)) qereRefs++;
    const meaning = cols[6] ?? '', spelling = cols[7] ?? '';
    if (meaning.trim()) meaningVariants++;
    if (spelling.trim()) spellingVariants++;
    if ((cols[5] ?? '').startsWith('A')) aramaicGrammar++;
    histogram[cols.length] = (histogram[cols.length] || 0) + 1;
    rows.push({
      book, chapter, verse, position,
      source_ref: rawRef,
      surface: cols[1], transliteration: cols[2] ?? '',
      translation: cols[3] ?? '', strong_tags: cols[4] ?? '',
      morphology: cols[5] ?? '',
      meaning_variants: meaning, spelling_variants: spelling,
      extra_columns: JSON.stringify(cols.slice(8)),
    });
    seenBooks.add(book);
    verseKeys.add(book + ':' + chapter + ':' + verse);
    if (!chapters.has(book)) chapters.set(book, new Set());
    chapters.get(book).add(chapter);
  }
  return {
    rows,
    stats: {
      rows: rows.length, malformed, meaningVariants, spellingVariants,
      ketivRefs, qereRefs, aramaicGrammar,
      columnWidths: histogram, verses: verseKeys.size,
      chapters: Object.fromEntries([...chapters].sort(([a], [b]) => a - b)
        .map(([book, ch]) => [book, ch.size])),
      books: [...seenBooks].sort((a, b) => a - b),
    },
  };
}

/** Strictly preserves raw alternative readings instead of guessing their morphology. */
export function exportTahotSqlite(sql, parsed, sourceMetadata) {
  const db = new sql.Database();
  try {
    db.run('CREATE TABLE info (name TEXT PRIMARY KEY, value TEXT);' +
      'CREATE TABLE tahot_rows (' +
      'row_id INTEGER PRIMARY KEY, book_number INTEGER NOT NULL, chapter INTEGER NOT NULL,' +
      'verse INTEGER NOT NULL, position INTEGER NOT NULL, source_ref TEXT NOT NULL,' +
      'surface TEXT NOT NULL, transliteration TEXT NOT NULL, translation TEXT NOT NULL,' +
      'strong_tags TEXT NOT NULL, morphology TEXT NOT NULL,' +
      'meaning_variants TEXT NOT NULL, spelling_variants TEXT NOT NULL, extra_columns TEXT NOT NULL);' +
      'CREATE INDEX tahot_verse_idx ON tahot_rows(book_number,chapter,verse,position);');
    const info = db.prepare('INSERT INTO info VALUES (?,?)');
    try {
      for (const [name,value] of Object.entries(sourceMetadata)) info.run([name,String(value)]);
    } finally { info.free(); }
    db.run('BEGIN');
    const stmt = db.prepare('INSERT INTO tahot_rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    try {
      for (let i = 0; i < parsed.rows.length; i++) {
        const r = parsed.rows[i];
        stmt.run([i + 1,r.book,r.chapter,r.verse,r.position,r.source_ref,
          r.surface,r.transliteration,r.translation,r.strong_tags,r.morphology,
          r.meaning_variants,r.spelling_variants,r.extra_columns]);
      }
    } finally { stmt.free(); }
    db.run('COMMIT');
    return Buffer.from(db.export());
  } finally { db.close(); }
}

async function readPinnedSource(meta, file) {
  const rel = [meta.directory, file.name].map(encodeURIComponent).join('/');
  const url = 'https://raw.githubusercontent.com/' + meta.repository + '/' + meta.revision + '/' + rel;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(115_000),
    headers: { 'user-agent': 'bible-app-modules/step-hebrew-audit' },
  });
  if (!response.ok) throw new Error('TAHOT source HTTP ' + response.status);
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('TAHOT archive too large');
  const parts = []; let total = 0;
  for await (const part of response.body) {
    total += part.length;
    if (total > MAX_BYTES) throw new Error('TAHOT source exceeded download bound');
    parts.push(Buffer.from(part));
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== file.bytes) throw new Error('TAHOT source size differs from pinned manifest');
  const gitBlob = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  if (gitBlob !== file.gitBlobSha1) throw new Error('TAHOT source Git blob SHA mismatch');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (file.sha256 && sha256 !== file.sha256) throw new Error('TAHOT source SHA-256 mismatch');
  return { bytes, sha256 };
}

export async function auditHebrewSource({ sqliteSmoke = false } = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'sources-step-hebrew.json'), 'utf8'));
  const first = meta.files.find(f => f.audit);
  if (!first || first.range !== 'Gen-Deu') throw new Error('TAHOT audit scope unexpectedly changed');
  const { bytes, sha256 } = await readPinnedSource(meta, first);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = parseTahotLines(content);
  const { stats } = parsed;
  if (stats.rows < 50000 || stats.verses < 4000 || stats.malformed ||
      stats.books.join(',') !== '10,20,30,40,50') {
    throw new Error('Unexpected TAHOT first-five-books coverage or invalid row metadata');
  }
  const report = {
    source: 'STEP Bible TAHOT Gen-Deu', revision: meta.revision, sha256,
    ...stats,
    caveat: 'Row-level source retention, not established morphological word alignment',
    license: meta.license, attribution: meta.attribution,
  };
  if (sqliteSmoke) {
    const SQLModule = await SQL();
    const buffer = exportTahotSqlite(SQLModule, parsed, {
      dataset: meta.dataset, revision: meta.revision, sha256,
      license: meta.license, attribution: meta.attribution,
    });
    const db = new SQLModule.Database(new Uint8Array(buffer));
    try {
      const checked = db.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0];
      const actual = db.exec('SELECT COUNT(*) FROM tahot_rows')[0]?.values?.[0]?.[0];
      if (checked !== 'ok' || actual !== stats.rows) throw new Error('TAHOT SQLite corruption or missing rows');
      report.sqliteRows = actual;
      report.databaseBytes = buffer.length;
    } finally { db.close(); }
  }
  // No scripture text, morphology records or variant readings in runner logs.
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await auditHebrewSource({ sqliteSmoke: process.argv.includes('--sqlite-smoke') }); }
  catch (err) { console.error('STEP Hebrew audit failed: ' + err.message); process.exitCode = 1; }
}
