// Cross references (parallel passages): OpenBible.info TSV → SQLite.
//
// Source rows: "Gen.1.1 <tab> Prov.8.22-Prov.8.30 <tab> 59" — verses in English (KJV) numbering;
// votes are how many people found the link helpful (≤ 0 — rejected, dropped here).
// Table: cross_references (from_id, to_id, to_end, votes); places are numbers book*1000000 + chapter*1000 + verse,
// book numbers as in MyBible (Genesis = 10). The app converts verse numbers to the reader's translation.
import fs from 'node:fs';
import path from 'node:path';

import { SQL, getPinned, writeInfo } from './common.mjs';
import { books, canon } from './validate.mjs';

const byOsis = new Map(books.map((b) => [b.osis, b.n]));

/** "Prov.8.22" → { book: 240, chapter: 8, verse: 22 } or null for an unknown book. */
export function parseOsis(ref) {
  const m = ref.match(/^(\w+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const book = byOsis.get(m[1]);
  return book ? { book, chapter: +m[2], verse: +m[3] } : null;
}

/** Parses the whole file. Returns rows and a count of what was dropped and why. */
export function parseCrossrefs(text) {
  const rows = [];
  const dropped = { votes: 0, unknown: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('From Verse')) continue;
    const [fromRef, toRef, votesText] = line.split('\t');
    const votes = Number(votesText);
    if (!(votes > 0)) {
      dropped.votes++;
      continue;
    }
    const from = parseOsis(fromRef);
    const [startRef, endRef] = (toRef ?? '').split('-');
    const start = parseOsis(startRef ?? '');
    const end = endRef ? parseOsis(endRef) : null;
    if (!from || !start || (endRef && !end)) {
      dropped.unknown++;
      continue;
    }
    // A range into another book (18 rows) is kept as its first verse.
    const sameBook = end && end.book === start.book;
    rows.push([from.book, from.chapter, from.verse, start.book, start.chapter, start.verse, sameBook ? end.chapter : start.chapter, sameBook ? end.verse : start.verse, votes]);
  }
  return { rows, dropped };
}

/** Every verse must exist in English numbering; returns problems found. */
export function checkCrossrefs(rows) {
  const ref = canon('eng');
  const bad = [];
  const ok = (b, c, v) => (ref[b]?.[c - 1] ?? 0) >= v && v >= 1;
  for (const r of rows) {
    if (!ok(r[0], r[1], r[2])) bad.push(`нет стиха ${r[0]} ${r[1]}:${r[2]}`);
    else if (!ok(r[3], r[4], r[5])) bad.push(`нет стиха ${r[3]} ${r[4]}:${r[5]}`);
    if (bad.length > 20) break;
  }
  return bad;
}

export async function buildCrossrefs(src, { work }) {
  const file = path.join(work, 'crossrefs.txt');
  await getPinned(src.url, src.sha256, file);
  const { rows, dropped } = parseCrossrefs(fs.readFileSync(file, 'utf8'));
  if (rows.length < 300000) throw new Error(`слишком мало ссылок: ${rows.length}`);
  const bad = checkCrossrefs(rows);
  if (bad.length > 10) throw new Error(`ссылки на несуществующие стихи:\n  ${bad.slice(0, 10).join('\n  ')}`);

  const db = new (await SQL()).Database();
  writeInfo(db, {
    description: src.name, language: src.language, origin: src.origin, license: src.license,
    attribution: src.attribution, numbering: src.numbering, code: src.code, app_format: '1', type: 'crossrefs',
  });
  // Compact: a place is one number book*1000000 + chapter*1000 + verse (Gen 1:1 = 10001001);
  // to_end = 0 for a single verse. Clustered by the verse a link starts from — no separate index needed.
  db.run(`CREATE TABLE cross_references (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, to_end INTEGER NOT NULL, votes INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, to_end)) WITHOUT ROWID`);
  // Sorted (most votes first), so the file is the same from run to run and a repeated link keeps its best vote.
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || b[8] - a[8] || a[3] - b[3] || a[4] - b[4] || a[5] - b[5]);
  db.run('BEGIN');
  const id = (b, c, v) => b * 1000000 + c * 1000 + v;
  const seen = new Set();
  const ins = db.prepare('INSERT INTO cross_references VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    const from = id(r[0], r[1], r[2]);
    const to = id(r[3], r[4], r[5]);
    const end = r[6] === r[4] && r[7] === r[5] ? 0 : id(r[3], r[6], r[7]);
    const key = `${from}/${to}/${end}`;
    if (seen.has(key)) continue; // the same link twice: keep the one with more votes
    seen.add(key);
    ins.run([from, to, end, r[8]]);
  }
  ins.free();
  db.run('COMMIT');
  db.run('VACUUM');
  const bytes = Buffer.from(db.export());
  db.close();
  return {
    bytes,
    meta: { code: src.code, name: src.name, language: src.language, numbering: src.numbering, year: src.year ?? '', links: seen.size, source: src.homepage },
    summary: `${seen.size} ссылок (отброшено: ${dropped.votes} с голосами ≤ 0, ${dropped.unknown} нераспознанных)`,
    warnings: bad,
  };
}
