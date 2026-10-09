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

async function allPages(prefix) {
  const titles = [];
  let cont = {};
  for (;;) {
    const r = await api({ action: 'query', list: 'allpages', apprefix: prefix, aplimit: '500', apnamespace: '0', ...cont });
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

if (mode === 'wikisource') {
  for (const prefix of args) {
    const titles = await allPages(prefix);
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
} else throw new Error('usage: explore.mjs wikisource <prefix…> | pages <title…>');

fs.writeFileSync(path.join(out, 'README.md'), summary.join('\n') + '\n');
console.log(summary.join('\n'));
