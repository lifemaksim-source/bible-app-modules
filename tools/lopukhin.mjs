// Лопухин «Толковая Библия» from the FB2 files of «Библиотечка православной литературы» (www.ccel.org/contrib/ru)
// → commentary module (table `commentaries`, MyBible-style columns), verses in Synodal (Russian) numbering.
//
// In the FB2 files a verse being explained is an element with an id like «n32-Jona_I_1» or «n01-Mf_I_3»
// (book code, chapter in Roman or Arabic numerals, verse); several such elements in one <cite>/<poem> form a range.
// The paragraphs that follow, up to the next verse, are the commentary. Text before the first verse of a chapter
// is the chapter introduction (verse 0); text before the first chapter is the book introduction (chapter 0).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SQL, get } from './common.mjs';
import { books, canon } from './validate.mjs';

// Book codes used in the ids → MyBible book numbers. Deuterocanonical books (Tob, Jud, Wis, Sir, Bar, 1–3 Mak,
// 2–3 Ezd, JerEp) are not in the app and are skipped on purpose.
export const CODES = {
  Gen: 10, Ex: 20, Exod: 20, Lev: 30, Num: 40, Deu: 50, Deut: 50, Jos: 60, Josh: 60, Judg: 70, Jdg: 70, Ruth: 80, Rut: 80,
  '1Kings': 90, '1Sam': 90, '1Sm': 90, '1Ts': 90, '2Kings': 100, '2Sam': 100, '2Sm': 100, '2Ts': 100, '3Kings': 110, '1Kgs': 110, '3Ts': 110, '4Kings': 120, '2Kgs': 120, '4Ts': 120,
  '1Par': 130, '1Chr': 130, '2Par': 140, '2Chr': 140, '1Ezd': 150, Ezr: 150, Ezra: 150, Neh: 160, Esth: 190, Est: 190, Job: 220, Iov: 220,
  Ps: 230, Psaltyr: 230, Psa: 230, Prov: 240, Pr: 240, Eccl: 250, Ecc: 250, Song: 260, Sng: 260, Isa: 290, Is: 290, Jer: 300, Ier: 300, Lam: 310, Plach: 310,
  Eze: 330, Ezek: 330, Iez: 330, Dan: 340, Hos: 350, Os: 350, Joe: 360, Joel: 360, Amo: 370, Am: 370, Oba: 380, Avd: 380, Jona: 390, Jon: 390, Ion: 390,
  Mic: 400, Mih: 400, Nah: 410, Naum: 410, Hab: 420, Avv: 420, Zep: 430, Sof: 430, Hag: 440, Agg: 440, Zec: 450, Zah: 450, Mal: 460,
  Mf: 470, Mt: 470, Matt: 470, Mk: 480, Mr: 480, Mark: 480, Lk: 490, Luke: 490, Jn: 500, In: 500, Ioan: 500, John: 500, Act: 510, Acts: 510, Deyan: 510,
  Jas: 660, Iak: 660, Jac: 660, '1Pet': 670, '1Pt': 670, '2Pet': 680, '2Pt': 680, '1Jn': 690, '1In': 690, '1Ioan': 690, '2Jn': 700, '2In': 700, '2Ioan': 700, '3Jn': 710, '3In': 710, '3Ioan': 710,
  Jude: 720, Iud: 720, Jud_Ep: 720,
  Rom: 520, Rim: 520, '1Cor': 530, '1Kor': 530, '2Cor': 540, '2Kor': 540, Gal: 550, Eph: 560, Efes: 560, Ef: 560, Phil: 570, Phlp: 570, Flp: 570, Col: 580, Kol: 580,
  '1Thes': 590, '1Thess': 590, '1Sol': 590, '1Fes': 590, '2Thes': 600, '2Thess': 600, '2Sol': 600, '2Fes': 600, '1Tim': 610, '2Tim': 620, Tit: 630, Phlm: 640, Flm: 640, Heb: 650, Evr: 650,
  Rev: 730, Apok: 730, Otkr: 730, Ap: 730,
};
const SKIP = /^(Tob|Jud|Iudif|Wis|Sir|Bar|JerEp|EpJer|[123]Mak|[123]Mac|[23]Ezd|Prem|Varuh)$/;

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
export function roman(s) {
  if (/^\d+$/.test(s)) return Number(s);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = ROMAN[s[i]];
    const b = ROMAN[s[i + 1]] ?? 0;
    if (!a) return NaN;
    n += a < b ? -a : a;
  }
  return n;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Inner XML of a paragraph → plain text: footnote marks «[42]» dropped, link texts kept, entities decoded. */
