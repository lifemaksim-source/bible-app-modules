// Shared helpers of the module builders.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let sql;
/** sql.js, loaded once. */
export async function SQL() {
  sql ??= await initSqlJs();
  return sql;
}

/** Downloads a URL to a file (a local path is copied — for tests). */
export async function get(url, to) {
  if (url.startsWith('/')) return fs.copyFileSync(url, to);
  const res = await fetch(url, { headers: { 'user-agent': 'bible-app-modules (+https://github.com/lifemaksim-source/bible-app-modules)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Downloads and checks the checksum pinned in sources.json, so a changed upstream file is noticed. */
export async function getPinned(url, expected, to) {
  await get(url, to);
  const got = sha256(fs.readFileSync(to));
  if (expected && got !== expected) throw new Error(`${url}: контрольная сумма ${got}, ожидалась ${expected} (файл у источника изменился — проверьте и обновите sources.json)`);
}

/** The `info` table every module starts with. */
export function writeInfo(db, info) {
  db.run('CREATE TABLE info (name TEXT, value TEXT)');
  for (const [k, v] of Object.entries(info)) if (v !== undefined && v !== '') db.run('INSERT INTO info VALUES (?, ?)', [k, String(v)]);
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  rows[0][0] = rows[0][0].replace(/^﻿/, '');
  return rows;
}
