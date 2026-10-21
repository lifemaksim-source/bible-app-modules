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

    def _save(self) -> None:
        if self.active is None:
            return
        text = re.sub(r"\s+", " ", "".join(self.parts)).strip()
        if text:
            self.verses.append((self.active, text))
        else:
            self.skipped_anchors += 1
            self.empty_addresses.append(self.active)
        self.parts = []

    def handle_starttag(self, tag, attrs) -> None:
        a = dict(attrs)
        name = a.get("class", "") or ""
        epub_type = a.get("epub:type", "") or ""
        if tag == "span":
            match = VERSE_ID.fullmatch(a.get("id", "") or "")
            if match:
                self._save()
                self.seen_anchors += 1
                book_code = ALIASES.get(match.group(1), match.group(1))
                book = BOOKS.get(book_code)
                chap, verse = int(match.group(2)), int(match.group(3))
                self.active = (book, chap, verse) if book and 1 <= chap <= 200 and 1 <= verse <= 200 else None
                if self.active is None:
                    self.unknown_codes[book_code] += 1
        self.stack.append((tag, name, epub_type))
        if tag in ("p", "div") and self.active is not None and CONTENT_CLASS.search(name):
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
            return
        if not any((tag == "p" and CONTENT_CLASS.search(cls))
                   or (tag == "div" and POETRY_CLASS.search(cls))
                   for tag, cls, _ in self.stack):
            if data.strip():
                relevant = [f"{tag}:{cls[:48]}" for tag, cls, _ in self.stack if tag in ("p", "div", "td", "span", "v")]
                label = " > ".join(relevant[-3:]) or "(no p/div)"
                self.outside_flow[label] += len(data.strip())
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
    with zipfile.ZipFile(BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES:
            raise DraftError("Too many EPUB entries")
        for item in sorted(members, key=lambda x: x.filename):
            if item.is_dir():
                continue
            if item.file_size > MAX_ENTRY_BYTES or item.filename.startswith("/") or ".." in item.filename.split("/"):
                raise DraftError("Unsafe EPUB entry")
            if not item.filename.lower().endswith((".xhtml", ".html", ".htm")):
                continue
            probe = VerseHtml()
            probe.feed(archive.read(item).decode("utf-8-sig", "replace"))
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
            unknown.update(probe.unknown_codes)
    return {
        "verses": results, "verseAnchors": anchors, "blankAnchors": empty_anchors,
        "filesWithVerses": files_with_text, "unknownBooks": dict(unknown),
        "blankByBook": [[book, n] for book, n in missing_by_book.most_common(20)],
        "outsideFlowContexts": outside_flow.most_common(16),
    }


def sqlite_draft(rows: dict[tuple[int, int, int], str], language: str, source_sha: str) -> dict:
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
            code_by_number = {v: k for k, v in BOOKS.items()}
            db.executemany("INSERT INTO books VALUES (?,?,?,?,1)",
                           [("", b, code_by_number[b], code_by_number[b]) for b in by_book])
            db.executemany("INSERT INTO verses VALUES (?,?,?,?)",
                           [(b,c,v,t) for (b,c,v),t in sorted(rows.items())])
            db.execute("CREATE INDEX verses_bc ON verses(book_number,chapter)")
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise DraftError("SQLite integrity check failed")
        digest = hashlib.sha256(filename.read_bytes()).hexdigest()
        return {"sqliteSha256": digest, "books": len(by_book), "verseRows": len(rows),
                "bookNumbers": by_book, "status": "sqlite_draft_not_published_or_android_tested"}


def test_registry(registry_file: Path) -> dict:
    source = json.loads(registry_file.read_text("utf-8"))
    entries = [x for x in source["records"] if x.get("sourceKind") == "digital_ebook_listing"]
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
                         "outsideFlowContexts": parsed["outsideFlowContexts"]})
            item.update(sqlite_draft(parsed["verses"], entry["language"], source_hash))
            report["draftsWithVerses"] += 1
        except (OSError, ValueError, UnicodeError, zipfile.BadZipFile) as exc:
            item.update(status="needs_manual_mapping", error=str(exc)[:230])
        report["modules"].append(item)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--registry", default="docs/language-module-discovery.json")
    ap.add_argument("--report", default="ibt-sqlite-drafts.json")
    args = ap.parse_args()
    report = test_registry(Path(args.registry))
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(f"Draft SQLite structural checks: {report['draftsWithVerses']}/{report['attempted']}; no Scripture uploaded")
    for x in report["modules"]:
        print(x["language"], x["status"], x.get("books"), x.get("verseRows"), x.get("error", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