export function plain(xml) {
  return xml
    .replace(/\[\s*<a [^>]*type="note"[^>]*>[^<]*<\/a>\s*\]/g, '')
    .replace(/<a [^>]*type="note"[^>]*>\s*\d+\s*<\/a>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** «1. «И было»…» → «И было»…; «3 и 4. Фарес…» → «Фарес…» (the verse numbers are shown by the app). */
const dropNumber = (p) => p.replace(/^\d+(\s*(–|-|—|,|и)\s*\d+)*\s*\.\s*/, '');

/** FB2 files come in UTF-8 or Windows-1251 — as the XML declaration says. */
export function decode(input) {
  if (typeof input === 'string') return input;
  const enc = input.subarray(0, 200).toString('latin1').match(/encoding="([^"]+)"/i)?.[1]?.toLowerCase() ?? 'utf-8';
  return new TextDecoder(enc === 'windows-1251' || enc === 'cp1251' ? 'windows-1251' : 'utf-8').decode(input);
}

/**
 * Parses one FB2 file (a Buffer, or text already decoded).
 * @returns {{ entries: {code:string, chapter:number, verse:number, chapterTo:number, verseTo:number, paras:string[]}[], codes: Set<string> }}
 */
export function parseFb2(input) {
  const text = decode(input).replace(/\r/g, '');
  const start = text.indexOf('<body');
  const notes = text.indexOf('<body name="notes"');
  const body = text.slice(start, notes > start ? notes : undefined);
  const entries = [];
  const codes = new Set();
  let code = null; // current book code
  let target = null; // entry receiving paragraphs
  // Paragraphs whose verse is not known yet: after a book or section title (bookIntro) or after a chapter title (chapIntro).
  let bookIntro = [];
  let chapIntro = [];
  let mode = 'book';
  let quote = 0; // inside <cite>/<poem>: Bible text, not commentary
  let lastWasVerse = false;
  const re = /<title>([\s\S]*?)<\/title>|<(p|v)\s+id="n\d+-([^"_]+)_([^"_]+)_(\d+)"[^>]*>[\s\S]*?<\/\2>|<(cite|poem)\b[^>]*>|<\/(cite|poem)>|<p>([\s\S]*?)<\/p>/g;
  for (let m; (m = re.exec(body)); ) {
    if (m[1] !== undefined) {
      // a title: «Глава IV», «Псалом 22» — a new chapter; anything else (book or section names) — an introduction
      if (!quote) {
        target = null;
        mode = /^(?:Глава|Псалом)\s+([IVXLC]+|\d+)\b/i.test(plain(m[1])) ? 'chapter' : 'book';
      }
      lastWasVerse = false;
      continue;
    }
    if (m[3] !== undefined) {
      const [vCode, vChap, vVerse] = [m[3], roman(m[4]), Number(m[5])];
      codes.add(vCode);
      if (vCode !== code) {
        // a new book: what was collected is its introduction and the introduction of its first chapter
        code = vCode;
        if (bookIntro.length) entries.push({ code, chapter: 0, verse: 0, chapterTo: 0, verseTo: 0, paras: bookIntro });
        if (chapIntro.length) entries.push({ code, chapter: vChap, verse: 0, chapterTo: vChap, verseTo: 0, paras: chapIntro });
      } else if (bookIntro.length || chapIntro.length) {
        entries.push({ code, chapter: vChap, verse: 0, chapterTo: vChap, verseTo: 0, paras: [...bookIntro, ...chapIntro] });
      }
      bookIntro = [];
      chapIntro = [];
      if (lastWasVerse && target && quote) {
        // another verse in the same quote: the comment that follows covers the range
        target.chapterTo = vChap;
        target.verseTo = vVerse;
      } else {
        target = { code, chapter: vChap, verse: vVerse, chapterTo: vChap, verseTo: vVerse, paras: [] };
        entries.push(target);
      }
      lastWasVerse = true;
      continue;
    }
    if (m[6]) {
      quote++;
      continue;
    }
    if (m[7]) {
      quote = Math.max(0, quote - 1);
      continue;
    }
    if (m[8] !== undefined && !quote) {
      const p = plain(m[8]);
      lastWasVerse = false;
      if (!p) continue;
      if (target) target.paras.push(target.paras.length ? p : dropNumber(p) || p);
      else (mode === 'chapter' ? chapIntro : bookIntro).push(p);
    }
  }
  return { entries: entries.filter((e) => e.paras.length), codes };
}

export async function buildLopukhin(src, { work }) {
  const all = [];
  const unknown = new Set();
  for (const [i, url] of src.files.entries()) {
    const zip = path.join(work, `${i}.zip`);
    await get(url, zip);
    const dir = path.join(work, String(i));
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.fb2'))) {
      const { entries, codes } = parseFb2(fs.readFileSync(path.join(dir, f)));
      for (const c of codes) if (!(c in CODES) && !SKIP.test(c)) unknown.add(`${c} (${f})`);
      all.push(...entries.filter((e) => CODES[e.code]).map((e) => ({ ...e, book: CODES[e.code] })));
    }
  }
  if (unknown.size) throw new Error(`неизвестные коды книг: ${[...unknown].join(', ')}`);

  // Coverage: which chapters of each book have comments.
  const ref = canon('rus');
  const warnings = [];
  let covered = 0;
  let total = 0;
  for (const b of books) {
    const chapters = ref[b.n].length;
    total += chapters;
    const have = new Set(all.filter((e) => e.book === b.n && e.verse > 0).map((e) => e.chapter));
    covered += have.size;
    if (have.size === 0) warnings.push(`${b.usfm}: нет толкований`);
    else if (have.size < chapters) warnings.push(`${b.usfm}: толкования к ${have.size} из ${chapters} глав`);
    const bad = all.filter((e) => e.book === b.n && e.verse > 0 && (e.chapter > chapters || e.verse > (ref[b.n][e.chapter - 1] ?? 0) + 2));
    if (bad.length) warnings.push(`${b.usfm}: ${bad.length} ссылок на несуществующие стихи, напр. ${bad[0].chapter}:${bad[0].verse}`);
  }
  if (covered < total * 0.8) throw new Error(`толкования только к ${covered} из ${total} глав:\n  ${warnings.slice(0, 15).join('\n  ')}`);

  const db = new (await SQL()).Database();
  db.run(`CREATE TABLE info (name TEXT, value TEXT);
    CREATE TABLE commentaries (book_number NUMERIC, chapter_number_from NUMERIC, verse_number_from NUMERIC,
      chapter_number_to NUMERIC, verse_number_to NUMERIC, marker TEXT, text TEXT);`);
  const info = {
    description: src.name, language: src.language, origin: src.origin, license: src.license, attribution: src.attribution,
    code: src.code, numbering: src.numbering, year: src.year, type: 'commentary', app_format: '1',
  };
  for (const [k, v] of Object.entries(info)) if (v) db.run('INSERT INTO info VALUES (?, ?)', [k, v]);
  all.sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse || a.chapterTo - b.chapterTo || a.verseTo - b.verseTo);
  db.run('BEGIN');
  const ins = db.prepare('INSERT INTO commentaries VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const e of all) ins.run([e.book, e.chapter, e.verse, e.chapterTo, e.verseTo, '', e.paras.join('\n\n')]);
  ins.free();
  db.run('COMMIT');
  db.run('CREATE INDEX commentaries_bc ON commentaries (book_number, chapter_number_from)');
  db.run('VACUUM');
  const bytes = Buffer.from(db.export());
  db.close();
  return {
    bytes,
    meta: { code: src.code, name: src.name, language: src.language, numbering: src.numbering, year: src.year, entries: all.length, source: src.homepage },
    summary: `${all.length} толкований, главы с толкованиями: ${covered} из ${total}`,
    warnings,
  };
}
