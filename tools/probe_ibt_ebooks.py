"""Safely fingerprint IBT FB2/EPUB eBooks without printing or distributing Scripture text.

Usage:
  python3 tools/probe_ibt_ebooks.py --sources docs/language-module-discovery.json \
    --report ibt-ebook-probe.json

This is structural discovery only. Never infer verse alignment from chapter counts.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile
from io import BytesIO

MAX_DOWNLOAD = 24 * 1024 * 1024
MAX_XML = 48 * 1024 * 1024
MAX_FILES = 1500
ALLOWED_ORIGIN = "ibtrussia.org"
BOOK_EXTENSIONS = (".fb2", ".xhtml", ".html", ".htm")
ATTRS = ("id", "name", "class", "type", "href", "epub:type")


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _shape(text: str) -> str:
    """Only digits / punctuation from short string prefixes; no original words."""
    chars = []
    for char in text.strip()[:65]:
        chars.append("D" if char.isdigit() else "L" if char.isalpha() else char)
    return "".join(chars)


def inspect_xml(data: bytes, suffix: str) -> dict:
    if len(data) > MAX_XML:
        raise ValueError("XML content exceeds limit")
    if b"<!DOCTYPE" in data[:8192].upper() or b"<!ENTITY" in data[:8192].upper():
        raise ValueError("DTD/entities disallowed")
    root = ET.fromstring(data)
    counts = Counter(_localname(node.tag) for node in root.iter())
    sections = []
    paragraphs = []
    sample_attributes = []
    numbered = 0
    for node in root.iter():
        tag = _localname(node.tag)
        attrs = {str(k).rsplit("}", 1)[-1]: str(v)[:90] for k, v in node.attrib.items() if str(k).rsplit("}", 1)[-1] in ATTRS}
        if attrs and len(sample_attributes) < 22 and tag in ("section", "p", "a", "span", "sup", "div", "title"):
            sample_attributes.append({"tag": tag, "attributes": attrs})
        if tag == "section" and len(sections) < 16:
            sections.append(attrs)
        if tag in ("p", "v", "verse"):
            text = "".join(node.itertext()).strip()
            if re.match(r"^\s*\d{1,3}(?:\s|[.:])", text):
                numbered += 1
            if len(paragraphs) < 26:
                paragraphs.append({"tag": tag, "textLength": len(text), "shape": _shape(text), "attributes": attrs})
    # OSIS-style IDs are identifiers, not quotations; a verse anchor must
    # be an id/name on the element itself, not a hyperlink to another verse.
    osis = re.compile(r"^([1-3]?[A-Za-z][A-Za-z0-9]*)\.(\d{1,3})(?:\.(\d{1,3}))?$")
    book_codes = Counter()
    id_counts = Counter()
    reference_counts = Counter()
    anchor_examples = []
    chapter_examples = []
    context_examples = []
    parents = {child: parent for parent in root.iter() for child in parent}
    for node in root.iter():
        tag = _localname(node.tag)
        for key in ("id", "name"):
            raw_id = node.attrib.get(key)
            if not raw_id:
                continue
            match = osis.fullmatch(raw_id)
            if not match:
                continue
            book_codes[match.group(1)] += 1
            kind = "verse" if match.group(3) else "chapter"
            id_counts[(tag, kind)] += 1
            example = anchor_examples if kind == "verse" else chapter_examples
            if len(example) < 12:
                example.append({"tag": tag, "id": raw_id})
            if kind == "verse" and len(context_examples) < 8:
                chain = []
                parent = node
                for _ in range(5):
                    if parent not in parents:
                        break
                    parent = parents[parent]
                    chain.append(_localname(parent.tag))
                context_examples.append({
                    "id": raw_id, "element": tag, "parentTags": chain,
                    "elementChildTags": [_localname(x.tag) for x in list(node)[:8]],
                    "textLength": len("".join(node.itertext()).strip()),
                    "textShape": _shape("".join(node.itertext())),
                })
        href = node.attrib.get("href", "")
        if href:
            target = href.rsplit("#", 1)[-1]
            match = osis.fullmatch(target)
            if match:
                reference_counts[("verse" if match.group(3) else "chapter")] += 1

    return {
        "format": suffix,
        "rootTag": _localname(root.tag),
        "tagCounts": counts.most_common(22),
        "sectionSamples": sections,
        "attributeSamples": sample_attributes,
        "paragraphSamples": paragraphs,
        "paragraphsStartingWithNumber": numbered,
        "osisEvidence": {
            "idCountsByTag": [[tag, kind, n] for (tag, kind), n in sorted(id_counts.items())],
            "referenceCounts": dict(reference_counts),
            "topBookCodes": book_codes.most_common(25),
            "verseIdExamples": anchor_examples,
            "chapterIdExamples": chapter_examples,
            "verseContextExamples": context_examples,
        },
        "structureVerdict": "requires_manual_verse_mapping_review",
    }


class HtmlProbe(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.counts = Counter()
        self.examples = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.counts[tag] += 1
        if tag in ("section", "span", "sup", "p", "a") and len(self.examples) < 25:
            fields = {k: (v or "")[:90] for k, v in attrs if k in ATTRS}
            if fields:
                self.examples.append({"tag": tag, "attributes": fields})


def _read_zip(data: bytes, fmt: str) -> dict:
    with zipfile.ZipFile(BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > MAX_FILES:
            raise ValueError("Too many archive members")
        bad = archive.testzip()
        if bad is not None:
            raise ValueError("ZIP CRC error")
        candidates = []
        sample_names = []
        for info in members:
            if info.is_dir():
                continue
            if info.file_size > MAX_XML:
                raise ValueError("Oversized archive member")
            if info.filename.startswith("/") or ".." in info.filename.split("/"):
                raise ValueError("Unsafe member path")
            if len(sample_names) < 18:
                sample_names.append(Path(info.filename).name[:100])
            if info.filename.lower().endswith(BOOK_EXTENSIONS):
                candidates.append(info)
        if not candidates:
            raise ValueError("No FB2/XHTML entries")
        candidates.sort(key=lambda x: (not x.filename.lower().endswith(".fb2"), not bool(re.search(r"(?:split_|chapter_|/text/)", x.filename, re.I)), x.filename))
        profiles = []
        for info in candidates[:2]:
            raw = archive.read(info)
            suffix = Path(info.filename).suffix.lower()
            if suffix == ".fb2":
                profile = inspect_xml(raw, "fb2")
            else:
                probe = HtmlProbe()
                probe.feed(raw.decode("utf-8-sig", "replace"))
                profile = {"format": "xhtml", "tagCounts": probe.counts.most_common(18),
                           "attributeSamples": probe.examples, "structureVerdict": "requires_manual_verse_mapping_review"}
            profiles.append({"member": Path(info.filename).name[:110],
                             "uncompressedBytes": info.file_size, "structure": profile})
        return {"archiveEntries": len(members), "xmlEntries": len(candidates),
                "fileNameSamples": sample_names, "profiles": profiles}


def inspect_ebook(data: bytes, fmt: str) -> dict:
    if len(data) > MAX_DOWNLOAD:
        raise ValueError("Download exceeds limit")
    if fmt in ("fb2.zip", "epub"):
        if not zipfile.is_zipfile(BytesIO(data)):
            raise ValueError("Expected ZIP container")
        parsed = _read_zip(data, fmt)
    elif fmt == "fb2":
        parsed = {"profiles": [{"structure": inspect_xml(data, fmt)}]}
    else:
        raise ValueError("Unsupported eBook type")
    return {"fileSha256": hashlib.sha256(data).hexdigest(), "downloadBytes": len(data),
            "ebookFormat": fmt, **parsed, "status": "bytes_inspected_not_converted"}


def fetch_ibt(url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != ALLOWED_ORIGIN or not parsed.path.startswith("/sites/default/files/ebm/ebook/"):
        raise ValueError("Untrusted download location")
    with urlopen(Request(url, headers={"User-Agent": "BibleApp/IBT-metadata-audit"}), timeout=25) as stream:
        if stream.status != 200:
            raise ValueError(f"HTTP {stream.status}")
        data = stream.read(MAX_DOWNLOAD + 1)
        if len(data) > MAX_DOWNLOAD:
            raise ValueError("Download exceeds limit")
        return data


def probe_registry(path: Path, download=fetch_ibt) -> dict:
    rows = json.loads(path.read_text("utf-8"))["records"]
    candidates = [r for r in rows if r.get("sourceKind") == "digital_ebook_listing"]
    result = {"schemaVersion": 1, "attempted": len(candidates), "verified": 0, "items": []}
    for row in candidates:
        item = {"language": row["language"], "sourceUrl": row["sourceUrl"],
                "downloadUrl": row["digitalDownloadUrl"], "status": "not_downloaded"}
        try:
            raw = download(row["digitalDownloadUrl"])
            item.update(inspect_ebook(raw, row["digitalFormat"]))
            result["verified"] += 1
        except (OSError, ValueError, ET.ParseError, zipfile.BadZipFile, UnicodeError) as exc:
            item.update(status="probe_failed", error=str(exc)[:240])
        result["items"].append(item)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sources", default="docs/language-module-discovery.json")
    ap.add_argument("--report", default="ibt-ebook-probe.json")
    args = ap.parse_args()
    result = probe_registry(Path(args.sources))
    Path(args.report).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"IBT books: {result['verified']}/{result['attempted']} downloaded and structurally inspected")
    for item in result["items"]:
        print(item["language"], item["status"], item.get("downloadBytes", item.get("error")))
        for p in item.get("profiles", [])[:2]:
            structure = p["structure"]
            print("  ", p.get("member", ""), structure.get("rootTag"), structure.get("tagCounts", [])[:8],
                  "numbered", structure.get("paragraphsStartingWithNumber"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
