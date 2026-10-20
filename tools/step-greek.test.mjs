import test from 'node:test';
import assert from 'node:assert/strict';
import { SQL } from './common.mjs';
import { parseTagntGreek, writeTagntDatabase } from './step-greek.mjs';

const canon = {
  '470': [25],
  '480': [45],
  '490': [80],
  '500': [51],
};
// Synthetic parser fixtures are NOT a reconstruction or transcription of Biblical text.
const data = [
  'Word & Type\tGreek\tEnglish\tdStrong=Grammar\tlemma=Gloss\teditions',
  'Mat.1.1#01=NKO\tλόγος (logos)\tword\tG3056=N-NSM\tλόγος=word\tNA28+SBL+WH',
  'Mat.1.1#02=NKO\tθεός (theos)\tGod\tG2316G=N-NSM\tθεός=God\tSBL+TR',
  'Mat.1.1#03=NKO\tαὐτός (autos)\the\tG0846=P-NSM\tαὐτός=he\tTR+Byz',
  'Mrk.1.1#01=NKO\tἄνθρωπος (anthropos)\tperson\tG0444=N-NSM\tperson\tSBL',
  'Luk.1.1#01=NKO\tἀγαπάω (agapao)\tlove\tG0025=V-PAI-1S\tlove\tSBL',
  'Jhn.1.1#01=NKO\tἀγάπη (agape)\tlove\tG0026=N-NSF\tlove\tSBL',
].join('\n');

test('select SBL-tagged rows only, keep raw dStrong and morphology, never infer alignment', () => {
  const result = parseTagntGreek(data, canon);
  assert.equal(result.stats.kept, 5);
  assert.equal(result.stats.excluded, 1);
  assert.deepEqual(result.stats.books, [470, 480, 490, 500]);
  assert.equal(result.rows[0].surface, 'λόγος');
  assert.equal(result.rows[1].strong, 'G2316G'); // extended tag NOT collapsed
  assert.equal(result.rows[1].morphology, 'N-NSM');
  assert.equal(result.rows[1].sourceRef, 'Mat.1.1#02=NKO');
  assert.equal(result.rows.find((r) => r.surface === 'αὐτός'), undefined);
});

test('reject duplicate positions or invalid canonical book/verse', () => {
  const a = data.split('\n');
  assert.throws(() => parseTagntGreek([...a, a[1]].join('\n'), canon), /Duplicate SBL/);
  assert.throws(() => parseTagntGreek('Mat.1.99#01=NKO\tλόγος\tword\tG3056=N\tgloss\tSBL', canon),
    /Invalid SBL verse/);
  assert.throws(() => parseTagntGreek('Act.1.1#01=NKO\tλόγος\tword\tG3056=N\tgloss\tSBL', canon),
    /Invalid SBL verse/);
});

test('SQLite schema roundtrips selected words and supports safe references', async () => {
  const parsed = parseTagntGreek(data, canon);
  const sql = await SQL();
  const bytes = writeTagntDatabase(sql, parsed);
  const db = new sql.Database(new Uint8Array(bytes));
  try {
    assert.equal(db.exec('PRAGMA quick_check')[0].values[0][0], 'ok');
    const query = db.prepare(
      'SELECT position,surface,strong_tag,morphology FROM tagnt_tokens WHERE book_number=? AND chapter=? AND verse=? ORDER BY position'
    );
    try {
      query.bind([470, 1, 1]);
      const rows = [];
      while (query.step()) rows.push(query.get());
      assert.deepEqual(rows, [
        [1, 'λόγος', 'G3056', 'N-NSM'],
        [2, 'θεός', 'G2316G', 'N-NSM'],
      ]);
    } finally { query.free(); }
    assert.equal(db.exec("SELECT COUNT(*) FROM tagnt_tokens")[0].values[0][0], 5);
    assert.equal(db.exec("SELECT value FROM info WHERE name='license'")[0].values[0][0], 'CC BY 4.0');
  } finally { db.close(); }
});
