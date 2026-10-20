// Reproducible, source-first Greek Gospel data probe. No inferred translations,
// no token alignment to Russian/KJV, no automated publishing.
// STEPBible TAGNT is an amalgamated text. This prototype keeps ONLY SBL-tagged rows;
// surface spelling stays as supplied by STEP and is not necessarily SBLGNT spelling.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQL, root } from './common.mjs';

const BOOKS = Object.freeze({ Mat: 470, Mrk: 480, Luk: 490, Jhn: 500 });
const MAX_BYTES = 24 * 1024 * 1024;
const reference = /^([A-Za-z0-9]+)\.(\d+)\.(\d+)[^\t]*?#(\d+)/;
const removeTranslit = /\s*\([^()]*\)\s*$/;
const greekLetters = /[\u0370-\u03ff\u1f00-\u1fff]/u;
// Pinned TAGNT source has 3 John 1:15 although project English canon ends at 1:14.
// Preserve this original source address; do NOT fold it into verse 14.
const EXTRA_SOURCE_VERSES = new Set(['710:1:15']);

export function parseTagntGreek(text, chapterCounts, sourceBooks = BOOKS) {
  if (typeof text !== 'string') throw new Error('TAGNT text must be UTF-8');
  const rows = [];
  const seen = new Set();
  let tagged = 0;
  let excluded = 0;
  let missingStrong = 0;
  const visited = new Set();

  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const cols = line.split('\t');
    if (cols.length < 6) continue; // headings and dataset notes
    const match = reference.exec(cols[0]);
    if (!match) continue;
    const editionFlags = cols[5].trim().split('+').map(s => s.trim());
    if (!editionFlags.includes('SBL')) {
      excluded++;
      continue;
    }
    const [ , bookCode, chapterRaw, verseRaw, positionRaw ] = match;
    const book = sourceBooks[bookCode];
    const chapter = Number(chapterRaw);
    const verse = Number(verseRaw);
    const position = Number(positionRaw);
    if (!book || !Number.isSafeInteger(chapter) || !Number.isSafeInteger(verse) ||
        !Number.isSafeInteger(position) || position <= 0 ||
        !chapterCounts[String(book)]?.[chapter - 1] ||
        verse < 1 || (verse > chapterCounts[String(book)][chapter - 1] &&
          !EXTRA_SOURCE_VERSES.has([book,chapter,verse].join(':')))) {
      throw new Error('Invalid SBL verse or token position in pinned TAGNT at ' + [bookCode,chapterRaw,verseRaw,positionRaw].join('/'));
    }
    const surface = cols[1].replace(removeTranslit, '').normalize('NFC').trim();
    if (!surface || !greekLetters.test(surface)) {
      throw new Error('SBL word without readable Greek surface');
    }
    const key = [book, chapter, verse, position].join(':');
    if (seen.has(key)) throw new Error('Duplicate SBL token position: ' + key);
    seen.add(key);
    tagged++;
    visited.add([book, chapter, verse].join(':'));
    const [strongRaw, ...morphParts] = cols[3].split('=');
    const strong = strongRaw.trim();
    if (!/^G\d{1,5}[A-Za-z]*$/.test(strong)) missingStrong++;
    // Keep the exact STEP dStrong identifier (including disambiguation suffixes).
    // Never invent a lemma/grammar mapping or assume token-to-translation alignment.
    rows.push({
      book, chapter, verse, position, surface,
      strong: strong || null,
      morphology: morphParts.length ? morphParts.join('=').trim() : null,
      lemmaGloss: cols[4].trim(),
      editions: cols[5].trim(),
      sourceRef: cols[0],
    });
  }
  return { rows, stats: { kept: tagged, excluded, missingStrong, verses: visited.size,
    books: [...new Set(rows.map(r => r.book))].sort((a, b) => a - b) } };
}

