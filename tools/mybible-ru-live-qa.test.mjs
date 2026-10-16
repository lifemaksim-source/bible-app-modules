import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl, dictionaryOrCommentaryMember, inspectWordForms } from './mybible-ru-live-qa.mjs';
import { SQL } from './common.mjs';

const registry = {
  hosts: [
    { alias: 'mz', path: 'https://mybible.zone/repository/modules/%s.zip' },
    { alias: 'bad', path: 'https://evil.invalid/%s' },
  ],
  downloads: [
    { lng: 'ru', fil: 'Имена.dictionary', url: ['{bad}not-safe', '{mz}%D0%98%D0%BC%D0%B5%D0%BD%D0%B0.dictionary'] },
  ],
};

test('only official HTTPS MyBible URLs may be used', () => {
  assert.equal(moduleUrl(registry, 'Имена.dictionary'),
    'https://mybible.zone/repository/modules/%D0%98%D0%BC%D0%B5%D0%BD%D0%B0.dictionary.zip');
  assert.throws(() => moduleUrl(registry, 'other.dictionary'), /not in Russian/);
  const invalid = {
    hosts: [{ alias: 'mz', path: 'https://evil.invalid/repository/modules/%s.zip' }],
    downloads: [{ lng: 'ru', fil: 'Имена.dictionary', url: ['{mz}file'] }],
  };
  assert.throws(() => moduleUrl(invalid, 'Имена.dictionary'), /no usable trusted/);
});

test('correct archive member chosen when there are multiple SQLite sidecars', () => {
  assert.equal(dictionaryOrCommentaryMember(
    ['RST.SQLite3', 'nested/Имена.dictionary.SQLite3', 'other.commentaries.SQLite3'], 'Имена.dictionary'),
  'nested/Имена.dictionary.SQLite3');
  assert.equal(dictionaryOrCommentaryMember(['.SQLite3'], 'БТ-к.commentaries'), '.SQLite3');
  assert.throws(() => dictionaryOrCommentaryMember(['RST.SQLite3'], 'БТ-к.commentaries'),
    /member absent/);
});


test('standalone wordforms database works without dictionary articles', async () => {
  const db = new (await SQL()).Database();
  try {
    db.run('CREATE TABLE words (standard_form TEXT, variation TEXT)');
    db.run('CREATE INDEX variation_index ON words (variation)');
    db.run('INSERT INTO words VALUES (?, ?)', ['Бог', 'Бога']);
    db.run('INSERT INTO words VALUES (?, ?)', ['человек', 'людей']);
    const report = inspectWordForms(db);
    assert.equal(report.entries, 2);
    assert.equal(report.exactLookup, true);
    assert.equal(report.hasDictionary, false);
    assert.equal(report.invalidRows, 0);
    assert.equal(report.indexedVariation, true);
  } finally {
    db.close();
  }
});

test('reject malformed or empty wordforms tables', async () => {
  const db = new (await SQL()).Database();
  try {
    assert.throws(() => inspectWordForms(db), /Missing MyBible words/);
    db.run('CREATE TABLE words (standard_form TEXT, variation TEXT)');
    assert.throws(() => inspectWordForms(db), /Empty MyBible wordforms/);
    db.run("INSERT INTO words VALUES ('Бог', '')");
    assert.throws(() => inspectWordForms(db), /Invalid MyBible wordform rows/);
  } finally {
    db.close();
  }
});
