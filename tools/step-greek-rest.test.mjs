import test from 'node:test';
import assert from 'node:assert/strict';
import { SQL } from './common.mjs';
import { parseTagntGreek, writeTagntDatabase } from './step-greek.mjs';
import { REST_NT_BOOKS, auditGreekVerseCoverage } from './step-greek-rest.mjs';

const lines = [
  'Act.1.1#01=NKO\tλόγος (logos)\tword\tG3056=N-NSM\tλόγος=word\tSBL+NA28',
  'Act.1.2#01=NKO\tθεός (theos)\tGod\tG2316G=N-NSM\tθεός=God\tSBL',
  'Rom.1.1#01=NKO\tχάρις (charis)\tgrace\tG5485=N-NSF\tχάρις=grace\tSBL',
  '1Co.1.1#01=NKO\tἀγάπη (agape)\tlove\tG0026=N-NSF\tἀγάπη=love\tSBL',
  '1Jn.1.1#01=NKO\tζωή (zoe)\tlife\tG2222=N-NSF\tζωή=life\tSBL',
  'Rev.1.1#01=NKO\tκύριος (kyrios)\tLord\tG2962=N-NSM\tκύριος=Lord\tSBL',
  'Rev.1.1#02=NKO\tλέγω (lego)\tsay\tG3004=V-PAI-1S\tλέγω=say\tTR+Byz',
].join('\n');

test('official source abbreviations cover Acts to Revelation, without the Gospels', () => {
  assert.equal(Object.keys(REST_NT_BOOKS).length, 23);
  assert.deepEqual(Object.values(REST_NT_BOOKS).sort((a,b)=>a-b),
    Array.from({ length: 23 }, (_,i)=>510+i*10));
  const canon = { '510': [2], '520': [1], '530': [1], '690': [1], '730': [1] };
  const parsed = parseTagntGreek(lines, canon, REST_NT_BOOKS);
  assert.equal(parsed.stats.kept, 6);
  assert.equal(parsed.stats.excluded, 1);
  assert.equal(parsed.rows[3].strong, 'G0026');
  assert.equal(parsed.rows[3].sourceRef, '1Co.1.1#01=NKO');
  assert.deepEqual(parsed.stats.books, [510,520,530,690,730]);
});

test('missing SBL verse is reported but never manufactured from TR', () => {
  const subset = { Act: 510, Rom: 520 };
  const canon = { '510': [2,1], '520': [1] };
  const parsed = parseTagntGreek(lines.split('\n').filter(l => /^Act\.|^Rom\./.test(l)).join('\n'), canon, subset);
  const checked = auditGreekVerseCoverage(parsed, canon, subset);
  assert.deepEqual(checked, {
    books: 2, chapters: 2, canonicalVerses: 4,
    annotatedVerses: 3, missingSourceVerses: ['510:2:1'],
  });
  assert.equal(parsed.rows.find(r=>r.chapter===2),undefined);
});

test('fails closed if any whole source chapter or book is missing', () => {
  const canon = { '510': [2,1] };
  const parsed = parseTagntGreek(lines.split('\n').filter(l => /^Act\./.test(l)).join('\n'), canon, {Act:510});
  assert.throws(() => auditGreekVerseCoverage(parsed, canon, {Act:510}), /Missing full source chapter/);
  assert.throws(() => auditGreekVerseCoverage(parsed, canon, {Act:510,Rom:520}),
    /missing or unexpected books/);
});

test('retains source-selected morphology and dataset scope in the local SQLite', async () => {
  const parsed = parseTagntGreek(lines.split('\n').filter(l => /^Act\./.test(l)).join('\n'), {'510':[2]}, {Act:510});
  const sql = await SQL();
  const bytes = writeTagntDatabase(sql, parsed, 'STEP Bible TAGNT Act–Rev (SBL edition flags)');
  const db = new sql.Database(new Uint8Array(bytes));
  try {
    assert.equal(db.exec('PRAGMA quick_check')[0].values[0][0], 'ok');
    assert.equal(db.exec("SELECT value FROM info WHERE name='dataset'")[0].values[0][0],
      'STEP Bible TAGNT Act–Rev (SBL edition flags)');
    assert.equal(db.exec('SELECT COUNT(*) FROM tagnt_tokens')[0].values[0][0], 2);
    const row=db.exec('SELECT strong_tag,morphology,source_ref FROM tagnt_tokens ORDER BY chapter')[0].values[0];
    assert.deepEqual(row, ['G3056','N-NSM','Act.1.1#01=NKO']);
  } finally { db.close(); }
});
