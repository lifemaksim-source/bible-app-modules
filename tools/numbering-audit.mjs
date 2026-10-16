// Audit source labels as well as parsed coordinates; never alter Bible text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseBook } from './usfm.mjs';
import { books } from './validate.mjs';
import { numberingReport } from './numbering-report.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function sourceLabels(source) {
  let chapter = 0;
  const labels = new Map();
  const bridges = new Map();
  for (const match of source.matchAll(/^\\([cv])\s+(\S+)/gm)) {
    if (match[1] === 'c') { chapter = Number(match[2]); continue; }
    const verse = match[2].match(/^(\d+)[a-z]?(?:[-–](\d+)[a-z]?)?$/);
    if (!verse || !chapter) continue;
    const first = Number(verse[1]);
    labels.set(`${chapter}:${first}`, match[2]);
    if (verse[2]) for (let v = first + 1; v <= Number(verse[2]); v++) bridges.set(`${chapter}:${v}`, `${chapter}:${match[2]}`);
  }
  return { labels, bridges };
}

export function missingReason(key, parsed, labels) {
  if (labels.bridges.has(key)) return { kind: 'verse-bridge', source: labels.bridges.get(key) };
  if (labels.labels.has(key)) return { kind: parsed.notes.has(key) ? 'notes-only' : 'empty-source-label' };
  return { kind: 'no-source-label' }; // Does NOT mean missing text: numbering may differ.
}

export function auditTranslation(src, directory, archive) {
  const byBook = new Map();
  const detail = new Map();
  const files = [];
  for (const filename of fs.readdirSync(directory).filter(f => /\.(usfm|sfm)$/i.test(f)).sort()) {
    const bytes = fs.readFileSync(path.join(directory, filename));
    const source = bytes.toString('utf8');
    const parsed = parseBook(source);
    const book = books.find(b => b.usfm === parsed.id);
    if (!book) continue;
    if (byBook.has(book.n)) throw new Error(`Duplicate book ${book.usfm}`);
    byBook.set(book.n, parsed.verses);
    detail.set(book.usfm, { parsed, labels: sourceLabels(source) });
    files.push({ file: filename, sha256: hash(bytes) });
  }
  const report = numberingReport(byBook);
  const selected = report.candidates[src.numbering];
  const missing = selected.differences.flatMap(d => d.missing.map(v => {
    const ref = `${d.chapter}:${v}`;
    const data = detail.get(d.book);
    return { book: d.book, ref, ...missingReason(ref, data.parsed, data.labels) };
  }));
  const textRows = books.flatMap(b => [...(byBook.get(b.n) ?? [])].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([ref, text]) => [b.n, ref, text]));
  return {
    id: src.id, ebible: src.ebible, source: `https://ebible.org/Scriptures/${src.ebible}_usfm.zip`,
    ...(archive ? { archiveSha256: hash(fs.readFileSync(archive)) } : {}),
    files, textSha256: hash(JSON.stringify(textRows)),
    books: report.books, chapters: report.chapters, verses: report.verses,
    comparisonBase: src.numbering, review: src.numberingReview,
    candidates: Object.fromEntries(Object.entries(report.candidates).map(([key, value]) => [key, { missing: value.missing, extra: value.extra, chapterMismatches: value.chapterMismatches }])),
    missing, extra: selected.differences.flatMap(d => d.extra.map(v => `${d.book} ${d.chapter}:${v}`)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const input = args[args.indexOf('--source-root') + 1];
  const output = args[args.indexOf('--out') + 1];
  if (!args.includes('--source-root') || !args.includes('--out') || !input || !output) throw new Error('Usage: node tools/numbering-audit.mjs --source-root <folder> --out <json>');
  const root = path.resolve(import.meta.dirname, '..');
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'))).modules;
  const results = sources.filter(s => s.bookNames && s.ebible && !s.deferred).map(src => {
    const folder = path.join(input, src.id);
    const directory = fs.existsSync(path.join(folder, 'usfm')) ? path.join(folder, 'usfm') : folder;
    const archive = [path.join(folder, 'usfm.zip'), path.join(input, `${src.ebible}.zip`)].find(f => fs.existsSync(f));
    return auditTranslation(src, directory, archive);
  });
  fs.writeFileSync(output, JSON.stringify({ format: 1, modules: results }, null, 2) + '\n');
  console.log(`Audited ${results.length} source editions; no verse text changed.`);
}
