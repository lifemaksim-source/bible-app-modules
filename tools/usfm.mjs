// USFM (as published by eBible.org) → verses, headings, footnotes.
// Only the markers that matter for reading text are handled; everything else is dropped.

// Paragraph / poetry markers: only separate words.
const SPACE_MARKERS = /^(p|m|mi|pi\d?|pc|pr|pm\w*|po|q\d?|qr|qc|qm\d?|qd|b|nb|li\d?|lim\d?|ph\d?|lh|lf|ib\w*|ip\w*|cls|tr|tc\w*|th\w*)$/;
// Lines that are not part of the text.
const SKIP_MARKERS = /^(id|ide|usfm|h\d?|toc\d|tocr?\d?|mt\d?|mte\d?|imt\d?|is\d?|iot|io\d|ior|ie|iex|ili\d?|im\w*|imi\w*|ipi\w*|iq\d?|ib|ip|ipr|ipq|rem|sts|restore|cl|cd|cp|ca|r|mr|sr|sp|ms\d?|periph|lit|fig|esb|esbe)$/;
const HEADING_MARKERS = /^(s\d?|ms\d?|mr|sr)$/;

const CHAR_MARKERS = /^\+?(w|add|nd|wj|qs|tl|k|bk|sc|em|bd|it|bdit|no|ord|pn|png|sig|sls|dc|qt|f|fe|x|va|vp|fig|rq|ef)$/;
const opens = (l) => (l.match(/\\(f|fe|x)\s/g) ?? []).length;
const closes = (l) => (l.match(/\\(f|fe|x)\*/g) ?? []).length;
const clean = (t) => t.replace(/\s+/g, ' ').replace(/\s+([,.;:!?»)])/g, '$1').trim();

/** Strip inline character markers; footnotes are returned separately. */
export function inline(text) {
  const notes = [];
  let t = text;
  // footnotes \f + \fr 1:1 \ft text \f*  (also \fe endnotes)
  t = t.replace(/\\(f|fe)\s[\s\S]*?\\\1\*/g, (m) => {
    const body = m
      .replace(/^\\(f|fe)\s+\S+\s*/, '')
      .replace(/\\\+?fr\s[^\\]*/g, '')
      .replace(/\\\+?f[a-z]*\*?/g, ' ')
      .replace(/\\[+a-z0-9]+\*?/gi, ' ');
    const n = clean(body);
    if (n) notes.push(n);
    return '';
  });
  // cross references, figures, alternate numbers, published numbers, glossary links
  t = t.replace(/\\(x|fig|va|vp|ca|cp|rq|ef)\s[\s\S]*?\\\1\*/g, '');
  // words with attributes: \w word|strong="H1"\w*  → word
  t = t.replace(/\\\+?w\s+([^|\\]*?)(?:\|[^\\]*)?\\\+?w\*/g, '$1');
  // remaining character markers (open and close)
  t = t.replace(/\\\+?[a-z]+\d?\*/gi, '').replace(/\\\+?(add|nd|wj|qs|tl|k|bk|sc|em|bd|it|bdit|no|ord|pn|png|sig|sls|dc|ior|iqt|jmp|qt|wg|wh|wa|rb|pro|w)\d?\s/gi, '');
  t = t.replace(/\\[a-z]+\d?\s?/gi, ' ');
  return { text: clean(t), notes };
}

/**
 * Parse the text of one book.
 * @returns {{ verses: Map<string,string>, headings: Map<string,string>, notes: Map<string,string[]>, id: string|null }}
 *   keys are "chapter:verse"
 */
export function parseBook(source) {
  const verses = new Map();
  const headings = new Map();
  const notes = new Map();
  let id = null;
  let ch = 0;
  let vs = 0;
  let buf = '';
  let pending = null; // heading waiting for the next verse

  const flush = () => {
    if (ch && vs && buf) {
      const key = `${ch}:${vs}`;
      const { text, notes: ns } = inline(buf);
      if (text) verses.set(key, verses.has(key) ? `${verses.get(key)} ${text}` : text);
      if (ns.length) notes.set(key, [...(notes.get(key) ?? []), ...ns]);
    }
    buf = '';
  };

  // A footnote can span lines: join lines until its closing \f* appears.
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    while (opens(line) > closes(line) && i + 1 < lines.length) line += ' ' + lines[++i].trim();
    const m = line.match(/^\\(\+?[a-z]+\d?)\*?(?:\s+(.*))?$/i);
    if (!m) {
      buf += ' ' + line;
      continue;
    }
    const mk = m[1].toLowerCase();
    if (CHAR_MARKERS.test(mk)) {
      buf += ' ' + line; // a line that starts with an inline marker is plain text
      continue;
    }
    const rest = m[2] ?? '';
    if (mk === 'id') {
      id = rest.trim().split(/\s+/)[0]?.toUpperCase() ?? null;
    } else if (mk === 'c') {
      flush();
      ch = parseInt(rest, 10) || 0;
      vs = 0;
    } else if (mk === 'v') {
      flush();
      const vm = rest.match(/^(\d+)[a-z]?(?:[-–,]\d+[a-z]?)?\s*(.*)$/);
      if (vm) {
        vs = parseInt(vm[1], 10);
        if (pending && ch) {
          headings.set(`${ch}:${vs}`, pending);
          pending = null;
        }
        buf = vm[2];
      }
    } else if (mk === 'd' || HEADING_MARKERS.test(mk)) {
      if (mk === 'd' || /^s\d?$/.test(mk)) {
        const h = inline(rest).text;
        if (h) {
          // a heading right after a verse text belongs to the next verse
          flush();
          pending = pending ? `${pending} ${h}` : h;
        }
      }
    } else if (SKIP_MARKERS.test(mk)) {
      // dropped
    } else if (SPACE_MARKERS.test(mk) || mk) {
      if (rest) buf += ' ' + rest;
      else buf += ' ';
    }
  }
  flush();
  return { id, verses, headings, notes };
}
