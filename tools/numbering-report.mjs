import { books, canon } from './validate.mjs';

/** Compare every source coordinate; never move, duplicate or renumber its text. */
export function numberingReport(byBook) {
  const counts = {};
  for (const [b, verses] of byBook) {
    const chapters = new Map();
    for (const key of verses.keys()) {
      const [c, v] = key.split(':').map(Number);
      if (!chapters.has(c)) chapters.set(c, []);
      chapters.get(c).push(v);
    }
    counts[b] = Object.fromEntries([...chapters].sort((a, b) => a[0] - b[0]).map(([c, vs]) => [c, vs.sort((a, b) => a - b)]));
  }
  const candidates = {};
  for (const numbering of ['eng', 'rus', 'org']) {
    const reference = canon(numbering);
    let missing = 0, extra = 0, chapterMismatches = 0;
    const differences = [];
    for (const b of books) {
      if (!counts[b.n]) continue;
      const actual = counts[b.n];
      const expected = reference[b.n];
      if (Object.keys(actual).length !== expected.length) chapterMismatches++;
      for (const c of new Set([...Object.keys(actual).map(Number), ...expected.map((_, i) => i + 1)])) {
        const have = actual[c] ?? [];
        const want = expected[c - 1] ?? 0;
        const absent = Array.from({ length: want }, (_, i) => i + 1).filter((v) => !have.includes(v));
        const outside = have.filter((v) => v < 1 || v > want);
        missing += absent.length; extra += outside.length;
        if (absent.length || outside.length) differences.push({ book: b.usfm, chapter: c, expected: want, actual: have.length, missing: absent, extra: outside });
      }
    }
    candidates[numbering] = { missing, extra, chapterMismatches, differences };
  }
  return { books: byBook.size, chapters: Object.values(counts).reduce((n, cs) => n + Object.keys(cs).length, 0), verses: [...byBook.values()].reduce((n, vs) => n + vs.size, 0), candidates, counts };
}
