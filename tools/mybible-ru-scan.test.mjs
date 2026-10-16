import test from 'node:test';
import assert from 'node:assert/strict';
import { russianModuleMetadata } from './mybible-ru-scan.mjs';

test('identifies only visible Russian dictionary and commentary metadata', () => {
  const sample = { downloads: [
    { fil: 'Брокгауз.dictionary', abr: 'Брокг', lng: 'ru', des: 'Библейский <b>словарь</b>', siz: '1.5M', url: ['{mz}…'] },
    { fil: 'Лопухин.commentaries', abr: 'Лоп', lng: 'ru', des: 'Толкования', siz: '20M', url: ['{mz}…'] },
    { fil: 'EN.dictionary', lng: 'en', des: 'English dictionary' },
    { fil: 'hidden.dictionary', lng: 'ru', hid: true, des: 'Hidden' },
    { fil: 'RST', lng: 'ru', des: 'Bible' },
    { fil: 'Брокгауз.dictionary', abr: 'duplicate', lng: 'ru' },
    { fil: 'strange.dictionary', lng: 3, des: 'Not a string' },
    { fil: 'no-filename', lng: 'ru', des: 'Unrelated' },
  ] };
  const result = russianModuleMetadata(sample);
  assert.equal(result.dictionary.length, 1);
  assert.equal(result.commentary.length, 1);
  assert.deepEqual(result.dictionary[0], {
    file: 'Брокгауз.dictionary', code: 'Брокг', name: 'Библейский словарь',
    size: '1.5M', hasRightsMetadata: false, downloadListed: true,
  });
  assert.equal(result.commentary[0].file, 'Лопухин.commentaries');
});

test('a license metadata field does not translate into permission to redistribute', () => {
  const result = russianModuleMetadata({ downloads: [
    { fil: 'MOD.dictionary', lng: 'ru', license: 'Unknown assertion', url: [] },
  ] });
  assert.equal(result.dictionary[0].hasRightsMetadata, true);
  assert.equal(result.dictionary[0].downloadListed, false);
});

test('rejects missing registry downloads instead of silently reporting empty library', () => {
  assert.throws(() => russianModuleMetadata(null), /Unsupported registry/);
  assert.throws(() => russianModuleMetadata({ modules: [] }), /Unsupported registry/);
});
