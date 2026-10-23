// Convert a local MyBible explanatory dictionary into Bible App's SQLite module format.
// No network access, publishing, or changes to the input file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

/** Convert SQLite bytes; leave distribution rights to the caller. */
export async function convertDictionary(bytes, options = {}) {
  if (bytes.length < 16 || Buffer.from(bytes).subarray(0, 16).toString() !== 'SQLite format 3\0') {
    throw new Error('Not a SQLite 3 database');
  }
  const SQL = await initSqlJs();
  const input = new SQL.Database(bytes);
  let output;
  try {
    const query = (sql) => input.exec(sql)[0]?.values ?? [];
    if (query('PRAGMA quick_check(1)')[0]?.[0] !== 'ok') throw new Error('SQLite integrity check failed');
    const tables = new Set(query("SELECT name FROM sqlite_master WHERE type = 'table'").map(([name]) => name));
    if (!tables.has('dictionary')) throw new Error('Expected a MyBible dictionary table');
    const columns = new Set(query('PRAGMA table_info(dictionary)').map(([, name]) => name));
    if (!columns.has('topic') || !columns.has('definition')) {
      throw new Error('Dictionary must contain topic and definition columns');
    }

    const sourceInfo = {};
    if (tables.has('info')) {
      const infoColumns = new Set(query('PRAGMA table_info(info)').map(([, name]) => name));
      if (infoColumns.has('name') && infoColumns.has('value')) {
        for (const [key, value] of query('SELECT name, value FROM info')) {
          if (typeof key === 'string' && value != null) sourceInfo[key] = String(value);
        }
      }
    }
    const name = options.name || sourceInfo.description?.split('\n')[0] || 'Личный словарь MyBible';
    const info = {
      description: name, language: options.language || sourceInfo.language || 'ru',
      code: options.code || sourceInfo.abbreviation || 'DICT',
      origin: options.source || sourceInfo.origin || sourceInfo.homepage || '',
      license: options.license || sourceInfo.license || 'unverified',
      attribution: options.attribution || sourceInfo.attribution || '',
      type: 'dictionary', app_format: '1',
    };

    output = new SQL.Database();
    output.run('CREATE TABLE info (name TEXT, value TEXT); CREATE TABLE dictionary (topic TEXT PRIMARY KEY, definition TEXT NOT NULL) WITHOUT ROWID;');
    for (const [key, value] of Object.entries(info)) output.run('INSERT INTO info VALUES (?, ?)', [key, String(value)]);
    const read = input.prepare('SELECT topic, definition FROM dictionary');
    const insert = output.prepare('INSERT INTO dictionary (topic, definition) VALUES (?, ?)');
    let count = 0;
    try {
      output.run('BEGIN');
      while (read.step()) {
        const [rawTopic, definition] = read.get();
        const topic = typeof rawTopic === 'string' ? rawTopic.trim() : '';
        if (!topic || typeof definition !== 'string') throw new Error('Invalid dictionary article at row ' + (count + 1));
        try { insert.run([topic, definition]); }
        catch { throw new Error('Duplicate dictionary topic: ' + topic); }
        count++;
      }
      if (!count) throw new Error('Dictionary is empty');
      output.run('COMMIT');
    } finally {
      read.free();
      insert.free();
    }
    return { bytes: Buffer.from(output.export()), entries: count, info };
  } finally {
    output?.close();
    input.close();
  }
}

/** Minimal CLI: node tools/convert-dictionary.mjs input.SQLite3 output.db [--name Title] */
async function main(args) {
  const [inputFile, outputFile, ...flags] = args;
  if (!inputFile || !outputFile || flags.length % 2) {
    throw new Error('Usage: node tools/convert-dictionary.mjs input.SQLite3 output.db [--name title] [--code CODE] [--language ru] [--source URL] [--license TEXT] [--attribution TEXT]');
  }
  const keys = new Set(['name', 'code', 'language', 'source', 'license', 'attribution']);
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i].replace(/^--/, '');
    if (!flags[i].startsWith('--') || !keys.has(key)) throw new Error('Unknown option: ' + flags[i]);
    options[key] = flags[i + 1];
  }
  if (path.resolve(inputFile) === path.resolve(outputFile)) throw new Error('Input and output must differ');
  if (fs.existsSync(outputFile)) throw new Error('Output already exists: ' + outputFile);
  const converted = await convertDictionary(fs.readFileSync(inputFile), options);
  fs.writeFileSync(outputFile, converted.bytes, { flag: 'wx' });
  console.log(JSON.stringify({ file: path.basename(outputFile), entries: converted.entries, type: 'dictionary' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
