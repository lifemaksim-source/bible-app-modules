import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { root } from './common.mjs';
import { parseTahotLines } from './step-hebrew.mjs';
import { BOOK_GROUPS, validateBookGroups, validateSourceCoverage } from './step-hebrew-rest.mjs';

const books = JSON.parse(fs.readFileSync(path.join(root, 'canon/books.json'), 'utf8'));
const chapters = JSON.parse(fs.readFileSync(path.join(root, 'canon/eng.json'), 'utf8')).books;
const synthetic = (ref) =>
  'TAHOT synthetic\n' +
  'Eng (Heb) Ref & Type\tHebrew\tTransliteration\tTranslation\tdstrongss\tGrammar\tMeaning Variants\tSpelling Variants\n' +
  ref + '\tדָּבָר\tdabar\tword\tH1697\tHNcmsa\t\t\t1\t2\t3\t4\t5\t6\t7\t8\t9';

test('source groups cover all 39 canonical Protestant OT books exactly once', () => {
  assert.equal(validateBookGroups(BOOK_GROUPS, books), 39);
  const duplicated = { ...BOOK_GROUPS, 'Job-Sng': { ...BOOK_GROUPS['Job-Sng'], Xyz: 60 } };
  assert.throws(() => validateBookGroups(duplicated, books), /Unknown\/duplicated/);
  assert.throws(() => validateBookGroups({ ...BOOK_GROUPS, 'Isa-Mal': {} }, books), /Empty/);
});

test('numbered Hebrew book codes are recognized, including 1Sa and 2Ch', () => {
  const p = parseTahotLines(
    synthetic('1Sa.1.1#501=Q(K)') + '\n' +
    '2Ch.1.1#02=L\tשָׁלוֹם\tshalom\tpeace\tH7965\tHNcmsa\t\t',
    { '1Sa': 90, '2Ch': 140 }
  );
  assert.deepEqual(p.stats.books, [90, 140]);
  assert.equal(p.rows[0].source_ref, '1Sa.1.1#501=Q(K)');
  assert.equal(p.rows[0].position, 501); // source marker, not guaranteed word position
  assert.equal(p.rows[0].extra_columns, JSON.stringify(['1','2','3','4','5','6','7','8','9']));
});

test('coverage check requires every chapter, refuses unexpected chapters and TSV widths', () => {
  const fake = parseTahotLines(synthetic('1Sa.1.1#01=L'), { '1Sa': 90 });
  const expected = { '90': [2] };
  assert.deepEqual(validateSourceCoverage(fake, { '1Sa': 90 }, expected, 'one-chapter-fixture'), {
    books: 1, chapters: 1,
  });
  assert.throws(() =>
    validateSourceCoverage(fake, { '1Sa': 90 }, { '90': [2, 2] }, 'fixture'),
  /missing chapter 2/);
  assert.throws(() =>
    validateSourceCoverage(fake, { '2Sa': 100 }, expected, 'fixture'),
  /missing or unexpected books/);
  fake.stats.columnWidths = { 16: 1 };
  assert.throws(() =>
    validateSourceCoverage(fake, { '1Sa': 90 }, expected, 'fixture'),
  /unexpected TSV field count/);
});

test('all OT canonical chapter mappings are present', () => {
  for (const group of Object.values(BOOK_GROUPS))
    for (const book of Object.values(group)) {
      assert.ok(Array.isArray(chapters[String(book)]), 'Missing chapter count for book ' + book);
    }
});
