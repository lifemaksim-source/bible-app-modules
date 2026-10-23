// Minimal fixture tests: no dictionary text or network required.
// Run: node --test tools/inspect-dictionary.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import initSqlJs from 'sql.js';

const script = fileURLToPath(new URL('./inspect-dictionary.mjs', import.meta.url));

test('inspector reads SQLite metadata without exposing article content', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE dictionary (topic TEXT, definition TEXT)');
  db.run('INSERT INTO dictionary VALUES (?, ?)', ['Test topic', 'PRIVATE_FIXTURE_BODY']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictionary-check-'));
  const file = path.join(dir, 'fixture.SQLite3');
  try {
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
    const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.integrity, 'ok');
    assert.equal(report.tables[0].name, 'dictionary');
    assert.equal(report.tables[0].rows, 1);
    assert.deepEqual(report.tables[0].columns.map((c) => c.name), ['topic', 'definition']);
    assert.equal(run.stdout.includes('PRIVATE_FIXTURE_BODY'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspector rejects a non-SQLite file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictionary-check-'));
  const file = path.join(dir, 'invalid.db');
  try {
    fs.writeFileSync(file, 'not sqlite');
    const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Not a SQLite 3 database/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
