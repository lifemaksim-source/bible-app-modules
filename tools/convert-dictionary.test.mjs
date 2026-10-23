// Run: node --test tools/convert-dictionary.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { convertDictionary } from './convert-dictionary.mjs';

async function fixture(sql) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(sql);
  const bytes = db.export();
  db.close();
  return bytes;
}

test('converts Russian MyBible entries and metadata without losing markup', async () => {
  const source = await fixture(`
    CREATE TABLE info (name TEXT, value TEXT);
    INSERT INTO info VALUES ('language', 'ru'), ('description', 'Тестовый словарь');
    CREATE TABLE dictionary (topic TEXT, definition TEXT);
    INSERT INTO dictionary VALUES ('Авраам', '<b>Патриарх</b> Быт 12:1'), ('Завет', 'Обетование');
  `);
  const converted = await convertDictionary(source, { code: 'BRK' });
  const SQL = await initSqlJs();
  const db = new SQL.Database(converted.bytes);
  assert.equal(converted.entries, 2);
  assert.deepEqual(db.exec('SELECT topic, definition FROM dictionary ORDER BY topic')[0].values,
    [['Авраам', '<b>Патриарх</b> Быт 12:1'], ['Завет', 'Обетование']]);
  const info = Object.fromEntries(db.exec('SELECT name, value FROM info')[0].values);
  assert.equal(info.type, 'dictionary');
  assert.equal(info.code, 'BRK');
  assert.equal(info.language, 'ru');
  assert.equal(info.license, 'unverified');
  db.close();
});

test('rejects unsupported schema and empty dictionary', async () => {
  const noDictionary = await fixture('CREATE TABLE unrelated (topic TEXT)');
  await assert.rejects(convertDictionary(noDictionary), /Expected a MyBible dictionary table/);
  const empty = await fixture('CREATE TABLE dictionary (topic TEXT, definition TEXT)');
  await assert.rejects(convertDictionary(empty), /Dictionary is empty/);
});

test('rejects duplicate and invalid topics, rather than dropping articles', async () => {
  const dupe = await fixture(`CREATE TABLE dictionary (topic TEXT, definition TEXT);
    INSERT INTO dictionary VALUES ('Завет', 'one'), (' Завет ', 'two')`);
  await assert.rejects(convertDictionary(dupe), /Duplicate dictionary topic/);
  const invalid = await fixture(`CREATE TABLE dictionary (topic TEXT, definition TEXT);
    INSERT INTO dictionary VALUES ('', 'body')`);
  await assert.rejects(convertDictionary(invalid), /Invalid dictionary article/);
});
