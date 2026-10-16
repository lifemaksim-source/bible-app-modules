import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl, dictionaryOrCommentaryMember } from './mybible-ru-live-qa.mjs';

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
