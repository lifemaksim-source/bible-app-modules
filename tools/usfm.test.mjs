import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBook, inline } from './usfm.mjs';
import { validate } from './validate.mjs';

const GEN = String.raw`\id GEN World English Bible
\h Genesis
\c 1
\s1 The Beginning
\p
\v 1 \w In|strong="H7225"\w* the beginning, \nd God\nd* created the heavens and the earth.\f + \fr 1:1 \ft Or “in a beginning”\f*
\v 2 The earth was formless
\q1 and void,
\q2 and darkness was on the surface.
\v 3-4 Bridged \add text\add* here. \x - \xo 1:3 \xt Heb 11:3\x*
\c 2
\p
\v 1 \wj Words\wj* of Jesus.
`;

test('verses, headings, footnotes', () => {
  const b = parseBook(GEN);
  assert.equal(b.id, 'GEN');
  assert.equal(b.verses.get('1:1'), 'In the beginning, God created the heavens and the earth.');
  assert.equal(b.notes.get('1:1')[0], 'Or “in a beginning”');
  assert.equal(b.verses.get('1:2'), 'The earth was formless and void, and darkness was on the surface.');
  assert.equal(b.verses.get('1:3'), 'Bridged text here.');
  assert.equal(b.headings.get('1:1'), 'The Beginning');
  assert.equal(b.verses.get('2:1'), 'Words of Jesus.');
});

test('footnote over several lines', () => {
  const b = parseBook('\\id GEN\n\\c 1\n\\v 1 Text\\f + \\fr 1:1\n\\ft long note\\f* more\n\\v 2 Next');
  assert.equal(b.verses.get('1:1'), 'Text more');
  assert.equal(b.notes.get('1:1')[0], 'long note');
});

test('inline strips markers', () => {
  assert.equal(inline('\\w Lord|strong="H3068"\\w* said').text, 'Lord said');
});

test('validate: wrong numbering is an error', () => {
  // The Synodal Psalter has 151 psalms, the English one 150.
  const psa = new Map();
  for (let c = 1; c <= 150; c++) for (let v = 1; v <= 3; v++) psa.set(`${c}:${v}`, 'x');
  const r = validate(new Map([[230, psa]]), 'rus');
  assert.ok(r.errors.some((e) => e.startsWith('PSA')));
  assert.ok(!validate(new Map([[230, psa]]), 'eng').errors.some((e) => e.startsWith('PSA: глав')));
});

import { parseCrossrefs, parseOsis } from './crossrefs.mjs';

test('crossrefs: OSIS references and ranges', () => {
  assert.deepEqual(parseOsis('Ps.23.1'), { book: 230, chapter: 23, verse: 1 });
  assert.deepEqual(parseOsis('1John.4.8'), { book: 690, chapter: 4, verse: 8 });
  assert.equal(parseOsis('Tob.1.1'), null);
  const { rows, dropped } = parseCrossrefs('From Verse\tTo Verse\tVotes\nGen.1.1\tProv.8.22-Prov.8.30\t59\nGen.1.1\tJohn.1.1\t-3\nGen.1.1\tPs.33.6-Ps.34.2\t5\n');
  assert.equal(dropped.votes, 1);
  assert.deepEqual(rows[0], [10, 1, 1, 240, 8, 22, 8, 30, 59]);
  assert.deepEqual(rows[1], [10, 1, 1, 230, 33, 6, 34, 2, 5]);
});
