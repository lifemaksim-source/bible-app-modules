// Exploration helper (run in Actions, where the internet is open): lists Wikisource pages by prefix and saves
// samples of their wikitext to explore/, so the structure of a source can be studied before writing a builder.
//   node tools/explore.mjs wikisource "Толковая Библия Лопухина" [more prefixes…]
//   node tools/explore.mjs pages "Title 1" "Title 2"   — wikitext of exact pages
import fs from 'node:fs';
import path from 'node:path';

import { root } from './common.mjs';

const API = 'https://ru.wikisource.org/w/api.php';
const UA = 'bible-app-modules/1.0 (https://github.com/lifemaksim-source/bible-app-modules)';
const out = path.join(root, 'explore');
fs.mkdirSync(path.join(out, 'pages'), { recursive: true });

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function allPages(prefix, ns = '0') {
  const titles = [];
  let cont = {};
  for (;;) {
    const r = await api({ action: 'query', list: 'allpages', apprefix: prefix, aplimit: '500', apnamespace: ns, ...cont });
    titles.push(...r.query.allpages.map((p) => p.title));
    if (!r.continue) break;
    cont = r.continue;
  }
  return titles;
}

async function wikitext(titles) {
  const r = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.join('|') });
  return r.query.pages.map((p) => ({ title: p.title, text: p.revisions?.[0]?.slots?.main?.content ?? '(нет страницы)' }));
}

