import test from 'node:test';
import assert from 'node:assert/strict';
import { SQL } from './common.mjs';
import { parseTahotLines, exportTahotSqlite } from './step-hebrew.mjs';

// Synthetic illustrative text only. No invented Biblical quotation or translation.
const lines = [
  'TAHOT Gen-Deu',
  '# description',
  'Eng (Heb) Ref & Type\tHebrew\tTransliteration\tTranslation\tdstrongss\tGrammar\tMeaning Variants\tSpelling Variants',
  'Gen.1.1#01=L\tבְּ/רֵאשִׁית\tbə/rešīt\tin/beginning\tH9001/H7225\tHR/HNcfsa\t\t',
  'Gen.1.1#501=Q(K)\tאֱלֹהִים\telohim\tGod\tH0430\tHNcmpa\tK=source-variant\tL=spelling-variant',
  'Exo.2.2#01=K(Q)\tמֹשֶׁה\tmoshe\tMoses\tH4872\tHNp\t\t',
  'Lev.1.1#01=L\tוַיִּקְרָא\twayiqra\tand he called\tH7121\tHV\t\t',
  'Num.1.1#01=L\tדָּבָר\tdabar\tword\tH1697\tHNcmsa\t\t',
  'Deu.1.1#01=L\tאֲמָרִים\tamarim\twords\tH0561\tHNcmpa\t\t',
].join('\n');

test('TAHOT preserves all source fields and explicit Qere/Ketiv indicators without guessing', () => {
  const result = parseTahotLines(lines);
  assert.equal(result.stats.rows, 6);
  assert.deepEqual(result.stats.books, [10,20,30,40,50]);
  assert.equal(result.stats.verses, 5);
  assert.equal(result.stats.meaningVariants, 1);
  assert.equal(result.stats.spellingVariants, 1);
  assert.equal(result.stats.qereRefs, 2); // source labels include Q(K) and K(Q)
  assert.equal(result.stats.ketivRefs, 2); // counts K present anywhere, not primary readings
  assert.equal(result.stats.malformed, 0);
  assert.equal(result.rows[0].surface, 'בְּ/רֵאשִׁית');
  assert.equal(result.rows[0].strong_tags, 'H9001/H7225');
  assert.equal(result.rows[1].source_ref, 'Gen.1.1#501=Q(K)');
  assert.equal(result.rows[1].meaning_variants, 'K=source-variant');
  assert.equal(result.rows[1].spelling_variants, 'L=spelling-variant');
});

test('unknown datasets and chapters outside the first five books are rejected', () => {
  assert.throws(() => parseTahotLines('TAGNT Greek'), /Not a TAHOT/);
  const other = lines + '\nPsa.1.1#01=L\tדָּבָר\tdabar\tword\tH1697\tHNcmsa';
  assert.throws(() => parseTahotLines(other), /outside selected-book/);
  const unreasonable = lines + '\nGen.0.1#01=L\tדָּבָר\tdabar\tword\tH1697\tHNcmsa';
  assert.throws(() => parseTahotLines(unreasonable), /outside selected-book/);
});

test('lossless SQLite keeps rows and source alternatives as separate columns', async () => {
  const sql = await SQL();
  const parsed = parseTahotLines(lines);
  const bytes = exportTahotSqlite(sql, parsed, {
    dataset: 'STEP TAHOT synthetic test',
    license: 'CC BY 4.0',
  });
  const db = new sql.Database(new Uint8Array(bytes));
  try {
    assert.equal(db.exec('PRAGMA quick_check')[0].values[0][0], 'ok');
    assert.equal(db.exec('SELECT COUNT(*) FROM tahot_rows')[0].values[0][0], 6);
    const stmt = db.prepare('SELECT surface,strong_tags,source_ref,meaning_variants,spelling_variants FROM tahot_rows WHERE book_number = ? AND chapter = ? AND verse = ? ORDER BY position');
    try {
      stmt.bind([10,1,1]);
      const results = [];
      while (stmt.step()) results.push(stmt.get());
      assert.equal(results[0][0], 'בְּ/רֵאשִׁית');
      assert.equal(results[1][1], 'H0430');
      assert.equal(results[1][2], 'Gen.1.1#501=Q(K)');
      assert.equal(results[1][3], 'K=source-variant');
      assert.equal(results[1][4], 'L=spelling-variant');
    } finally { stmt.free(); }
  } finally { db.close(); }
});


test('unrecognized TAHOT extra columns are preserved without interpreting their meaning', async () => {
  const sample = lines.split('\n').slice(0, 4).join('\n') +
    '\tfield8\tfield9\tfield10\tfield11\tfield12\tfield13\tfield14\tfield15\tfield16';
  const parsed = parseTahotLines(sample);
  assert.equal(parsed.stats.rows, 1);
  assert.equal(parsed.stats.columnWidths['17'], 1);
  assert.deepEqual(JSON.parse(parsed.rows[0].extra_columns),
    ['field8','field9','field10','field11','field12','field13','field14','field15','field16']);
  const sql = await SQL();
  const bytes = exportTahotSqlite(sql, parsed, { dataset: 'synthetic' });
  const db = new sql.Database(new Uint8Array(bytes));
  try {
    const value = db.exec('SELECT extra_columns FROM tahot_rows')[0].values[0][0];
    assert.equal(value, parsed.rows[0].extra_columns);
  } finally { db.close(); }
});
