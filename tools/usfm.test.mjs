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

import { checkCrossrefs, parseCrossrefs, parseOsis } from './crossrefs.mjs';

test('crossrefs: OSIS references and ranges', () => {
  assert.deepEqual(parseOsis('Ps.23.1'), { book: 230, chapter: 23, verse: 1 });
  assert.deepEqual(parseOsis('1John.4.8'), { book: 690, chapter: 4, verse: 8 });
  assert.equal(parseOsis('Tob.1.1'), null);
  const { rows, dropped } = parseCrossrefs('From Verse\tTo Verse\tVotes\nGen.1.1\tProv.8.22-Prov.8.30\t59\nGen.1.1\tJohn.1.1\t-3\nGen.1.1\tPs.33.6-Ps.34.2\t5\n');
  assert.equal(dropped.votes, 1);
  assert.deepEqual(rows[0], [10, 1, 1, 240, 8, 22, 8, 30, 59]);
  assert.deepEqual(rows[1], [10, 1, 1, 230, 33, 6, 34, 2, 5]);
});


test('crossrefs: rejects bad range ends, reversed spans and malformed references', () => {
  const { rows, dropped } = parseCrossrefs([
    'Gen.1.1\tProv.8.22-Prov.8.30\t10', // valid
    'Gen.1.1\tProv.8.22-Prov.8.999\t9', // nonexistent endpoint
    'Gen.1.1\tProv.8.30-Prov.8.22\t8', // reversed within a chapter
    'Gen.1.1\tPs.33.6-Ps.34.2\t7', // valid cross-chapter range
    'Gen.1.1\tPs.34.2-Ps.33.6\t6', // reversed across chapters
    'Gen.1.1\tProv.8.22-Prov.9.999\t5', // nonexistent end chapter verse
    'Gen.0.1\tJohn.1.1\t4', // nonexistent source
    'Gen.1.1\tProv.8.22-Prov.8.30-Prov.8.31\t3', // more than one dash
    'Gen.1.1\tProv.8.22-\t2', // missing range end
  ].join('\n'));
  assert.equal(dropped.unknown, 2);
  assert.equal(rows.length, 7);
  assert.deepEqual(checkCrossrefs([rows[0], rows[3]]), []);
  const errors = checkCrossrefs(rows);
  assert.equal(errors.length, 5);
  assert.match(errors[0], /нет конца диапазона.*240 8:999/);
  assert.match(errors[1], /обратный диапазон.*240 8:30/);
  assert.match(errors[2], /обратный диапазон.*230 34:2/);
  assert.match(errors[3], /нет конца диапазона.*240 9:999/);
  assert.match(errors[4], /нет стиха 10 0:1/);
});

import { parseFb2, plain, roman } from './lopukhin.mjs';

test('lopukhin: verses, ranges, introductions', () => {
  assert.equal(roman('XIV'), 14);
  assert.equal(roman('22'), 22);
  assert.equal(plain('(<a xlink:href="#n03" type="note">Лк III:34</a>) текст [<a xlink:href="#n42" type="note">42</a>] &amp; ещё'), '(Лк III:34) текст & ещё');
  const fb2 = `<?xml version="1.0" encoding="utf-8"?><FictionBook><body>
<title><p>Книга пророка Ионы</p></title><section><title><p>О книге</p></title><p>Введение.</p></section>
<section><title><p>Глава I</p></title><p>О главе.</p>
<poem><stanza><v id="n32-Jona_I_1"><strong>1. И было слово</strong></v></stanza></poem>
<p>1. «И было» — так начинаются.</p><p>Второй абзац.</p>
<cite><p id="n32-Jona_I_2"><strong>2. Встань</strong></p><p id="n32-Jona_I_3"><strong>3. И встал</strong></p></cite>
<p>2 и 3. Про два стиха.</p></section>
<section><title><p>Глава II</p></title><poem><stanza><v id="n32-Jona_II_1"><strong>1.</strong></v></stanza></poem><p>1. Кит.</p></section>
</body><body name="notes"><section><p>сноска</p></section></body></FictionBook>`;
  const { entries, codes } = parseFb2(fb2);
  assert.deepEqual([...codes], ['Jona']);
  assert.deepEqual(entries.map((e) => [e.chapter, e.verse, e.chapterTo, e.verseTo, e.paras.join(' | ')]), [
    [0, 0, 0, 0, 'Введение.'],
    [1, 0, 1, 0, 'О главе.'],
    [1, 1, 1, 1, '«И было» — так начинаются. | Второй абзац.'],
    [1, 2, 1, 3, 'Про два стиха.'],
    [2, 1, 2, 1, 'Кит.'],
  ]);
});

import { topic, wordsOfBook } from './strongs.mjs';

test('strongs: words with numbers per verse', () => {
  assert.equal(topic('H0512'), 'H512');
  assert.equal(topic('G26'), 'G26');
  const usfm = '\\id GEN\n\\c 1\n\\p\n\\v 1 In the \\w beginning|strong="H7225"\\w* \\w God|strong="H0430"\\w* \\w created|strong="H1254 H0853"\\w*.\\f + \\fr 1.1 \\ft note\\f*\n\\v 2 And the earth.\n';
  const w = wordsOfBook(usfm, 10);
  assert.deepEqual(w.get(10001001), [['beginning', 'H7225'], ['God', 'H430'], ['created', 'H1254 H853']]);
  assert.equal(w.has(10001002), false);
});

test('lopukhin: one-chapter books have ids without a chapter', () => {
  const { entries } = parseFb2('<FictionBook><body><section><title><p>ГЛАВА I</p></title><poem><stanza><v id="n25-Phm_1"><cite><strong>1. Павел</strong></cite></v></stanza></poem><p>1. Узник.</p></section></body></FictionBook>');
  assert.deepEqual(entries.map((e) => [e.code, e.chapter, e.verse, e.paras[0]]), [['Phm', 1, 1, 'Узник.']]);
});
