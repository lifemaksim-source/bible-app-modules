import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBook } from './usfm.mjs';
import { sourceLabels, missingReason } from './numbering-audit.mjs';
import { unpublished, assertNumberingForPublication } from './source-policy.mjs';

test('range labels distinguish combined text from an absent source number', () => {
  const source = '\\id LUK\n\\c 22\n\\v 43-44 Combined text.\n\\v 45 Following text.';
  const parsed = parseBook(source);
  const labels = sourceLabels(source);
  assert.equal(parsed.verses.get('22:43'), 'Combined text.');
  assert.equal(parsed.verses.has('22:44'), false);
  assert.deepEqual(missingReason('22:44', parsed, labels), { kind: 'verse-bridge', source: '22:43-44' });
  assert.deepEqual(missingReason('22:46', parsed, labels), { kind: 'no-source-label' });
});

test('footnote-only and empty source labels are not classified as absent labels', () => {
  const source = '\\id MAT\n\\c 23\n\\v 13 Text.\n\\v 14 \\f + \\ft A variant retained in the note.\\f*\n\\v 15\n\\v 16 Text.';
  const parsed = parseBook(source);
  const labels = sourceLabels(source);
  assert.deepEqual(missingReason('23:14', parsed, labels), { kind: 'notes-only' });
  assert.deepEqual(missingReason('23:15', parsed, labels), { kind: 'empty-source-label' });
  assert.deepEqual(parsed.notes.get('23:14'), ['A variant retained in the note.']);
});

test('deferred sources stay unpublished even if draft is removed', () => {
  assert.equal(unpublished({ deferred: 'source incomplete', draft: false }), true);
  assert.equal(unpublished({ draft: true }), true);
  assert.equal(unpublished({}), false);
});

test('removing draft cannot publish a known incompatible numbering', () => {
  const source = { id: 'example', numbering: 'eng', numberingReview: 'custom-map-required' };
  assert.throws(() => assertNumberingForPublication(source), /требуется отдельная таблица/);
  assert.doesNotThrow(() => assertNumberingForPublication({ ...source, draft: true }));
  assert.doesNotThrow(() => assertNumberingForPublication({ ...source, numberingReview: 'exact-coordinates' }));
});
