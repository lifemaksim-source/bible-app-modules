// Read ONLY the public MyBible module registry and summarize Russian-language
// dictionary/commentary metadata. Never download or publish the module texts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REGISTRIES = [
  'https://mybible.zone/repository/registry/registry.zip',
  'https://mybible.infoo.pro/registry.zip',
];
const MAX_ZIP_BYTES = 12 * 1024 * 1024;
const MAX_REGISTRY_JSON_BYTES = 24 * 1024 * 1024;

/** Safe metadata only; having registry fields never confirms redistribution rights. */
export function russianModuleMetadata(registry) {
  if (!registry || !Array.isArray(registry.downloads)) throw new Error('Unsupported registry JSON');
  const result = { dictionary: [], commentary: [] };
  const seen = new Set();
  for (const entry of registry.downloads) {
    if (!entry || entry.hid === true || typeof entry.lng !== 'string' || entry.lng.toLowerCase() !== 'ru' ||
        typeof entry.fil !== 'string') continue;
    const type = /\.dictionary$/i.test(entry.fil) ? 'dictionary' :
      /\.commentaries$/i.test(entry.fil) ? 'commentary' : null;
    if (!type || seen.has(entry.fil)) continue;
    seen.add(entry.fil);
    result[type].push({
      file: entry.fil,
      code: typeof entry.abr === 'string' ? entry.abr : '',
      name: typeof entry.des === 'string' ? entry.des.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) : '',
      size: typeof entry.siz === 'string' ? entry.siz : '',
      hasRightsMetadata: ['license', 'copyright', 'rights', 'attribution', 'author', 'homepage', 'origin']
        .some((key) => typeof entry[key] === 'string' && entry[key].trim()),
      downloadListed: Array.isArray(entry.url) && entry.url.length > 0,
    });
  }
  for (const type of ['dictionary', 'commentary'])
    result[type].sort((a, b) => a.file.localeCompare(b.file, 'ru'));
  return result;
}

async function fetchRegistry() {
  const errors = [];
  for (const url of REGISTRIES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45_000),
        headers: { 'user-agent': 'bible-app-modules registry compatibility QA' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_ZIP_BYTES) throw new Error('ZIP too large');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ZIP_BYTES || bytes.subarray(0, 2).toString() !== 'PK') throw new Error('Invalid ZIP');
      return { bytes, host: new URL(url).host };
    } catch (error) {
      errors.push(new URL(url).host + ': ' + error.message);
    }
  }
  throw new Error('Registry unavailable: ' + errors.join('; '));
}

export async function scanRussianRegistry() {
  const { bytes, host } = await fetchRegistry();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ru-registry-'));
  try {
    const zip = path.join(dir, 'registry.zip');
    fs.writeFileSync(zip, bytes);
    const paths = execFileSync('unzip', ['-Z', '-1', zip], { encoding: 'utf8', timeout: 15_000 })
      .trim().split(/\r?\n/);
    const member = paths.find((p) => path.posix.basename(p) === 'registry.json' && !p.includes('..'));
    if (!member) throw new Error('registry.json not found in ZIP');
    const body = execFileSync('unzip', ['-p', zip, member], { encoding: 'utf8',
      maxBuffer: MAX_REGISTRY_JSON_BYTES, timeout: 15_000 });
    const metadata = russianModuleMetadata(JSON.parse(body.replace(/^\uFEFF/, '')));
    const report = {
      registryHost: host, russianDictionaryCount: metadata.dictionary.length,
      russianCommentaryCount: metadata.commentary.length,
      // The output has titles and filenames only; NO dictionary/commentary content.
      dictionaries: metadata.dictionary.slice(0, 25),
      commentaries: metadata.commentary.slice(0, 25),
      rights: 'Registry listing alone does not authorize redistribution',
    };
    console.log(JSON.stringify(report, null, 2));
    if (!metadata.dictionary.length || !metadata.commentary.length)
      throw new Error('No Russian dictionaries or commentaries discovered');
    return report;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await scanRussianRegistry(); }
  catch (error) { console.error('Russian registry scan failed:', error.message); process.exitCode = 1; }
}