const safe = (t) => t.replace(/[\/\\:*?"<>|]+/g, '_').slice(0, 120);
const [mode, ...args] = process.argv.slice(2);
const summary = [];

if (mode === 'wikisource' || mode === 'wikisource-ns') {
  // wikisource-ns <namespace> <prefix…>: e.g. 104 — «Страница:» (pages of scanned books)
  const ns = mode === 'wikisource-ns' ? args.shift() : '0';
  for (const prefix of args) {
    const titles = await allPages(prefix, ns);
    fs.writeFileSync(path.join(out, `${safe(prefix)}.titles.txt`), titles.join('\n') + '\n');
    summary.push(`${prefix}: ${titles.length} страниц`);
    // samples: the root page, the first pages and a spread across the list
    const pick = [...new Set([titles[0], ...titles.slice(1, 4), ...[0.1, 0.3, 0.5, 0.7, 0.9].map((f) => titles[Math.floor(titles.length * f)])].filter(Boolean))];
    for (let i = 0; i < pick.length; i += 20) for (const p of await wikitext(pick.slice(i, i + 20))) fs.writeFileSync(path.join(out, 'pages', `${safe(p.title)}.txt`), p.text);
  }
} else if (mode === 'pages') {
  for (let i = 0; i < args.length; i += 20) {
    for (const p of await wikitext(args.slice(i, i + 20))) {
      fs.writeFileSync(path.join(out, 'pages', `${safe(p.title)}.txt`), p.text);
      summary.push(`${p.title}: ${p.text.length} символов`);
    }
  }
} else if (mode === 'zip') {
  // zip <file regex> <url…>: lists each archive and saves the first 400 kB of matching files
  const [pattern, ...urls] = args;
  const { execFileSync } = await import('node:child_process');
  const { get } = await import('./common.mjs');
  const lists = [];
  for (const [i, url] of urls.entries()) {
    const tmp = path.join(root, 'work', 'explore', String(i));
    fs.mkdirSync(tmp, { recursive: true });
    await get(url, path.join(tmp, 'a.zip'));
    execFileSync('unzip', ['-q', '-o', path.join(tmp, 'a.zip'), '-d', path.join(tmp, 'x')]);
    const files = execFileSync('find', [path.join(tmp, 'x'), '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
    lists.push(`# ${url}`, ...files.map((f) => `${fs.statSync(f).size}\t${path.relative(path.join(tmp, 'x'), f)}`));
    summary.push(`${url}: ${files.length} файлов`);
    for (const f of files.filter((x) => new RegExp(pattern).test(x)).slice(0, 5)) {
      fs.writeFileSync(path.join(out, 'pages', safe(path.basename(f)) + '.txt'), fs.readFileSync(f).subarray(0, Number(process.env.EXPLORE_BYTES || 400000)));
      summary.push(`  ${path.basename(f)}: ${fs.statSync(f).size} байт`);
    }
  }
  fs.writeFileSync(path.join(out, 'files.txt'), lists.join('\n') + '\n');
} else if (mode === 'urls') {
  // urls <url…>: the text of web pages (tags removed) — e.g. license pages of translations
  for (const [i, url] of args.entries()) {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
    fs.writeFileSync(path.join(out, 'pages', `${String(i).padStart(2, '0')}-${safe(url.replace(/^https?:\/\//, ''))}.txt`), `${url}\nHTTP ${res.status}\n\n${text}`);
    summary.push(`${url}: HTTP ${res.status}, ${text.length} символов`);
  }
} else if (mode === 'mybible') {
  // mybible <registry zip url> [entry regex] [max]: the MyBible module registry (the list, as text) and a DESCRIPTION
  // of a few modules — tables, info and first rows. Archives are read in memory (no extraction to disk), modules are
  // opened in sql.js (WebAssembly) and never saved — they are not ours to publish.
  const [url, pattern, max = '4'] = args;
  const zlib = await import('node:zlib');
  const { SQL } = await import('./common.mjs');
  const LIMIT = 80e6;
  const fetchBytes = async (u) => {
    const res = await fetch(u, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > LIMIT) throw new Error(`слишком большой файл: ${b.length}`);
    return b;
  };
  // entries of a zip archive (central directory; stored or deflated) → [{ name, data }]
  const unzip = (b) => {
    let e = b.length - 22;
    while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('не zip');
    const list = [];
    let p = b.readUInt32LE(e + 16);
    for (let i = 0, n = b.readUInt16LE(e + 10); i < n; i++) {
      const method = b.readUInt16LE(p + 10);
      const packed = b.readUInt32LE(p + 20);
      const nameLen = b.readUInt16LE(p + 28);
      const name = b.toString('utf8', p + 46, p + 46 + nameLen);
      const local = b.readUInt32LE(p + 42);
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      if (b.readUInt32LE(p + 24) > LIMIT) throw new Error(`${name}: слишком большой`);
      const raw = b.subarray(start, start + packed);
      if (!name.endsWith('/')) list.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
      p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    }
    return list;
  };
  fs.mkdirSync(path.join(out, 'registry'), { recursive: true });
  let reg;
  for (const f of unzip(await fetchBytes(url))) {
    summary.push(`${f.name}: ${f.data.length} байт`);
    if (!/\.json$/i.test(f.name)) continue;
    const text = f.data.toString('utf8').replace(/^﻿/, '');
    fs.writeFileSync(path.join(out, 'registry', safe(path.basename(f.name))), text);
    reg = JSON.parse(text);
  }
  const arrays = Object.entries(reg ?? {}).filter(([, v]) => Array.isArray(v));
  for (const [k, v] of Object.entries(reg ?? {})) if (!Array.isArray(v)) summary.push(`${k}: ${JSON.stringify(v).slice(0, 300)}`);
  for (const [k, v] of arrays) {
    const keys = new Map();
    for (const e of v) for (const kk of Object.keys(e ?? {})) keys.set(kk, (keys.get(kk) ?? 0) + 1);
    summary.push(`${k}: ${v.length} записей; поля: ${[...keys].map(([kk, c]) => `${kk}(${c})`).join(', ')}`);
    for (const e of v.slice(0, 3)) summary.push('  ' + JSON.stringify(e).slice(0, 1500));
  }
  const hosts = arrays.find(([, v]) => v.some((e) => e?.alias))?.[1] ?? [];
  const entries = arrays.reduce((a, b) => (b[1].length > a[1].length ? b : a), ['', []])[1];
  const resolve = (u) => u.replace(/\{([^}]+)\}/g, (m, alias) => hosts.find((h) => h.alias === alias)?.path ?? m);
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    const hits = entries.filter((e) => re.test(JSON.stringify(e)));
    summary.push('', `## Совпадения «${pattern}»: ${hits.length}`, ...hits.map((e) => JSON.stringify(e).slice(0, 600)));
    const sql = await SQL();
    for (const e of hits.slice(0, Number(max))) {
      const urls = Object.values(e).flat().filter((v) => typeof v === 'string' && /\.zip|\{|https?:/i.test(v)).map(resolve);
      summary.push('', `## ${JSON.stringify(e).slice(0, 200)}`, `ссылки: ${urls.join(' | ')}`);
      for (const u of urls) {
        try {
          for (const f of unzip(await fetchBytes(u))) {
            summary.push(`### ${f.name} — ${f.data.length} байт (с ${u})`);
            if (!/\.sqlite3?$/i.test(f.name)) continue;
            const db = new sql.Database(f.data);
            for (const [name, ddl] of db.exec("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index')")[0]?.values ?? []) {
              summary.push(String(ddl ?? name));
              if (!String(ddl ?? '').startsWith('CREATE TABLE')) continue;
              const q = `"${String(name).replace(/"/g, '""')}"`;
              const c = db.exec(`SELECT count(*) FROM ${q}`)[0].values[0][0];
              const rows = db.exec(`SELECT * FROM ${q} LIMIT ${name === 'info' ? 60 : 4}`)[0];
              summary.push(`  строк: ${c}`, ...(rows?.values ?? []).map((r) => '  ' + JSON.stringify(r).slice(0, 700)));
            }
            db.close();
          }
          break;
        } catch (err) {
          summary.push(`  ${u}: ${err.message}`);
        }
      }
    }
  }
} else throw new Error('usage: explore.mjs wikisource <prefix…> | pages <title…> | zip <regex> <url…> | urls <url…> | mybible <registry url> [regex] [max]');

fs.writeFileSync(path.join(out, 'README.md'), summary.join('\n') + '\n');
console.log(summary.join('\n'));
