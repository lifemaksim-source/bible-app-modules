// Real RU MyBible compatibility probes: five public-registry modules.
// NEVER print article texts, commit binaries or upload the archives as artifacts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SQL } from './common.mjs';
import { auditDictionary } from './dictionary-audit.mjs';

const REGISTRY = 'https://mybible.zone/repository/registry/registry.zip';
const MODULES = [
  { file: 'Имена.dictionary', kind: 'dictionary' },
  { file: 'Нюстрем.dictionary', kind: 'dictionary' },
  { file: 'Брокгауз.dictionary', kind: 'dictionary' },
  { file: 'БТ-к.commentaries', kind: 'commentary' },
  { file: 'Баркли-к.commentaries', kind: 'commentary' },
];
const MAX_ZIP = 16 * 1024 * 1024;
const MAX_DB = 48 * 1024 * 1024;
const count = (db, sql) => Number(db.exec(sql)[0]?.values?.[0]?.[0] ?? 0);

/** The only allowed URL prefix is the official MyBible HTTPS module store. */
export function moduleUrl(registry, file) {
  const mod = registry.downloads?.find((x) => x.fil === file && x.lng === 'ru' && x.hid !== true);
  if (!mod) throw new Error(file + ': not in Russian MyBible registry');
  const hosts = new Map((registry.hosts || []).filter((x) => typeof x.alias === 'string'
    && typeof x.path === 'string').map((x) => [x.alias, x.path]));
  for (const part of Array.isArray(mod.url) ? mod.url : []) {
    const match = /^\{([^}]+)\}(.+)$/.exec(part);
    const template = match && hosts.get(match[1]);
    if (!template || !template.includes('%s')) continue;
    const raw = template.replace('%s', match[2]);
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.hostname === 'mybible.zone' &&
        url.pathname.startsWith('/repository/modules/') && !url.search && !url.hash) return url.href;
  }
  throw new Error(file + ': no usable trusted download URL');
}

/** Check actual archive member name; avoids mistakenly reading translation sidecars. */
export function dictionaryOrCommentaryMember(members, file) {
  const sql = members.filter((n) => /\.(sqlite3|db)$/i.test(n) && !n.endsWith('/'));
  const wanted = file.toLowerCase() + '.sqlite3';
  const byName = sql.find((entry) => path.posix.basename(entry).toLowerCase() === wanted);
  if (byName) return byName;
  // Legacy archives place their single module in a file literally called ".SQLite3".
  const legacy = sql.filter((entry) => path.posix.basename(entry).toLowerCase() === '.sqlite3');
  if (legacy.length === 1) return legacy[0];
  throw new Error(file + ': expected dictionary/commentary member absent');
}

async function getZip(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(50_000),
    headers: { 'user-agent': 'bible-app-modules compatibility QA' } });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + new URL(url).hostname);
  if (Number(response.headers.get('content-length') || 0) > MAX_ZIP) throw new Error('archive too large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ZIP || bytes.subarray(0, 2).toString() !== 'PK') throw new Error('bad ZIP');
  return bytes;
}

function extractZip(zipPath, member) {
  return execFileSync('unzip', ['-p', zipPath, member], { timeout: 25_000, maxBuffer: MAX_DB });
}

function openModule(InitSqlJs, bytes) {
  if (bytes.length > MAX_DB || bytes.subarray(0, 15).toString() !== 'SQLite format 3')
    throw new Error('not a valid bounded SQLite file');
  return new InitSqlJs.Database(new Uint8Array(bytes));
}