export function writeTagntDatabase(sqlModule, parsed, dataset = 'STEP Bible TAGNT Mat-Jhn SBL selection') {
  const db = new sqlModule.Database();
  try {
    db.run('CREATE TABLE info (name TEXT PRIMARY KEY, value TEXT);' +
      'CREATE TABLE tagnt_tokens (' +
      'book_number INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,' +
      'position INTEGER NOT NULL, surface TEXT NOT NULL, strong_tag TEXT,' +
      'morphology TEXT, lemma_gloss TEXT, editions TEXT NOT NULL, source_ref TEXT NOT NULL,' +
      'PRIMARY KEY (book_number,chapter,verse,position)) WITHOUT ROWID;');
    db.run('CREATE INDEX tagnt_strong_idx ON tagnt_tokens(strong_tag,book_number,chapter,verse);');
    const datasetInfo = db.prepare('INSERT INTO info VALUES (?, ?)');
    try { datasetInfo.run(['dataset', dataset]); } finally { datasetInfo.free(); }
    db.run("INSERT INTO info VALUES ('license', 'CC BY 4.0')");
    db.run("INSERT INTO info VALUES ('attribution', 'STEP Bible (stepbible.org); Tyndale House Cambridge')");
    db.run('BEGIN');
    const ins = db.prepare('INSERT INTO tagnt_tokens VALUES (?,?,?,?,?,?,?,?,?,?)');
    try {
      for (const row of parsed.rows) ins.run([
        row.book,row.chapter,row.verse,row.position,row.surface,row.strong,
        row.morphology,row.lemmaGloss,row.editions,row.sourceRef,
      ]);
    } finally { ins.free(); }
    db.run('COMMIT');
    return Buffer.from(db.export());
  } finally { db.close(); }
}

export async function fetchPinnedSource(meta) {
  // Pinned Git commit + git blob SHA: upstream edits invalidate the audit.
  const rel = meta.path.split('/').map(encodeURIComponent).join('/');
  const url = 'https://raw.githubusercontent.com/' + meta.repository + '/' + meta.revision + '/' + rel;
  const response = await fetch(url, { signal: AbortSignal.timeout(100_000),
    headers: { 'user-agent': 'bible-app-modules/step-data-audit' } });
  if (!response.ok) throw new Error('STEP Bible source HTTP ' + response.status);
  if (+response.headers.get('content-length') > MAX_BYTES) throw new Error('Oversized STEP Bible source');
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > MAX_BYTES) throw new Error('STEP Bible source exceeded download cap');
    parts.push(Buffer.from(part));
  }
  const bytes = Buffer.concat(parts);
  const objectHash = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  if (objectHash !== meta.gitBlobSha1) throw new Error('Pinned STEP Bible git blob did not match');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== meta.sha256) throw new Error('Pinned STEP Bible SHA-256 did not match');
  return { bytes, sha256 };
}

export async function auditGreekSource({ build = false, exportLocal = false } = {}) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'sources-step-greek.json'), 'utf8'));
  const { bytes, sha256 } = await fetchPinnedSource(source);
  const canon = JSON.parse(fs.readFileSync(path.join(root, 'canon/eng.json'), 'utf8'));
  const result = parseTagntGreek(bytes.toString('utf8'), canon.books);
  if (result.stats.kept < 30000 || result.stats.verses < 3500 ||
      result.stats.books.join(',') !== '470,480,490,500') {
    throw new Error('Greek Gospels unexpectedly incomplete; do not publish');
  }
  const report = { dataset: source.dataset, revision: source.revision,
    sourceSha256: sha256, ...result.stats,
    selection: 'SBL-word-presence, original STEP surfaces; NOT verified SBL spelling',
    license: source.license, attribution: source.attribution };
  if (build) {
    const SQLModule = await SQL();
    const sqlite = writeTagntDatabase(SQLModule, result);
    // Return bytes to the QA runner only. No binary is committed or released.
    const db = new SQLModule.Database(new Uint8Array(sqlite));
    try {
      const integrity = db.exec('PRAGMA quick_check')[0]?.values[0][0];
      const count = db.exec('SELECT COUNT(*) FROM tagnt_tokens')[0]?.values[0][0];
      if (integrity !== 'ok' || count !== result.rows.length) throw new Error('TAGNT SQLite validation failed');
      report.databaseBytes = sqlite.length;
      report.sqliteSha256 = crypto.createHash('sha256').update(sqlite).digest('hex');
      report.sqliteRows = count;
      if (exportLocal) {
        // Only user-initiated local export, into a gitignored folder.
        const local = path.join(root, 'work', 'step-greek-gospels.db');
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, sqlite, { flag: 'w' });
        report.localOutput = 'work/step-greek-gospels.db';
      }
    } finally { db.close(); }
  }
  // Counts and hashes only: no Greek or English texts in logs or artifacts.
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await auditGreekSource({ build: process.argv.includes('--sqlite-smoke') || process.argv.includes('--export-local'), exportLocal: process.argv.includes('--export-local') }); }
  catch (err) { console.error('STEP Greek source audit failed: ' + err.message); process.exitCode = 1; }
}
