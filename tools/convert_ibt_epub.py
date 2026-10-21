"""Reproducible draft-only IBT EPUB -> MyBible SQLite quality test.

Inputs are exact OSIS verse anchors in EPUB XHTML (<span id="_1Cor.1.1">).
Never infer verses from heading order, never renumber chapters, never fill missing verses.
By default this CLI writes metadata only and discards the SQLite database.
No binary translations may be committed, uploaded, or published without rights review
and a separate Android integration test.
"""
from __future__ import annotations

import argparse
from collections import Counter
from html.parser import HTMLParser
from io import BytesIO
import hashlib
import json
import re
import sqlite3
import tempfile
from pathlib import Path
import zipfile

from probe_ibt_ebooks import fetch_ibt

BOOKS = {
    "Gen": 10, "Exod": 20, "Lev": 30, "Num": 40, "Deut": 50, "Josh": 60, "Judg": 70,
    "Ruth": 80, "1Sam": 90, "2Sam": 100, "1Kgs": 110, "2Kgs": 120, "1Chr": 130,
    "2Chr": 140, "Ezra": 150, "Neh": 160, "Esth": 190, "Job": 220, "Ps": 230,
    "Prov": 240, "Eccl": 250, "Song": 260, "Isa": 290, "Jer": 300, "Lam": 310,
    "Ezek": 330, "Dan": 340, "Hos": 350, "Joel": 360, "Amos": 370, "Obad": 380,
    "Jonah": 390, "Mic": 400, "Nah": 410, "Hab": 420, "Zeph": 430, "Hag": 440,
    "Zech": 450, "Mal": 460, "Matt": 470, "Mark": 480, "Luke": 490, "John": 500,
    "Acts": 510, "Rom": 520, "1Cor": 530, "2Cor": 540, "Gal": 550, "Eph": 560,
    "Phil": 570, "Col": 580, "1Thess": 590, "2Thess": 600, "1Tim": 610, "2Tim": 620,
    "Titus": 630, "Phlm": 640, "Heb": 650, "Jas": 660, "1Pet": 670, "2Pet": 680,
    "1John": 690, "2John": 700, "3John": 710, "Jude": 720, "Rev": 730,
}
ALIASES = {"1Th": "1Thess", "2Th": "2Thess", "1Jn": "1John", "2Jn": "2John", "3Jn": "3John"}
VERSE_ID = re.compile(r"^_?([1-3]?[A-Za-z][A-Za-z0-9]*)\.(\d{1,3})\.(\d{1,3})$")
CONTENT_CLASS = re.compile(r"\bosis-(?:p\d*|m\d*|q\d*|pi\d*|pc|nb|li\d*|b|tr|tc\d*)\b")
POETRY_CLASS = re.compile(r"\bosis-l\d*\b")
MAX_ENTRIES = 1600
MAX_ENTRY_BYTES = 48 * 1024 * 1024
MAX_UNCOMPRESSED_TOTAL = 160 * 1024 * 1024


class DraftError(ValueError):
    pass


