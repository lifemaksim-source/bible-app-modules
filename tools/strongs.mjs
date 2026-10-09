// «Слова оригинала»: KJV words with Strong's numbers (eBible.org eng-kjv2006, Public Domain) and Strong's dictionaries:
// Hebrew — Open Scriptures Hebrew Lexicon (CC BY 4.0), Greek — Strong's Greek Dictionary (Public Domain, Open Scriptures XML).
//
// Tables: words (verse_id = book*1000000 + chapter*1000 + verse → «phrase<TAB>H7225 H853» lines, KJV order),
//         lexicon (topic «H7225» / «G26», lemma, translit, pronunciation, gloss, definition, derivation, kjv).
// Verses in English (KJV) numbering.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SQL, get, getPinned } from './common.mjs';
import { books } from './validate.mjs';

/** «H0512» → «H512», «G26» → «G26». */
export const topic = (s) => s.replace(/^([HG])0*(\d+)[a-z]?$/i, (_, l, n) => `${l.toUpperCase()}${n}`);

/** One USFM book → Map verse_id → [[phrase, "H7225 H853"], …]. */
export function wordsOfBook(usfm, bookNumber) {
  const out = new Map();
  let ch = 0;
  let vs = 0;
  let buf = '';
  const flush = () => {
    if (!ch || !vs || !buf) return;
    const text = buf.replace(/\\f\s[\s\S]*?\\f\*/g, '').replace(/\\x\s[\s\S]*?\\x\*/g, '');
    const list = [];
    for (const m of text.matchAll(/\\\+?w\s+([^|\\]+?)\|[^\\]*?strong="([^"]+)"[^\\]*?\\\+?w\*/g)) {
      const nums = m[2].split(/[\s,]+/).filter(Boolean).map(topic).join(' ');
      if (nums) list.push([m[1].trim(), nums]);
    }
    if (list.length) out.set(bookNumber * 1000000 + ch * 1000 + vs, list);
  };
  for (const line of usfm.split(/\r?\n/)) {
    const c = line.match(/^\\c\s+(\d+)/);
    if (c) {
      flush();
      buf = '';
      ch = +c[1];
      vs = 0;
      continue;
    }
    const parts = line.split(/\\v\s+(\d+)\S*\s*/);
    // parts: [before first \v, verse, text, verse, text…]
    buf += ' ' + parts[0];
    for (let i = 1; i < parts.length; i += 2) {
      flush();
      vs = +parts[i];
      buf = parts[i + 1] ?? '';
    }
  }
  flush();
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const text = (xml) =>
  (xml ?? '')
    .replace(/<w [^>]*src="([HG]?)(\d+)"[^>]*>[^<]*<\/w>/g, (_, l, n) => `${l || 'H'}${n}`)
    .replace(/<strongsref [^>]*language="(\w+)"[^>]*strongs="0*(\d+)"[^>]*\/>/g, (_, lang, n) => `${lang === 'GREEK' ? 'G' : 'H'}${n}`)
    .replace(/<greek [^>]*unicode="([^"]*)"[^>]*\/>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(\w+);/g, (m, e) => ENT[e] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

/** Open Scriptures HebrewStrong.xml → rows. */
export function parseHebrew(xml) {
  const rows = [];
  for (const m of xml.matchAll(/<entry id="(H\d+)">([\s\S]*?)<\/entry>/g)) {
    const e = m[2];
    const w = e.match(/<w ([^>]*)>([^<]*)<\/w>/);
    const attr = (k) => w?.[1].match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? '';
    const meaning = e.match(/<meaning>([\s\S]*?)<\/meaning>/)?.[1];
    const firstDef = meaning?.match(/<def>([^<]*)<\/def>/)?.[1];
    rows.push({
      topic: m[1], lemma: w?.[2] ?? '', translit: attr('xlit'), pronunciation: attr('pron'),
      gloss: firstDef ?? text(e.match(/<usage>([\s\S]*?)<\/usage>/)?.[1]).split(/[,;.]/)[0],
      definition: text(meaning), derivation: text(e.match(/<source>([\s\S]*?)<\/source>/)?.[1]), kjv: text(e.match(/<usage>([\s\S]*?)<\/usage>/)?.[1]),
    });
  }
  return rows;
}

