import test from 'node:test';
import assert from 'node:assert/strict';

import { SQL } from './common.mjs';
import { canonicalStrongNumber, verseStrongCounts, writeConcordance } from './concordance.mjs';

test('normalizes only valid Strong H/G identifiers without losing letter category', () => {
  assert.equal(canonicalStrongNumber('H07225'), 'H7225');
  assert.equal(canonicalStrongNumber('g0026'), 'G26');
  assert.equal(canonicalStrongNumber('G26a'), 'G26');
  for (const invalid of ['G0', 'H0000', 'H', 'B300', 'G26;DROP TABLE', 'G123456', null]) {
    assert.equal(canonicalStrongNumber(invalid), null);
  }
});

test('each tagged phrase counts once per distinct number, but repeated phrases count', () => {
  const hits = verseStrongCounts([
    ['God', 'H0430 H0853'],
    ['God', 'H430 H0430'],
    ['without token', ''],
    ['', 'H10'],
    ['created', 'H1254 invalid H1254'],
    ['other', 'G26'],
  ]);
  assert.deepEqual([...hits].sort(), [
    ['G26', 1], ['H1254', 1], ['H430', 2], ['H853', 1],
  ]);
});

test('SQLite index gives stable ordered pages, per-verse hit counts and totals', async () => {
  const db = new (await SQL()).Database();
  try {
    db.run('CREATE TABLE concordance (' +
      'topic TEXT NOT NULL, verse_id INTEGER NOT NULL, hits INTEGER NOT NULL CHECK(hits > 0),' +
      'PRIMARY KEY (topic, verse_id)) WITHOUT ROWID;');
    const verses = new Map([
      [10001003, [['God', 'H0430']]],
      [10001001, [
        ['beginning', 'H7225'],
        ['God', 'H0430 H0853'],
        ['God again', 'H0430'],
        ['repeat', 'H430 H0430'],
      ]],
    ]);
    db.run('BEGIN');
    const stats = writeConcordance(db, verses);
    db.run('COMMIT');
    assert.deepEqual(stats, { rows: 4, occurrences: 6 });
    assert.deepEqual(db.exec(
      "SELECT verse_id,hits FROM concordance WHERE topic='H430' ORDER BY verse_id"
    )[0].values, [[10001001, 3], [10001003, 1]]);
    assert.deepEqual(db.exec(
      "SELECT COUNT(*), SUM(hits) FROM concordance WHERE topic='H430'"
    )[0].values, [[2, 4]]);
    const stmt = db.prepare('SELECT verse_id FROM concordance WHERE topic = ? ORDER BY verse_id LIMIT ? OFFSET ?');
    try {
      stmt.bind(['H430', 1, 1]);
      assert.equal(stmt.step(), true);
      assert.deepEqual(stmt.get(), [10001003]);
      assert.equal(stmt.step(), false);
    } finally {
      stmt.free();
    }
    const plan = db.exec("EXPLAIN QUERY PLAN SELECT verse_id FROM concordance WHERE topic = 'H430'")[0].values;
    assert.match(String(plan[0][3]), /SEARCH concordance USING PRIMARY KEY/i);
  } finally {
    db.close();
  }
});

test('invalid verse addresses are rejected at index creation', async () => {
  const db = new (await SQL()).Database();
  try {
    db.run('CREATE TABLE concordance (topic TEXT, verse_id INTEGER, hits INTEGER)');
    assert.throws(() => writeConcordance(db, new Map([[0, [['God', 'H0430']]]])), /Invalid KJV verse/);
  } finally {
    db.close();
  }
});
