// Builds Bible modules (MyBible-style SQLite) from eBible.org USFM and updates catalog.json.
//
//   node tools/build.mjs                 build everything listed in sources.json
//   node tools/build.mjs --only web      one module
//   node tools/build.mjs --list ru uk    print eBible translations for the given language codes (to pick ids)
//
// Output: dist/<id>-v<version>.db (new or changed modules only), catalog.json, dist/report.md
// A module whose content did not change keeps its version, so the app does not offer a needless update.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

import { parseBook } from './usfm.mjs';
import { books, validate } from './validate.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
const BASE = process.env.EBIBLE_BASE || cfg.base;
const REPO = process.env.GITHUB_REPOSITORY || 'lifemaksim-source/bible-app-modules';
const args = process.argv.slice(2);

async function get(url, to) {
  if (url.startsWith('/')) return fs.copyFileSync(url, to);
  const res = await fetch(url, { headers: { 'user-agent': 'bible-app-modules (+https://github.com/lifemaksim-source/bible-app-modules)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

if (args[0] === '--list') {
  const csv = path.join(root, 'work/translations.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  await get(`${BASE}/translations.csv`, csv);
  const rows = fs.readFileSync(csv, 'utf8').split(/\r?\n/);
  console.log(rows[0]);
  const langs = args.slice(1);
  for (const r of rows.slice(1)) if (r && (!langs.length || langs.some((l) => r.includes(l)))) console.log(r);
  process.exit(0);
}

const only = args[0] === '--only' ? args[1] : null;
const catalogPath = path.join(root, 'catalog.json');
const old = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { format: 1, modules: [] };
const entries = new Map(old.modules.map((m) => [m.id, m]));
const SQL = await initSqlJs();
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const report = [];
let failed = 0;

for (const src of cfg.modules) {
  if (only && src.id !== only) continue;
  const work = path.join(root, 'work', src.id);
  try {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const zip = path.join(work, 'usfm.zip');
    await get(`${BASE}/${src.ebible}_usfm.zip`, zip);
    execFileSync('unzip', ['-q', '-o', zip, '-d', path.join(work, 'usfm')]);

    // Which file is which book: by the \id line, not by file name.
    const byBook = new Map();
    const headings = new Map();
    const notes = new Map();
    const files = fs.readdirSync(path.join(work, 'usfm')).filter((f) => /\.(usfm|sfm)$/i.test(f));
    for (const f of files) {
      const parsed = parseBook(fs.readFileSync(path.join(work, 'usfm', f), 'utf8'));
      const b = books.find((x) => x.usfm === parsed.id);
      if (!b) continue;
      byBook.set(b.n, parsed.verses);
      headings.set(b.n, parsed.headings);
      notes.set(b.n, parsed.notes);
    }
    const v = validate(byBook, src.numbering);
    if (v.errors.length) throw new Error(`проверка не пройдена:\n  ${v.errors.slice(0, 15).join('\n  ')}`);

    const db = new SQL.Database();
    db.run(`CREATE TABLE info (name TEXT, value TEXT);
      CREATE TABLE books (book_color TEXT, book_number NUMERIC, short_name TEXT, long_name TEXT, is_present NUMERIC);
      CREATE TABLE verses (book_number NUMERIC, chapter NUMERIC, verse NUMERIC, text TEXT, PRIMARY KEY (book_number, chapter, verse));
      CREATE TABLE stories (book_number NUMERIC, chapter NUMERIC, verse NUMERIC, order_if_several NUMERIC, title TEXT);
      CREATE TABLE notes (book_number NUMERIC, chapter NUMERIC, verse NUMERIC, text TEXT);`);
    const info = {
      description: src.name, language: src.language, origin: `eBible.org (${src.ebible})`, license: src.license,
      year: src.year, code: src.code, numbering: src.numbering, app_format: '1',
    };
    for (const [k, val] of Object.entries(info)) db.run('INSERT INTO info VALUES (?, ?)', [k, val]);
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

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const prev = entries.get(src.id);
    const version = !prev ? 1 : prev.sha256 === sha256 ? prev.version : prev.version + 1;
    const file = `${src.id}-v${version}.db`;
    if (!prev || prev.sha256 !== sha256) fs.writeFileSync(path.join(root, 'dist', file), bytes);
    entries.set(src.id, {
      id: src.id, type: 'bible', code: src.code, name: src.name, language: src.language, numbering: src.numbering,
      year: src.year, license: src.license, scope: v.scope, verses: v.verses, version, size: bytes.length, sha256,
      source: `https://ebible.org/find/details.php?id=${src.ebible}`,
      url: `https://github.com/${REPO}/releases/download/modules/${file}`,
    });
    const same = prev && prev.sha256 === sha256;
    report.push(
      `✅ ${src.id}: ${v.verses} стихов, ${v.scope}, ${(bytes.length / 1e6).toFixed(1)} МБ, версия ${version}${same ? ' (без изменений)' : ''}` +
        (v.warnings.length ? `\n   предупреждений: ${v.warnings.length}\n   ${v.warnings.slice(0, 8).join('\n   ')}` : '')
    );
  } catch (e) {
    failed++;
    report.push(`❌ ${src.id}: ${e.message}`);
  }
}

const order = new Map(cfg.modules.map((m, i) => [m.id, i]));
const modules = [...entries.values()].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
fs.writeFileSync(catalogPath, JSON.stringify({ format: 1, updated: new Date().toISOString().slice(0, 10), modules }, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'dist/report.md'), report.join('\n') + '\n');
console.log(report.join('\n'));
process.exit(failed ? 1 : 0);
