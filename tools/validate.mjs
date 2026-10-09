// Checks a parsed translation against the reference chapter / verse counts of its numbering.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
export const books = JSON.parse(fs.readFileSync(path.join(here, '../canon/books.json'), 'utf8'));
export const canon = (numbering) => JSON.parse(fs.readFileSync(path.join(here, `../canon/${numbering}.json`), 'utf8')).books;

/**
 * @param {Map<number, Map<string,string>>} byBook  book number → "chapter:verse" → text
 * @returns {{ errors: string[], warnings: string[], scope: 'bible'|'ot'|'nt'|'partial', verses: number, present: number[] }}
 */
export function validate(byBook, numbering) {
  const ref = canon(numbering);
  const errors = [];
  const warnings = [];
  const present = [];
  let verses = 0;
  for (const b of books) {
    const vs = byBook.get(b.n);
    if (!vs || vs.size === 0) continue;
    present.push(b.n);
    verses += vs.size;
    const counts = ref[b.n];
    const chapters = Math.max(...[...vs.keys()].map((k) => +k.split(':')[0]));
    if (chapters !== counts.length) {
      errors.push(`${b.usfm}: глав ${chapters}, должно быть ${counts.length} (нумерация ${numbering}?)`);
      continue;
    }
    let missing = 0;
    counts.forEach((n, i) => {
      let have = 0;
      for (let v = 1; v <= n; v++) if (vs.has(`${i + 1}:${v}`)) have++;
      missing += n - have;
      if (have === 0) errors.push(`${b.usfm} ${i + 1}: глава пуста`);
      else if (Math.abs(n - have) > Math.max(3, n * 0.15)) warnings.push(`${b.usfm} ${i + 1}: стихов ${have}, в эталоне ${n}`);
    });
    const total = counts.reduce((a, c) => a + c, 0);
    if (missing > total * 0.1) errors.push(`${b.usfm}: не хватает ${missing} из ${total} стихов`);
  }
  const ot = present.filter((n) => n < 470).length;
  const nt = present.filter((n) => n >= 470).length;
  if (present.length === 0) errors.push('нет ни одной книги');
  const scope = ot === 39 && nt === 27 ? 'bible' : ot === 39 && nt === 0 ? 'ot' : ot === 0 && nt === 27 ? 'nt' : 'partial';
  if (scope === 'partial' && present.length) warnings.push(`неполный набор книг: ${ot} из 39 ВЗ, ${nt} из 27 НЗ`);
  return { errors, warnings, scope, verses, present };
}
