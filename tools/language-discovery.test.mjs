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