/** Strong's Greek dictionary XML → rows. */
export function parseGreek(xml) {
  const rows = [];
  for (const m of xml.matchAll(/<entry strongs="0*(\d+)">([\s\S]*?)<\/entry>/g)) {
    const e = m[2];
    const g = e.match(/<greek [^>]*unicode="([^"]*)"[^>]*translit="([^"]*)"/);
    const def = text(e.match(/<strongs_def>([\s\S]*?)<\/strongs_def>/)?.[1]);
    rows.push({
      topic: `G${m[1]}`, lemma: g?.[1] ?? '', translit: g?.[2] ?? '', pronunciation: e.match(/<pronunciation strongs="([^"]*)"/)?.[1] ?? '',
      gloss: def.split(/[;,]|\bi\.e\./)[0].trim(), definition: def,
      derivation: text(e.match(/<strongs_derivation>([\s\S]*?)<\/strongs_derivation>/)?.[1]),
      kjv: text(e.match(/<kjv_def>([\s\S]*?)<\/kjv_def>/)?.[1]).replace(/^:--\s*/, ''),
    });
  }
  return rows;
}

export async function buildStrongs(src, { work, base }) {
  // KJV with Strong's numbers
  const zip = path.join(work, 'kjv.zip');
  await get(`${base}/${src.ebible}_usfm.zip`, zip);
  execFileSync('unzip', ['-q', '-o', zip, '-d', path.join(work, 'usfm')]);
  const verses = new Map();
  for (const f of fs.readdirSync(path.join(work, 'usfm')).filter((x) => /\.usfm$/i.test(x))) {
    const usfm = fs.readFileSync(path.join(work, 'usfm', f), 'utf8');
    const id = usfm.match(/^\\id\s+(\S+)/m)?.[1]?.toUpperCase();
    const b = books.find((x) => x.usfm === id);
    if (b) for (const [k, v] of wordsOfBook(usfm, b.n)) verses.set(k, v);
  }
  if (verses.size < 30000) throw new Error(`слов с номерами Стронга только в ${verses.size} стихах`);

  // Dictionaries
  const heb = path.join(work, 'heb.xml');
  const grk = path.join(work, 'grk.xml');
  await getPinned(src.hebrew.url, src.hebrew.sha256, heb);
  await getPinned(src.greek.url, src.greek.sha256, grk);
  const lexicon = [...parseHebrew(fs.readFileSync(heb, 'utf8')), ...parseGreek(fs.readFileSync(grk, 'utf8'))];
  if (lexicon.length < 14000) throw new Error(`в словарях только ${lexicon.length} статей`);
  const known = new Set(lexicon.map((r) => r.topic));
  const missing = new Set();
  for (const list of verses.values()) for (const [, nums] of list) for (const n of nums.split(' ')) if (!known.has(n)) missing.add(n);

  const db = new (await SQL()).Database();
  db.run(`CREATE TABLE info (name TEXT, value TEXT);
    CREATE TABLE words (verse_id INTEGER PRIMARY KEY, words TEXT NOT NULL);
    CREATE TABLE lexicon (topic TEXT PRIMARY KEY, lemma TEXT, translit TEXT, pronunciation TEXT, gloss TEXT, definition TEXT, derivation TEXT, kjv TEXT) WITHOUT ROWID;`);
  const info = {
    description: src.name, language: src.language, origin: src.origin, license: src.license, attribution: src.attribution,
    code: src.code, numbering: src.numbering, type: 'strongs', app_format: '1',
  };
  for (const [k, v] of Object.entries(info)) if (v) db.run('INSERT INTO info VALUES (?, ?)', [k, v]);
  db.run('BEGIN');
  const insW = db.prepare('INSERT INTO words VALUES (?, ?)');
  for (const k of [...verses.keys()].sort((a, b) => a - b)) insW.run([k, verses.get(k).map(([w, n]) => `${w}\t${n}`).join('\n')]);
  insW.free();
  const insL = db.prepare('INSERT INTO lexicon VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of lexicon.sort((a, b) => (a.topic < b.topic ? -1 : 1))) insL.run([r.topic, r.lemma, r.translit, r.pronunciation, r.gloss, r.definition, r.derivation, r.kjv]);
  insL.free();
  db.run('COMMIT');
  db.run('VACUUM');
  const bytes = Buffer.from(db.export());
  db.close();
  return {
    bytes,
    meta: { code: src.code, name: src.name, language: src.language, numbering: src.numbering, year: src.year ?? '', entries: lexicon.length, source: src.homepage },
    summary: `${verses.size} стихов со словами оригинала, ${lexicon.length} статей словаря`,
    warnings: missing.size ? [`нет в словаре: ${missing.size} номеров, напр. ${[...missing].slice(0, 10).join(', ')}`] : [],
  };
}