function inspectCommentary(db) {
  if (db.exec("PRAGMA quick_check")[0]?.values?.[0]?.[0] !== 'ok') throw new Error('SQLite corruption');
  const fields = new Set((db.exec('PRAGMA table_info(commentaries)')[0]?.values || []).map((x) => x[1]));
  const expected = ['book_number', 'chapter_number_from', 'verse_number_from', 'chapter_number_to', 'verse_number_to', 'text'];
  const missing = expected.filter((name) => !fields.has(name));
  if (missing.length) throw new Error('Missing commentary fields: ' + missing.join(','));
  const entries = count(db, 'SELECT COUNT(*) FROM commentaries');
  const invalidContent = count(db, "SELECT COUNT(*) FROM commentaries WHERE typeof(text) != 'text'");
  if (!entries || invalidContent) throw new Error('Empty module or invalid text fields');
  return { entries, invalidContent };
}

/** Table/column NAMES and row counts only. Never log words or definitions. */
export function wordformSchema(db) {
  const candidates = (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || [])
    .map(([name]) => String(name))
    .filter((name) => /^(words|wordforms|word_forms|morphology|dictionary)$/i.test(name));
  return candidates.map((name) => {
    // Only known internal table names may be used in identifier interpolation.
    const table = name.replace(/"/g, '""');
    const columns = (db.exec(`PRAGMA table_info("${table}")`)[0]?.values || [])
      .map((row) => String(row[1]));
    const rows = count(db, `SELECT COUNT(*) FROM "${table}"`);
    return { table: name, columns, rows };
  });
}

function rightsFlags(db) {
  const tables = new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || []).map((x) => x[0]));
  if (!tables.has('info')) return { license: false, attribution: false, source: false };
  const fields = new Set((db.exec('PRAGMA table_info(info)')[0]?.values || []).map((x) => x[1]));
  if (!fields.has('name') || !fields.has('value')) return { license: false, attribution: false, source: false };
  const pairs = db.exec("SELECT name,value FROM info WHERE name IN ('license', 'attribution', 'origin', 'homepage')")[0]?.values || [];
  const info = new Map(pairs);
  const present = (k) => typeof info.get(k) === 'string' && info.get(k).trim().length > 0;
  return { license: present('license'), attribution: present('attribution'), source: present('origin') || present('homepage') };
}

export async function probeRussianModules() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybible-ru-qa-'));
  try {
    const registryZip = path.join(temp, 'registry.zip');
    fs.writeFileSync(registryZip, await getZip(REGISTRY));
    const paths = execFileSync('unzip', ['-Z', '-1', registryZip], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\r?\n/);
    const registryMember = paths.find((x) => path.posix.basename(x) === 'registry.json');
    if (!registryMember) throw new Error('registry.json absent');
    const registryJson = extractZip(registryZip, registryMember).toString('utf8').replace(/^\uFEFF/, '');
    const registry = JSON.parse(registryJson);
    const InitSqlJs = await SQL();
    const report = [];
    for (const fixture of MODULES) {
      const url = moduleUrl(registry, fixture.file);
      const archive = path.join(temp, 'module.zip');
      fs.writeFileSync(archive, await getZip(url));
      const members = execFileSync('unzip', ['-Z', '-1', archive], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\r?\n/);
      const selected = dictionaryOrCommentaryMember(members, fixture.file);
      const db = openModule(InitSqlJs, extractZip(archive, selected));
      try {
        if (fixture.kind === 'dictionary') {
          const audit = auditDictionary(db);
          const summary = { file: fixture.file, kind: fixture.kind, entries: audit.entries,
            ok: audit.ok, problems: audit.errors, rights: rightsFlags(db), schema: wordformSchema(db) };
          report.push(summary);
          console.log(JSON.stringify(summary));
          if (!audit.ok) throw new Error(fixture.file + ': dictionary audit failed');
        } else {
          const review = inspectCommentary(db);
          const summary = { file: fixture.file, kind: fixture.kind, ...review, ok: true, rights: rightsFlags(db) };
          report.push(summary);
          console.log(JSON.stringify(summary));
        }
      } finally {
        db.close();
      }
      fs.rmSync(archive, { force: true });
    }
    return report;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await probeRussianModules(); }
  catch (error) { console.error('RU compatibility QA failed:', error.message); process.exitCode = 1; }
}
