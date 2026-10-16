import test from 'node:test';
import assert from 'node:assert/strict';

import { SQL } from './common.mjs';
import { auditDictionary } from './dictionary-audit.mjs';

async function database(schema = true, index = true) {
  const db = new (await SQL()).Database();
  db.run('CREATE TABLE info (name TEXT, value TEXT)');
  if (schema) {
    db.run('CREATE TABLE dictionary (topic TEXT, definition TEXT)');
    if (index) db.run('CREATE UNIQUE INDEX dictionary_topic ON dictionary(topic ASC)');
  }
  return db;
}

test('valid MyBible dictionary: correct schema, unicode articles and rights metadata', async () => {
  const db = await database();
  try {
    db.run("INSERT INTO info VALUES ('license', 'CC BY 4.0'), ('attribution', 'Example author'), ('origin', 'https://example.invalid')");
    db.run('INSERT INTO dictionary VALUES (?, ?)', ['Бог', '<p>Текст <a href="B:10 1:1">Быт 1:1</a></p>']);
    db.run('INSERT INTO dictionary VALUES (?, ?)', ['G26', '<b>agape</b>']);
    const result = auditDictionary(db);
    assert.equal(result.ok, true);
    assert.equal(result.entries, 2);
    assert.equal(result.hasTopicIndex, true);
    assert.equal(result.hasLicense, true);
    assert.equal(result.hasAttribution, true);
    assert.equal(result.hasSource, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    db.close();
  }
});

test('reject missing dictionary table and wrong schema', async () => {
  const absent = await database(false);
  const invalid = await database(false);
  try {
    invalid.run('CREATE TABLE dictionary (word TEXT, meaning TEXT)');
    assert.match(auditDictionary(absent).errors[0], /Missing MyBible dictionary/);
    assert.match(auditDictionary(invalid).errors[0], /topic and definition/);
  } finally {
    absent.close();
    invalid.close();
  }
});

test('reject empty, duplicate and invalid article keys and NULL definitions', async () => {
  const db = await database(true, false);
  try {
    db.run('INSERT INTO dictionary VALUES (?, ?)', ['G26', '<p>First</p>']);
    db.run('INSERT INTO dictionary VALUES (?, ?)', ['G26', '<p>Second</p>']);
    db.run('INSERT INTO dictionary VALUES (?, ?)', ['   ', '<p>Blank topic</p>']);
    db.run('INSERT INTO dictionary VALUES (?, ?)', ['H1', null]);
    const result = auditDictionary(db);
    assert.equal(result.ok, false);
    assert.equal(result.entries, 4);
    assert.equal(result.invalidTopics, 1);
    assert.equal(result.duplicateTopics, 1);
    assert.equal(result.invalidDefinitions, 1);
    assert.equal(result.hasTopicIndex, false);
    assert.ok(result.errors.some((e) => /Duplicate topic/.test(e)));
    assert.ok(result.warnings.some((e) => /index/.test(e)));
  } finally {
    db.close();
  }
});

test('warning-only missing rights metadata does not imply permission to publish', async () => {
  const db = await database();
  try {
    db.run("INSERT INTO dictionary VALUES ('H7225', '<p>First</p>')");
    const result = auditDictionary(db);
    assert.equal(result.ok, true);
    assert.equal(result.hasLicense, false);
    assert.ok(result.warnings.some((w) => /No license metadata/.test(w)));
    assert.ok(result.warnings.some((w) => /origin/.test(w)));
  } finally {
    db.close();
  }
});

test('reject empty module; continue to allow supplementary MyBible tables', async () => {
  const db = await database();
  try {
    assert.equal(auditDictionary(db).ok, false);
    db.run('CREATE TABLE words (standard_form TEXT, variation TEXT)');
    db.run("INSERT INTO dictionary VALUES ('H7225', '<p>beginning</p>')");
    assert.equal(auditDictionary(db).ok, true);
  } finally {
    db.close();
  }
});
