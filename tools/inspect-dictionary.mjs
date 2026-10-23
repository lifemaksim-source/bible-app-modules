// Inspects a local SQLite/MyBible dictionary without publishing or copying its text.
// Usage: node tools/inspect-dictionary.mjs path/to/dictionary.sqlite
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/inspect-dictionary.mjs <local .db/.sqlite file>');
  process.exit(2);
}
const bytes = fs.readFileSync(file);
if (bytes.length < 16 || Buffer.from(bytes).subarray(0, 16).toString() !== 'SQLite format 3\0') {
  throw new Error('Not a SQLite 3 database');
}

const SQL = await initSqlJs();
const db = new SQL.Database(bytes);
try {
  const read = (sql) => db.exec(sql)[0]?.values ?? [];
  const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
  const tables = read("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(([name]) => name);
  const info = tables.map((name) => {
    const columns = read('PRAGMA table_info(' + quote(name) + ')').map(([, column, type]) => ({ name: column, type }));
    const rows = read('SELECT COUNT(*) FROM ' + quote(name))[0]?.[0] ?? 0;
    return { name, rows, columns };
  });
  const integrity = read('PRAGMA quick_check(1)')[0]?.[0] ?? 'unknown';
  const report = { file: path.basename(file), sizeBytes: bytes.length, integrity, tables: info };
  console.log(JSON.stringify(report, null, 2));
  if (integrity !== 'ok') process.exitCode = 1;
} finally {
  db.close();
}
