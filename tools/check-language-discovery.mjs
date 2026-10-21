// Safeguard: discoveries are not installed modules. Never use this file to publish catalog.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = new Set(['mybible_catalog_listing', 'prior_branch_report', 'existing_build_branch', 'digital_api_listing', 'mybible_official_registry', 'digital_ebook_listing', 'digital_epub_draft']);
const STATUSES = new Set(['listing_only', 'sqlite_built_checked_not_android', 'sqlite_source_verified_not_android', 'epub_draft_sqlite_checked_not_android']);

export function validateDiscovery(document) {
  const errors = [];
  if (document?.schemaVersion !== 1 || !Array.isArray(document.records)) {
    return ['Invalid discovery document'];
  }
  const ids = new Set();
  const languages = new Set();
  for (const [i, record] of document.records.entries()) {
    const context = `records[${i}]`;
    if (!record || typeof record !== 'object') { errors.push(`${context}: invalid record`); continue; }
    if (typeof record.id !== 'string' || !/^[a-z0-9-]+$/.test(record.id) || ids.has(record.id)) {
      errors.push(`${context}: invalid or duplicate id`);
    }
    ids.add(record.id);
    if (typeof record.language !== 'string' || !/^[a-z]{2,3}$/.test(record.language)) {
      errors.push(`${context}: invalid language code`);
    } else languages.add(record.language);
    for (const key of ['name', 'externalId', 'title', 'claimedScope']) {
      if (typeof record[key] !== 'string' || !record[key].trim()) errors.push(`${context}: missing ${key}`);
    }
    if (!TYPES.has(record.sourceKind)) errors.push(`${context}: unknown sourceKind`);
    if (!STATUSES.has(record.verification)) errors.push(`${context}: unknown verification`);
    try { if (new URL(record.sourceUrl).protocol !== 'https:') throw Error(); }
    catch { errors.push(`${context}: sourceUrl must be HTTPS`); }
    if (record.published !== false || record.androidChecked !== false) {
      errors.push(`${context}: unverified candidate may not be published or Android-verified`);
    }
    const built = record.verification === 'sqlite_built_checked_not_android';
    const official = record.verification === 'sqlite_source_verified_not_android';
    const epubDraft = record.verification === 'epub_draft_sqlite_checked_not_android';
    if (record.sourceKind === 'digital_ebook_listing' && (
      record.verification !== 'listing_only' ||
      typeof record.digitalDownloadUrl !== 'string' ||
      !/^https:\/\/ibtrussia\.org\/sites\/default\/files\/[^\s]+\.(?:fb2(?:\.zip)?|epub)$/.test(record.digitalDownloadUrl) ||
      !['fb2', 'fb2.zip', 'epub'].includes(record.digitalFormat)
    )) {
      errors.push(`${context}: invalid or prematurely promoted digital eBook source`);
    }
    if (built !== (record.sourceKind === 'existing_build_branch') ||
        official !== (record.sourceKind === 'mybible_official_registry') ||
        epubDraft !== (record.sourceKind === 'digital_epub_draft')) {
      errors.push(`${context}: sourceKind and verification do not match`);
    }
    if (record.downloaded !== (built || official || epubDraft) || record.sqliteChecked !== (built || official || epubDraft)) {
      errors.push(`${context}: downloaded/sqliteChecked must match evidence level`);
    }
    if (built && (!record.existingBranch || !Number.isInteger(record.booksChecked) || record.booksChecked < 1 ||
      !Number.isInteger(record.verseRowsChecked) || record.verseRowsChecked < 1)) {
      errors.push(`${context}: missing prior build evidence`);
    }
    if (epubDraft && (
      !/^https:\/\/ibtrussia\.org\/sites\/default\/files\/ebm\/ebook\/[^\s]+\.epub$/.test(record.digitalEpubUrl) ||
      !/^https:\/\/github\.com\/lifemaksim-source\/bible-app-modules\/actions\/runs\/\d+$/.test(record.evidenceRunUrl) ||
      !/^[a-f0-9]{64}$/.test(record.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(record.sqliteSha256) ||
      !Number.isInteger(record.booksChecked) || record.booksChecked < 1 ||
      !Number.isInteger(record.verseRowsChecked) || record.verseRowsChecked < 1 ||
      !Number.isInteger(record.blankVerseAnchors) || record.blankVerseAnchors < 0 ||
      !Number.isInteger(record.verseAnchors) || record.verseAnchors <= record.blankVerseAnchors ||
      record.licenseStatus !== 'not_cleared' || record.published !== false
    )) {
      errors.push(`${context}: missing EPUB draft-only conversion evidence or rights flag`);
    }
    if (official && (
      record.sourceUrl !== 'https://mybible.zone/repository/registry/registry.zip' ||
      !/^https:\/\/mybible\.zone\/repository\/modules\/[^\s]+\.zip$/.test(record.downloadUrl) ||
      !/^https:\/\/github\.com\/lifemaksim-source\/bible-app-modules\/actions\/runs\/\d+$/.test(record.evidenceRunUrl) ||
      !/^[0-9a-f]{64}$/.test(record.sha256) || !record.sqliteFile ||
      !Number.isInteger(record.registryVersion) || record.registryVersion < 1 ||
      !Number.isInteger(record.booksChecked) || record.booksChecked < 1 ||
      !Number.isInteger(record.verseRowsChecked) || record.verseRowsChecked < 1 ||
      !Number.isInteger(record.blankVerseRows) || record.blankVerseRows < 0
    )) {
      errors.push(`${context}: missing official downloaded SQLite evidence`);
    }
  }
  for (const language of ['tg', 'mn']) if (!languages.has(language)) errors.push(`Missing required priority language: ${language}`);
  return errors;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const filename = path.resolve(process.argv[2] ?? new URL('../docs/language-module-discovery.json', import.meta.url).pathname);
  const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const errors = validateDiscovery(document);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`OK: ${document.records.length} candidates across ${new Set(document.records.map(x => x.language)).size} languages; none authorized for publication.`);
  }
}
