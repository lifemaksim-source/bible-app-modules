import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { validateDiscovery } from './check-language-discovery.mjs';

const source = JSON.parse(fs.readFileSync(new URL('../docs/language-module-discovery.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(source);

test('language candidate registry is structurally valid', () => {
  assert.deepEqual(validateDiscovery(source), []);
  assert.ok(source.records.some(x => x.language === 'tg' && x.verification === 'sqlite_built_checked_not_android'));
  assert.ok(source.records.some(x => x.language === 'mn' && x.sourceKind === 'mybible_catalog_listing'));
});

test('duplicate and malformed module candidates are rejected', () => {
  const data = clone();
  data.records.push(structuredClone(data.records[0]));
  assert.match(validateDiscovery(data).join(' '), /duplicate id/);
});

test('discovery listing cannot masquerade as a validated download', () => {
  const data = clone();
  const candidate = data.records.find(x => x.verification === 'listing_only');
  candidate.downloaded = true;
  candidate.sqliteChecked = true;
  candidate.published = true;
  assert.match(validateDiscovery(data).join(' '), /downloaded\/sqliteChecked/);
  assert.match(validateDiscovery(data).join(' '), /may not be published/);
});

test('the required priority languages cannot be silently removed', () => {
  const data = clone();
  data.records = data.records.filter(x => x.language !== 'mn');
  assert.match(validateDiscovery(data).join(' '), /Missing required priority language: mn/);
});

test('seven official MyBible modules have real SQLite evidence', () => {
  const rows = source.records.filter(x => x.verification === 'sqlite_source_verified_not_android' && ['tg', 'mn'].includes(x.language));
  assert.equal(rows.length, 7);
  assert.ok(source.records.some(x => x.id === 'mybible-dar-drg' && x.booksChecked === 1 && x.verseRowsChecked === 1068));
  assert.equal(rows.filter(x => x.language === 'tg').length, 4);
  assert.equal(rows.filter(x => x.language === 'mn').length, 3);
  assert.ok(rows.some(x => x.id === 'mybible-mn-ab2013' && x.booksChecked === 66));
  assert.ok(rows.some(x => x.id === 'mybible-tj-km92' && x.booksChecked === 66));
  assert.ok(rows.every(x => x.downloaded && x.sqliteChecked && !x.published && !x.androidChecked));
  assert.equal(rows.find(x => x.id === 'mybible-tj-kmo16')?.claimedScope, 'partial'); // mixed OT/NT, not 27 NT books
});

test('official MyBible evidence may not contain an invented hash or missing check results', () => {
  const data = clone();
  const official = data.records.find(x => x.sourceKind === 'mybible_official_registry');
  official.sha256 = '0'.repeat(63);
  official.downloadUrl = 'https://example.com/fake.zip';
  official.booksChecked = 0;
  assert.match(validateDiscovery(data).join(' '), /missing official downloaded SQLite evidence/);
});

test('IBT digital sources are only candidates until text and verse mapping verified', () => {
  const sources = source.records.filter(x => x.sourceKind === 'digital_ebook_listing');
  assert.equal(sources.length, 5);
  assert.deepEqual(new Set(sources.map(x => x.language)), new Set(['tab', 'lbe', 'inh', 'gag', 'dng']));
  assert.ok(sources.every(x => x.verification === 'listing_only' && !x.downloaded && !x.published));
  const data = clone();
  const candidate = data.records.find(x => x.sourceKind === 'digital_ebook_listing');
  candidate.digitalDownloadUrl = 'https://not-trusted.example/forged.fb2.zip';
  assert.match(validateDiscovery(data).join(' '), /invalid or prematurely promoted digital eBook source/);
});
