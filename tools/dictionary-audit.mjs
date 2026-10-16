// Offline, read-only quality audit for MyBible .dictionary.SQLite3 / .db files.
// This checks technical compatibility; it NEVER grants redistribution rights.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQL } from './common.mjs';

const number = (value) => typeof value === 'number' ? value : 0;
const queryRows = (db, sql) => db.exec(sql)[0]?.values ?? [];
const scalar = (db, sql) => queryRows(db, sql)[0]?.[0] ?? null;

/**
 * Audits a loaded SQLite database without modifying it or exposing article text.
 * @param {import('sql.js').Database} db
 */
export function auditDictionary(db) {
  const errors = [];
  const warnings = [];
  const result = {
    ok: false, entries: 0, invalidTopics: 0, invalidDefinitions: 0,
    duplicateTopics: 0, hasTopicIndex: false, hasLicense: false,
    hasAttribution: false, hasSource: false, errors, warnings,
  };

  // Invalid SQLite pages must be caught before touching other tables.
  try {
    const integrity = scalar(db, 'PRAGMA quick_check');
    if (integrity !== 'ok') {
      errors.push('SQLite quick_check failed');
      return result;
    }
  } catch {
    errors.push('SQLite quick_check could not be completed');
    return result;
  }

  const tables = new Set(queryRows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map(([n]) => n));
  if (!tables.has('dictionary')) {
    errors.push('Missing MyBible dictionary table');
    return result;
  }

  const fields = new Set(queryRows(db, 'PRAGMA table_info(dictionary)').map(([, name]) => name));
  if (!fields.has('topic') || !fields.has('definition')) {
    errors.push('dictionary must have topic and definition columns');
    return result;
  }

  const stats = queryRows(db, `SELECT COUNT(*),
    COALESCE(SUM(CASE WHEN typeof(topic) != 'text' OR TRIM(topic) = '' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN typeof(definition) != 'text' THEN 1 ELSE 0 END), 0)
    FROM dictionary`)[0] ?? [];
  result.entries = number(stats[0]);
  result.invalidTopics = number(stats[1]);
  result.invalidDefinitions = number(stats[2]);
  result.duplicateTopics = number(scalar(db, `SELECT COUNT(*) FROM (
    SELECT topic FROM dictionary WHERE topic IS NOT NULL GROUP BY topic HAVING COUNT(*) > 1
  )`));

  if (!result.entries) errors.push('Dictionary has no articles');
  if (result.invalidTopics) errors.push(`Invalid/empty topics: ${result.invalidTopics}`);
  if (result.invalidDefinitions) errors.push(`Non-text/NULL definitions: ${result.invalidDefinitions}`);
  if (result.duplicateTopics) errors.push(`Duplicate topic keys: ${result.duplicateTopics}`);

  // The app performs exact topic lookups and prefix searches. No index is
  // technically required, but its absence can make a large offline dictionary slow.
  const plan = queryRows(db, "EXPLAIN QUERY PLAN SELECT definition FROM dictionary WHERE topic = 'G1'")
    .map((row) => String(row[3] ?? '')).join(' ');
  result.hasTopicIndex = /USING (?:COVERING )?INDEX/i.test(plan);
  if (!result.hasTopicIndex) warnings.push('No usable index on dictionary.topic; lookups may be slow');

  if (!tables.has('info')) {
    warnings.push('No info table: source and rights metadata unavailable');
  } else {
    const infoFields = new Set(queryRows(db, 'PRAGMA table_info(info)').map(([, name]) => name));
    if (!infoFields.has('name') || !infoFields.has('value')) {
      warnings.push('Invalid info table; rights metadata cannot be assessed');
    } else {
      const infoRows = queryRows(db, "SELECT name, value FROM info WHERE name IN ('license', 'attribution', 'origin', 'homepage')");
      const info = new Map(infoRows);
      const present = (key) => typeof info.get(key) === 'string' && !!info.get(key).trim();
      result.hasLicense = present('license');
      result.hasAttribution = present('attribution');
      result.hasSource = present('origin') || present('homepage');
      if (!result.hasLicense) warnings.push('No license metadata: do not publish without rights review');
      if (!result.hasSource) warnings.push('No origin/homepage metadata');
    }
  }
  result.ok = errors.length === 0;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node tools/dictionary-audit.mjs /path/to/module.dictionary.SQLite3');
    process.exitCode = 2;
  } else {
    let db;
    try {
      // sql.js works fully offline and opens in memory; the input is not altered.
      db = new (await SQL()).Database(new Uint8Array(fs.readFileSync(input)));
      const audit = auditDictionary(db);
      console.log(JSON.stringify(audit, null, 2));
      if (!audit.ok) process.exitCode = 1;
    } catch (e) {
      console.error(`Cannot audit this SQLite file: ${e.message}`);
      process.exitCode = 1;
    } finally {
      db?.close();
    }
  }
}
