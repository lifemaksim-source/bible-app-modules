// Builds the modules listed in sources.json and updates catalog.json.
//
//   node tools/build.mjs                 build everything listed in sources.json
//   node tools/build.mjs --only web      one module
//   node tools/build.mjs --list ru uk    print eBible translations for the given language codes (to pick ids); add "pd" for public domain only
//
// Module types: "bible" (tools/bible.mjs), "crossrefs" (tools/crossrefs.mjs).
// Output: dist/<id>-v<version>.db (new or changed modules only), catalog.json, dist/report.md
// A module whose content did not change keeps its version, so the app does not offer a needless update.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildBible } from './bible.mjs';
import { get, parseCsv, root, sha256 } from './common.mjs';
import { buildCrossrefs } from './crossrefs.mjs';
import { buildLopukhin } from './lopukhin.mjs';

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
const BASE = process.env.EBIBLE_BASE || cfg.base;
const REPO = process.env.GITHUB_REPOSITORY || 'lifemaksim-source/bible-app-modules';
const args = process.argv.slice(2);
// A builder per type; commentaries differ by source format.
const BUILDERS = { bible: buildBible, crossrefs: buildCrossrefs, 'commentary:ccel-fb2': buildLopukhin };

if (args[0] === '--list') {
  const csv = path.join(root, 'work/translations.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  await get(`${BASE}/translations.csv`, csv);
  const rows = parseCsv(fs.readFileSync(csv, 'utf8'));
  const head = rows[0];
  const col = (n) => head.indexOf(n);
  const pd = args.includes('pd');
  const langs = args.slice(1).filter((a) => a !== 'pd');
  for (const r of rows.slice(1)) {
    if (langs.length && !langs.includes(r[col('languageCode')])) continue;
    if (pd && !/public domain/i.test(r[col('Copyright')])) continue;
    console.log([r[col('translationId')], r[col('languageCode')], r[col('title')], `redistr=${r[col('Redistributable')]}`, r[col('Copyright')].slice(0, 45), `OT${r[col('OTbooks')]}/NT${r[col('NTbooks')]}`].join(' ; '));
  }
  process.exit(0);
}

const only = args[0] === '--only' ? args[1] : null;
const catalogPath = path.join(root, 'catalog.json');
const old = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { format: 1, modules: [] };
const entries = new Map(old.modules.map((m) => [m.id, m]));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const report = [];
let failed = 0;

for (const src of cfg.modules) {
  if (only && src.id !== only) continue;
  const type = src.type ?? 'bible';
  const work = path.join(root, 'work', src.id);
  try {
    const build = BUILDERS[src.format ? `${type}:${src.format}` : type];
    if (!build) throw new Error(`неизвестный тип модуля: ${type}${src.format ? ` (${src.format})` : ''}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const built = await build(src, { work, base: BASE });
    const { meta, summary, warnings } = built;
    // Everything except Bible texts is published gzip-compressed (Bibles stay plain: the first app versions expect that).
    const gzip = src.gzip ?? type !== 'bible';
    const bytes = gzip ? zlib.gzipSync(built.bytes, { level: 9 }) : built.bytes;

    const hash = sha256(bytes);
    if (src.draft) {
      // Built and checked, but not published: waits for a decision (e.g. about the rights of a source).
      report.push(`📝 ${src.id} (черновик, не опубликован): ${summary}, ${(bytes.length / 1e6).toFixed(1)} МБ` + (warnings.length ? `\n   предупреждений: ${warnings.length}\n   ${warnings.slice(0, 12).join('\n   ')}` : ''));
      continue;
    }
    const prev = entries.get(src.id);
    const same = prev?.sha256 === hash;
    const version = !prev ? 1 : same ? prev.version : prev.version + 1;
    const file = `${src.id}-v${version}.db${gzip ? '.gz' : ''}`;
    if (!same) fs.writeFileSync(path.join(root, 'dist', file), bytes);
    entries.set(src.id, {
      id: src.id, type, ...meta, license: src.license, ...(src.attribution ? { attribution: src.attribution } : {}),
      version, size: bytes.length, ...(gzip ? { compression: 'gzip', installedSize: built.bytes.length } : {}), sha256: hash, url: `https://github.com/${REPO}/releases/download/modules/${file}`,
    });
    report.push(
      `✅ ${src.id}: ${summary}, ${(bytes.length / 1e6).toFixed(1)} МБ, версия ${version}${same ? ' (без изменений)' : ''}` +
        (warnings.length ? `\n   предупреждений: ${warnings.length}\n   ${warnings.slice(0, 8).join('\n   ')}` : '')
    );
  } catch (e) {
    failed++;
    report.push(`❌ ${src.id}: ${e.message}`);
  }
}

// Modules removed from sources.json leave the catalog too.
const order = new Map(cfg.modules.map((m, i) => [m.id, i]));
const drafts = new Set(cfg.modules.filter((m) => m.draft).map((m) => m.id));
const modules = [...entries.values()].filter((m) => order.has(m.id) && !drafts.has(m.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
const sets = (cfg.sets ?? []).map((s) => ({ ...s, modules: s.modules.filter((id) => modules.some((m) => m.id === id)) }));
fs.writeFileSync(catalogPath, JSON.stringify({ format: 1, updated: new Date().toISOString().slice(0, 10), modules, sets }, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'dist/report.md'), report.join('\n') + '\n');
console.log(report.join('\n'));
process.exit(failed ? 1 : 0);
