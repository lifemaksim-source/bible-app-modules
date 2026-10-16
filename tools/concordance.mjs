// Compact inverted index for the existing KJV Strong's-tagged WORDS data.
// Counts describe KJV tagged WORDS tokens, not occurrences in critical Hebrew/Greek editions.
// A phrase carrying two different H/G tags counts once for EACH tag;
// repeated identical tags on one phrase are not double-counted.

/** "H07225" and "G26a" -> "H7225", "G26"; reject garbage and zero. */
export function canonicalStrongNumber(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^([HG])0*(\d{1,5})[a-z]?$/i.exec(raw);
  if (!match) return null;
  const num = Number(match[2]);
  if (!Number.isSafeInteger(num) || num < 1) return null;
  return match[1].toUpperCase() + num;
}

/** Returns per-verse counts, not an array of unbounded flattened occurrences. */
export function verseStrongCounts(segments) {
  const hits = new Map();
  if (!Array.isArray(segments)) return hits;
  for (const part of segments) {
    if (!Array.isArray(part) || typeof part[0] !== 'string' || !part[0].trim() ||
        typeof part[1] !== 'string') continue;
    const distinct = new Set(part[1].split(/\s+/).map(canonicalStrongNumber).filter(Boolean));
    for (const key of distinct) hits.set(key, (hits.get(key) || 0) + 1);
  }
  return hits;
}

/**
 * Insert one row per (Strong topic, KJV verse) into the new CONCORDANCE table.
 * The caller already owns the transaction and has validated the source's verse map.
 * Primary key (topic,verse_id) supports fast indexed lookup and verse-order paging.
 */
export function writeConcordance(db, verses) {
  let rows = 0;
  let occurrences = 0;
  const stmt = db.prepare('INSERT INTO concordance (topic, verse_id, hits) VALUES (?, ?, ?)');
  try {
    for (const [verseId, segments] of verses) {
      if (!Number.isSafeInteger(verseId) || verseId <= 0) {
        throw new Error('Invalid KJV verse address in Strong concordance');
      }
      for (const [topic, hits] of verseStrongCounts(segments)) {
        stmt.run([topic, verseId, hits]);
        rows++;
        occurrences += hits;
      }
    }
  } finally {
    stmt.free();
  }
  return { rows, occurrences };
}
