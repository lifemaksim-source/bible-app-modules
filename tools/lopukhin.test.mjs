import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES, coverage, parseFb2 } from './lopukhin.mjs';

const fb2 = (body, extra = '') => `<FictionBook><body name="Толкования">${body}</body>${extra}</FictionBook>`;
const verse = (id) => `<v id="${id}"><strong>Текст Библии</strong></v>`;

test('обычный стих: вступление главы и толкование, без текста цитаты', () => {
  const { entries } = parseFb2(fb2(`<title><p>Глава IV</p></title><p>Вступление</p>
    <poem>${verse('n01-Gen_IV_1')}</poem><p>1. <emphasis>Толкование</emphasis> стиха.</p>`));
  assert.deepEqual(entries.map((e) => [e.code, e.chapter, e.verse, e.paras]), [
    ['Gen', 4, 0, ['Вступление']], ['Gen', 4, 1, ['Толкование стиха.']],
  ]);
});

test('несколько стихов одной цитаты образуют диапазон', () => {
  const { entries } = parseFb2(fb2(`<cite>${verse('n01-Gen_I_7')}${verse('n01-Gen_I_8')}${verse('n01-Gen_I_9')}</cite>
    <p>7–9. Толкование диапазона.</p>`));
  assert.deepEqual(entries.map((e) => [e.chapter, e.verse, e.chapterTo, e.verseTo, e.paras]), [[1, 7, 1, 9, ['Толкование диапазона.']]]);
});

test('псалом с арабским номером главы', () => {
  const { entries } = parseFb2(fb2(`<title><p>Псалом 22</p></title><poem>${verse('n19-Ps_22_1')}</poem><p>Толкование псалма.</p>`));
  assert.deepEqual(entries.map((e) => [CODES[e.code], e.chapter, e.verse]), [[230, 22, 1]]);
});

test('общая статья к псалмам 134 и 135 привязана к обоим, даже если следующий якорь в 135-м', () => {
  for (const heading of ['Псалом 134–135', 'Псалмы 134 и 135', 'Псалмы CXXXIV–CXXXV']) {
    const { entries } = parseFb2(fb2(`<title><p>${heading}</p></title><cite>${verse('n19-Ps_134_1')}</cite>
      <title><p>Псалом 135</p></title><p>Оба псалма — торжественный гимн.</p>
      <cite>${verse('n19-Ps_135_1')}</cite>`));
    assert.deepEqual(entries.map((e) => [e.chapter, e.verse, e.chapterTo, e.verseTo]), [[134, 0, 135, 0]]);
    assert.equal(coverage(entries.map((e) => ({ ...e, book: 230 }))).covered, 2);
  }
});

test('примечания внутри основного body исключаются, все книги в одном FB2 сохраняются', () => {
  const body = (code, num, chapter, note) => `<body name="${code}"><section><title><p>Глава ${chapter}</p></title>
    <cite>${verse(`n${num}-${code}_${chapter}_1`)}</cite><p>Толкование ${code}.</p></section>
    <section><title><p>Примечания</p></title><p id="n${num}-${code}_${note}">Сноска</p><p>Продолжение сноски.</p>
      <section><p>Вложенное пояснение.</p></section></section></body>`;
  const { entries, codes } = parseFb2(`<FictionBook>${body('Gen','01','I',789)}${body('Isa','23','I',237)}${body('Jn','04','III',72)}</FictionBook>`);
  assert.deepEqual([...codes], ['Gen', 'Isa', 'Jn']);
  assert.deepEqual(entries.map((e) => [e.code, e.chapter, e.verse, e.paras]), [
    ['Gen',1,1,['Толкование Gen.']], ['Isa',1,1,['Толкование Isa.']], ['Jn',3,1,['Толкование Jn.']],
  ]);
});

test('вступление без стиховых якорей не переносится в следующий псалом и не теряется в конце', () => {
  const { entries } = parseFb2(fb2(`<cite>${verse('n19-Ps_51_1')}</cite><p>Толкование 51.</p>
    <title><p>Псалом 52</p></title><p>См. псалом 13.</p>
    <title><p>Псалом 53</p></title><cite>${verse('n19-Ps_53_1')}</cite><p>Толкование 53.</p>
    <title><p>Псалом 54</p></title><p>Общее толкование 54.</p>`));
  assert.deepEqual(entries.map((e) => [e.chapter, e.verse, e.paras]), [
    [51, 1, ['Толкование 51.']], [52, 0, ['См. псалом 13.']], [53, 1, ['Толкование 53.']], [54, 0, ['Общее толкование 54.']],
  ]);
});

test('Филимон: id без главы относится к единственной главе', () => {
  const { entries } = parseFb2(fb2(`<poem>${verse('n25-Phm_1')}</poem><p>1. Приветствие.</p>`));
  assert.deepEqual(entries.map((e) => [CODES[e.code], e.chapter, e.verse, e.paras]), [[640, 1, 1, ['Приветствие.']]]);
});

test('сноски в другом body не превращаются в шесть ложных стихов', () => {
  const notes = ['n01-Gen_789', 'n01-Gen_1095', 'n23-Isa_237', 'n23-Isa_544', 'n04-Jn_72', 'n04-Jn_174']
    .map((id) => `<p id="${id}">Сноска</p><p>Дополнение к сноске.</p>`).join('');
  for (const name of ['notes', 'Примечания', 'footnotes']) {
    const result = parseFb2(fb2(`<cite>${verse('n04-Jn_III_13')}</cite><p>Толкование.</p>`, `<body name="${name}">${notes}</body>`));
    assert.deepEqual(result.entries.map((e) => [e.code, e.chapter, e.verse]), [['Jn', 3, 13]]);
  }
});

test('комментарии ко всему псалму считаются покрытием главы', () => {
  const missingBefore = [52, 69, 97, 107, 116, 122, 133, 134, 135, 145];
  const all = Array.from({ length: 151 }, (_, i) => ({
    book: 230, chapter: i + 1, chapterTo: i + 1, verse: missingBefore.includes(i + 1) ? 0 : 1,
    verseTo: missingBefore.includes(i + 1) ? 0 : 1, paras: ['Толкование.'],
  }));
  const result = coverage(all);
  assert.equal(result.covered, 151);
  assert.deepEqual(result.invalid, []);
  assert.equal(result.warnings.some((w) => w.startsWith('PSA:')), false);
  assert.match(coverage(all.filter((e) => !missingBefore.includes(e.chapter))).warnings.find((w) => w.startsWith('PSA:')),
    /нет: 52, 69, 97, 107, 116, 122, 133, 134, 135, 145$/);
});

test('проверяются оба конца диапазона; неверные ссылки не дают покрытия', () => {
  const entry = { book: 10, chapter: 1, chapterTo: 1, verse: 1, verseTo: 1, paras: ['Толкование'] };
  for (const change of [{ verse: 789 }, { verseTo: 32 }, { chapterTo: 51 }, { verse: 4, verseTo: 3 }]) {
    const result = coverage([{ ...entry, ...change }]);
    assert.equal(result.invalid.length, 1);
    assert.equal(result.covered, 0);
  }
});