class VerseHtml(HTMLParser):
    """Only gather text after verifiable OSIS verse anchors in Scripture paragraphs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, str, str]] = []
        self.verses: list[tuple[tuple[int, int, int], str]] = []
        self.active: tuple[int, int, int] | None = None
        self.parts: list[str] = []
        self.unknown_codes = Counter()
        self.seen_anchors = 0
        self.skipped_anchors = 0
        self.empty_addresses: list[tuple[int, int, int]] = []
        self.outside_flow = Counter()
        self.outside_flow_full_paths = Counter()
        self.note_reference_count = 0
        self.blank_reasons = Counter()
        self.blank_samples: list[dict] = []
        self.active_note_chars = 0
        self.active_outside_chars = 0
        self.active_number_chars = 0

    def _save(self) -> None:
        if self.active is None:
            return
        text = re.sub(r"\s+", " ", "".join(self.parts)).strip()
        if text:
            self.verses.append((self.active, text))
        else:
            self.skipped_anchors += 1
            self.empty_addresses.append(self.active)
            reason = ('outside_flow' if self.active_outside_chars else
                      'notes_only' if self.active_note_chars else
                      'only_number_or_marker' if self.active_number_chars else 'no_source_text')
            self.blank_reasons[reason] += 1
            if len(self.blank_samples) < 18:
                b, ch, vs = self.active
                self.blank_samples.append({'book': b, 'chapter': ch, 'verse': vs, 'reason': reason})
        self.parts = []
        self.active_note_chars = 0
        self.active_outside_chars = 0
        self.active_number_chars = 0

    def handle_starttag(self, tag, attrs) -> None:
        a = dict(attrs)
        name = a.get("class", "") or ""
        if tag == "a" and ("noteref" in (a.get("epub:type", "") or "") or
                            "osis-note" in name):
            self.note_reference_count += 1
        epub_type = a.get("epub:type", "") or ""
        if tag == "span":
            match = VERSE_ID.fullmatch(a.get("id", "") or "")
            if match:
                # Do not treat cross references or headings *inside notes* as verses.
                if not any('footnote' in cls or 'osis-note' in cls or 'noteref' in typ
                           for _, cls, typ in self.stack):
                    self._save()
                    self.seen_anchors += 1
                else:
                    match = None
            if match:
                book_code = ALIASES.get(match.group(1), match.group(1))
                book = BOOKS.get(book_code)
                chap, verse = int(match.group(2)), int(match.group(3))
                self.active = (book, chap, verse) if book and 1 <= chap <= 200 and 1 <= verse <= 200 else None
                if self.active is None:
                    self.unknown_codes[book_code] += 1
        self.stack.append((tag, name, epub_type))
        if tag in ("p", "div") and self.active is not None and CONTENT_CLASS.search(name):
            self.parts.append(" ")
        # OSIS numbered lists (genealogies, law lists) are real Scripture
        # text; their list-item boundaries are word separators, not verses.
        if tag == "li" and re.search(r"\bosis-item\d*\b", name) and self.active is not None:
            self.parts.append(" ")

    def handle_startendtag(self, tag, attrs) -> None:
        # <br/> is a word separator, not a source of Scripture text.
        if tag == "br" and self.active is not None:
            self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        if self.active is None or not data:
            return
        if any(tag in ("sup", "script", "style", "h1", "h2", "h3", "h4", "h5", "h6")
               or "noteref" in typ or "footnote" in typ
               or "osis-note" in cls or "footnote" in cls
               or "xsl-chapter-number" in cls or "xsl-verse-number" in cls
               for tag, cls, typ in self.stack):
            if data.strip():
                if any('note' in cls or 'noteref' in typ for _, cls, typ in self.stack):
                    self.active_note_chars += len(data.strip())
                else:
                    self.active_number_chars += len(data.strip())
            return
        # Some editions (e.g. Ingush Genesis genealogies) place verse text
        # directly in an OSIS div without an intervening paragraph. Accept
        # *direct* text nodes only; never all prose in descendant containers.
        inline_tags = {"a", "span", "em", "strong", "b", "i", "u", "small", "mark", "font"}
        direct_osis_div = False
        for pos in range(len(self.stack) - 1, -1, -1):
            tag, cls, _ = self.stack[pos]
            if tag == "div" and re.search(r"\bosis-div\b", cls):
                direct_osis_div = all(child_tag in inline_tags for child_tag, _, _ in self.stack[pos + 1:])
                break
        # IBT EPUBs encode some genuine Scripture as <ol class=osis-list>
        # <li class=osis-item> outside paragraphs and poetry lines.
        # Require the complete OSIS list hierarchy to prevent collecting
        # navigation lists, publisher introductions, and unrelated lists.
        scripture_list = False
        osis_div_pos = next((i for i,(tag,cls,_) in enumerate(self.stack)
                             if tag == "div" and re.search(r"\bosis-div\b", cls)), -1)
        if osis_div_pos >= 0:
            list_pos = next((i for i in range(osis_div_pos + 1, len(self.stack))
                             if self.stack[i][0] in ("ol", "ul")
                             and re.search(r"\bosis-list\b", self.stack[i][1])), -1)
            if list_pos >= 0:
                item_pos = next((i for i in range(list_pos + 1, len(self.stack))
                                 if self.stack[i][0] == "li"
                                 and re.search(r"\bosis-item\d*\b", self.stack[i][1])), -1)
                scripture_list = item_pos >= 0 and all(
                    tag in inline_tags for tag, _, _ in self.stack[item_pos + 1:]
                )
        if not direct_osis_div and not scripture_list and not any((tag == "p" and CONTENT_CLASS.search(cls))
                   or (tag == "div" and POETRY_CLASS.search(cls))
                   for tag, cls, _ in self.stack):
            if data.strip():
                relevant = [f"{tag}:{cls[:48]}" for tag, cls, _ in self.stack if tag in ("p", "div", "td", "span", "v")]
                label = " > ".join(relevant[-3:]) or "(no p/div)"
                self.outside_flow[label] += len(data.strip())
                full_path = " > ".join(f"{tag}:{cls[:36]}" for tag,cls,_ in self.stack[-8:])
                self.outside_flow_full_paths[full_path] += len(data.strip())
                self.active_outside_chars += len(data.strip())
            return
        self.parts.append(data)

    def handle_endtag(self, tag) -> None:
        if tag == "p" and self.active is not None:
            self.parts.append(" ")
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def finish(self):
        super().close()
        self._save()
        return self.verses


def extract_epub(data: bytes) -> dict:
    results: dict[tuple[int, int, int], str] = {}
    unknown = Counter()
    files_with_text = 0
    anchors = 0
    empty_anchors = 0
    missing_by_book = Counter()
    outside_flow = Counter()
    outside_flow_full_paths = Counter()
    note_refs = 0
    blank_reasons = Counter()
    blank_samples = []
    with zipfile.ZipFile(BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES:
            raise DraftError("Too many EPUB entries")
        if sum(info.file_size for info in members if not info.is_dir()) > MAX_UNCOMPRESSED_TOTAL:
            raise DraftError("EPUB expanded size limit exceeded")
        for item in sorted(members, key=lambda x: x.filename):
            if item.is_dir():
                continue
            if item.file_size > MAX_ENTRY_BYTES or item.filename.startswith("/") or ".." in item.filename.split("/"):
                raise DraftError("Unsafe EPUB entry")
            if not item.filename.lower().endswith((".xhtml", ".html", ".htm")):
                continue
            probe = VerseHtml()
            probe.feed(archive.read(item).decode("utf-8-sig", "strict"))
            for key, text in probe.finish():
                if key in results:
                    if results[key] != text:
                        raise DraftError(f"Conflicting verse texts at {key}, cannot infer safe merge")
                    raise DraftError(f"Duplicated verse anchor {key}, cannot infer safe merge")
                results[key] = text
            if probe.verses:
                files_with_text += 1
            anchors += probe.seen_anchors
            empty_anchors += probe.skipped_anchors
            missing_by_book.update(b for b, _, _ in probe.empty_addresses)
            outside_flow.update(probe.outside_flow)
            outside_flow_full_paths.update(probe.outside_flow_full_paths)
            note_refs += probe.note_reference_count
            blank_reasons.update(probe.blank_reasons)
            blank_samples.extend(probe.blank_samples[:max(0, 25-len(blank_samples))])
            unknown.update(probe.unknown_codes)
    if anchors != len(results) + empty_anchors + sum(unknown.values()):
        raise DraftError("OSIS anchor accounting mismatch; publication is unsafe")
    return {
        "verses": results, "verseAnchors": anchors, "blankAnchors": empty_anchors,
        "filesWithVerses": files_with_text, "unknownBooks": dict(unknown),
        "blankByBook": [[book, n] for book, n in missing_by_book.most_common(20)],
        "outsideFlowContexts": outside_flow.most_common(16),
        "outsideFlowTagPaths": outside_flow_full_paths.most_common(18),
        "noteReferenceCount": note_refs,
        "blankReasonCounts": dict(blank_reasons),
        "blankAddressSamples": blank_samples,
    }


def sqlite_draft(rows: dict[tuple[int, int, int], str], language: str, source_sha: str,
                 local_test_dir: Path | None = None) -> dict:
    if not rows:
        raise DraftError("No unambiguous Scripture verses extracted")
    with tempfile.TemporaryDirectory(prefix="ibt-sqlite-draft-") as tmp:
        filename = Path(tmp) / "draft.sqlite3"
        with sqlite3.connect(filename) as db:
            db.executescript("""
                CREATE TABLE info(name TEXT, value TEXT);
                CREATE TABLE books(book_color TEXT, book_number INTEGER,
                    short_name TEXT, long_name TEXT, is_present INTEGER);
                CREATE TABLE verses(book_number INTEGER, chapter INTEGER, verse INTEGER, text TEXT,
                    PRIMARY KEY(book_number,chapter,verse));
                CREATE TABLE stories(book_number INTEGER, chapter INTEGER, verse INTEGER,
                    order_if_several INTEGER, title TEXT);
                CREATE TABLE notes(book_number INTEGER, chapter INTEGER, verse INTEGER, text TEXT);
            """)
            metadata = {
                "language": language, "origin": "Institute for Bible Translation eBook EPUB",
                "app_format": "1", "status": "local_draft_not_for_publication",
                "source_sha256": source_sha,
            }
            db.executemany("INSERT INTO info VALUES (?, ?)", sorted(metadata.items()))
            by_book = sorted({row[0] for row in rows})
            # OSIS codes (Gen, Matt, Acts) identify books; they are NOT
            # their localized names. Leave labels empty so the existing app
            # displays its own translated canonical names instead.
            db.executemany("INSERT INTO books VALUES (?,?,?,?,1)",
                           [("", b, "", "") for b in by_book])
            db.executemany("INSERT INTO verses VALUES (?,?,?,?)",
                           [(b,c,v,t) for (b,c,v),t in sorted(rows.items())])
            db.execute("CREATE INDEX verses_bc ON verses(book_number,chapter)")
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise DraftError("SQLite integrity check failed")
            # Verify every verse against the exact normalized source string, not only row counts.
            # SQL equality on text makes whitespace and Unicode handling auditable.
            reread = {(int(book), int(ch), int(v)): text for book,ch,v,text in
                      db.execute("SELECT book_number, chapter, verse, text FROM verses")}
            if reread != rows:
                raise DraftError("SQLite round-trip text mismatch")
            if db.execute("SELECT COUNT(*) FROM verses WHERE text IS NULL OR TRIM(text) = ''").fetchone()[0]:
                raise DraftError("Empty Scripture text inserted into SQLite")
        digest = hashlib.sha256(filename.read_bytes()).hexdigest()
        report = {"sqliteSha256": digest, "books": len(by_book), "verseRows": len(rows),
                  "bookNumbers": by_book, "status": "sqlite_draft_not_published_or_android_tested"}
        if local_test_dir is not None:
            # Opt-in developer-only archive. Never put these binaries into Git,
            # public Actions artifacts, catalog.json or an APK.
            if language not in {"tab", "lbe", "inh", "gag", "dng"}:
                raise DraftError("Local test ZIP language must be an audited IBT source")
            target_dir = Path(local_test_dir)
            target_dir.mkdir(parents=True, exist_ok=True)
            archive = target_dir / f"IBT_{language}_LOCAL_TEST_ONLY.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zip_out:
                zip_out.write(filename, arcname=f"IBT_{language}.SQLite3")
            report["localTestZip"] = str(archive)
        return report


def test_registry(registry_file: Path, local_test_dir: Path | None = None) -> dict:
    source = json.loads(registry_file.read_text("utf-8"))
    entries = [x for x in source["records"] if x.get("sourceKind") in ("digital_ebook_listing", "digital_epub_draft")]
    if not entries:
        raise DraftError("No IBT eBook sources found: do not report empty successful conversion")
    report = {"format": 1, "attempted": len(entries), "draftsWithVerses": 0, "modules": []}
    for entry in entries:
        uri = entry.get("digitalEpubUrl")
        item = {"language": entry["language"], "source": uri, "status": "not_checked"}
        if not uri:
            item["status"] = "no_epub_source"
            report["modules"].append(item)
            continue
        try:
            blob = fetch_ibt(uri)
            source_hash = hashlib.sha256(blob).hexdigest()
            parsed = extract_epub(blob)
            item.update({"sourceSha256": source_hash, "verseAnchors": parsed["verseAnchors"],
                         "blankAnchors": parsed["blankAnchors"],
                         "filesWithVerses": parsed["filesWithVerses"],
                         "unknownBooks": parsed["unknownBooks"],
                         "blankByBook": parsed["blankByBook"],
                         "outsideFlowContexts": parsed["outsideFlowContexts"],
                         "outsideFlowTagPaths": parsed["outsideFlowTagPaths"],
                         "noteReferenceCount": parsed["noteReferenceCount"],
                         "blankReasonCounts": parsed["blankReasonCounts"],
                         "blankAddressSamples": parsed["blankAddressSamples"]})
            item.update(sqlite_draft(parsed["verses"], entry["language"], source_hash,
                                     local_test_dir=local_test_dir))
            report["draftsWithVerses"] += 1
        except (OSError, ValueError, UnicodeError, zipfile.BadZipFile) as exc:
            item.update(status="needs_manual_mapping", error=str(exc)[:230])
        report["modules"].append(item)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--registry", default="docs/language-module-discovery.json")
    ap.add_argument("--report", default="ibt-sqlite-drafts.json")
    ap.add_argument("--local-test-zips", type=Path,
                    help="EXPLICIT opt-in: save private test ZIPs here; do not publish (rights not cleared)")
    args = ap.parse_args()
    report = test_registry(Path(args.registry), local_test_dir=args.local_test_zips)
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(f"Draft SQLite structural checks: {report['draftsWithVerses']}/{report['attempted']}; no Scripture uploaded")
    if args.local_test_zips:
        print("Private local test ZIPs created. Do not distribute: permission and Android QA are pending.")
    for x in report["modules"]:
        print(x["language"], x["status"], x.get("books"), x.get("verseRows"), x.get("error", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
