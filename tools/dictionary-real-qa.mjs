// Integration QA against two authentic MyBible dictionary archives published on GitHub.
// Downloads only in ephemeral CI; NEVER commits archives, article text or release assets.
// Source: eliranwong/ETCBC-remix, pinned to a fixed upstream commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SQL } from './common.mjs';
import { auditDictionary } from './dictionary-audit.mjs';

const UPSTREAM = '7f5b8fa014b44689c34d40881f828b63ec382332';
const FIXTURES = [
  { name: 'ETCBC.dictionary.SQLite3', zipBytes: 6583184 },
  { name: 'ETCBC+.dictionary.SQLite3', zipBytes: 6476381 },
];
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;

/** Limit the download and fail closed if the upstream ZIP is unexpectedly replaced. */
async function download(name) {
  const url = `https://raw.githubusercontent.com/eliranwong/ETCBC-remix/${UPSTREAM}/MyBible/${encodeURIComponent(name)}.zip`;
  const response = await fetch(url, { headers: { 'user-agent': 'bible-app-modules QA (+https://github.com/lifemaksim-source/bible-app-modules)' }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_ZIP_BYTES) throw new Error(`${name}: archive too large`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ZIP_BYTES || bytes.subarray(0, 2).toString() !== 'PK') throw new Error(`${name}: invalid or oversized ZIP`);
  return bytes;
}

export async function validateRealDictionaries() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybible-audit-'));
  try {
    const SQLModule = await SQL();
    const reports = [];
    for (const fixture of FIXTURES) {
      const zipPath = path.join(temp, 'source.zip');
      const bytes = await download(fixture.name);
      // The exact file sizes are from the pinned GitHub tree, not from the registry
      // which may update module packages without advance notice.
      if (bytes.length !== fixture.zipBytes) throw new Error(`${fixture.name}: upstream archive size changed`);
      fs.writeFileSync(zipPath, bytes);
      const members = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8', timeout: 15_000 }).trim().split(/\r?\n/);
      const sqliteMembers = members.filter((entry) => /\.sqlite3$/i.test(entry) && !entry.endsWith('/'));
      // A real MyBible package may contain a main database plus one or more
      // supplement files. Select the named dictionary, never a random sibling.
      const chosen = sqliteMembers.find((entry) => path.posix.basename(entry).toLowerCase() === fixture.name.toLowerCase());
      if (!chosen) throw new Error(`${fixture.name}: expected dictionary not found; archive entries: ${sqliteMembers.map((e) => path.posix.basename(e)).join(', ')}`);
      const data = execFileSync('unzip', ['-p', zipPath, chosen], { maxBuffer: MAX_DATABASE_BYTES, timeout: 60_000 });
      if (data.length > MAX_DATABASE_BYTES || data.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
        throw new Error(`${fixture.name}: invalid or oversized SQLite`);
      }
      const db = new SQLModule.Database(new Uint8Array(data));
      let audit;
      try {
        audit = auditDictionary(db);
      } finally {
        db.close();
      }
      const summary = {
        module: fixture.name,
        entries: audit.entries,
        indexed: audit.hasTopicIndex,
        invalidTopics: audit.invalidTopics,
        duplicateTopics: audit.duplicateTopics,
        invalidDefinitions: audit.invalidDefinitions,
        licenseMetadata: audit.hasLicense,
        warnings: audit.warnings,
        errors: audit.errors,
      };
      // Crucially do not log raw dictionary records or store downloaded files as artifacts.
      console.log(JSON.stringify(summary));
      reports.push({ ...summary, ok: audit.ok });
      if (!audit.ok) throw new Error(`${fixture.name}: dictionary audit failed; see counts above`);
    }
    return reports;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    await validateRealDictionaries();
  } catch (error) {
    console.error('Real MyBible dictionary QA failed:', error.message);
    process.exitCode = 1;
  }
}
