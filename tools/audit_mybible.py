"""Audit actual MyBible registry and ZIP modules without publishing anything.

    python3 tools/audit_mybible.py --registry registry.zip --languages tg mn
    python3 tools/audit_mybible.py --file AriunBible.zip

The first mode lists registry-verified downloadable URLs; the second checks
real SQLite data in a ZIP. Neither mode publishes content or certifies text.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import tempfile
from contextlib import closing
import zipfile
from pathlib import Path

MAX_REGISTRY_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_SQLITE_BYTES = 250 * 1024 * 1024
BASE_REQUIRED = {"books", "verses", "info"}
SIDE_CAR = re.compile(r"\.(?:commentaries|dictionary|crossreferences|subheadings|plan|devotions|bundle|references)\.(?:sqlite3|db)$", re.I)


class AuditError(ValueError):
    pass


def _safe_zip_entries(z, extension):
    return [x for x in z.infolist() if not x.is_dir() and x.filename.lower().endswith(extension)]


def read_registry(file):
    p = Path(file)
    if p.stat().st_size > MAX_REGISTRY_BYTES:
        raise AuditError("Registry exceeds size limit")
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            candidates = [x for x in _safe_zip_entries(z, ".json") if Path(x.filename).name == "registry.json"]
            if len(candidates) != 1 or candidates[0].file_size > MAX_REGISTRY_BYTES:
                raise AuditError("Registry archive lacks one safe registry.json")
            raw = z.read(candidates[0])
    else:
        raw = p.read_bytes()
    obj = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(obj, dict) or not isinstance(obj.get("downloads"), list):
        raise AuditError("Invalid MyBible registry")
    return obj


def registry_candidates(registry, languages):
    aliases = {}
    for h in registry.get("hosts", []):
        if not isinstance(h, dict):
            continue
        alias, template = h.get("alias"), h.get("path")
        if isinstance(alias, str) and isinstance(template, str) and template.startswith("https://") and template.count("%s") == 1:
            aliases[alias] = template
    result = []
    for entry in registry["downloads"]:
        if not isinstance(entry, dict) or entry.get("hid") is True:
            continue
        raw_lang = entry.get("lng", "")
        language = re.split(r"[\s_-]", raw_lang.strip(), maxsplit=1)[0].lower() if isinstance(raw_lang, str) else ""
        file = entry.get("fil")
        if language not in languages or not isinstance(file, str) or not file or "." in file:
            continue
        urls = []
        for address in entry.get("url", []):
            if not isinstance(address, str):
                continue
            found = re.fullmatch(r"\{([^}]+)\}(.+)", address)
            if found and found[1] in aliases:
                url = aliases[found[1]].replace("%s", found[2])
                if url.startswith("https://") and url not in urls:
                    urls.append(url)
        if not urls:
            continue
        result.append({
            "language": language,
            "file": file,
            "code": str(entry.get("abr", ""))[:60],
            "name": str(entry.get("des", ""))[:180],
            "downloadUrls": urls,
            "status": "registry_entry_only",
        })
    return sorted(result, key=lambda x: (x["language"], x["file"].casefold()))


def verify_zip(file):
    p = Path(file)
    if p.stat().st_size > MAX_ARCHIVE_BYTES:
        raise AuditError("ZIP too large")
    with zipfile.ZipFile(p) as z:
        candidates = [x for x in z.infolist() if not x.is_dir() and re.search(r"\.(sqlite3|db)$", x.filename, re.I) and not SIDE_CAR.search(x.filename)]
        if len(candidates) != 1:
            raise AuditError("Expected exactly one Bible SQLite file (not a sidecar)")
        entry = candidates[0]
        if entry.file_size < 100 or entry.file_size > MAX_SQLITE_BYTES:
            raise AuditError("SQLite size outside limits")
        if entry.flag_bits & 0x1:
            raise AuditError("Encrypted ZIP unsupported")
        # Never extract archive paths into the filesystem.
        with tempfile.TemporaryDirectory(prefix="mybible-audit-") as tmp:
            dest = Path(tmp, "input.sqlite3")
            with z.open(entry) as source, dest.open("wb") as out:
                total = 0
                while block := source.read(1024 * 1024):
                    total += len(block)
                    if total > MAX_SQLITE_BYTES:
                        raise AuditError("SQLite decompressed beyond limit")
                    out.write(block)
            with dest.open("rb") as stream:
                signature = stream.read(16)
            if signature != b"SQLite format 3\x00":
                raise AuditError("Extracted content is not SQLite")
            with closing(sqlite3.connect(f"{dest.as_uri()}?mode=ro&immutable=1", uri=True)) as db:
                db.execute("PRAGMA query_only = ON")
                db.execute("PRAGMA trusted_schema = OFF")
                if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise AuditError("Corrupt SQLite")
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not BASE_REQUIRED.issubset(tables):
                    raise AuditError("Not a compatible MyBible translation: missing tables")
                expected = {"info": {"name", "value"}, "books": {"book_number", "short_name", "long_name"}, "verses": {"book_number", "chapter", "verse", "text"}}
                for table, columns in expected.items():
                    actual = {x[1] for x in db.execute(f"PRAGMA table_info({table})")}
                    if not columns.issubset(actual):
                        raise AuditError(f"Missing {table} columns")
                books = db.execute("SELECT COUNT(*) FROM books").fetchone()[0]
                count = db.execute("SELECT COUNT(*) FROM verses WHERE text IS NOT NULL AND TRIM(text) != ''").fetchone()[0]
                if not books or not count:
                    raise AuditError("No books or verses")
                blank_rows = db.execute("SELECT COUNT(*) FROM verses WHERE text IS NULL OR TRIM(text) = ''").fetchone()[0]
                orphan = db.execute("SELECT 1 FROM verses AS v LEFT JOIN books AS b ON v.book_number=b.book_number WHERE b.book_number IS NULL LIMIT 1").fetchone()
                if orphan:
                    raise AuditError("Verse references a missing book")
                duplicate = db.execute("SELECT 1 FROM verses GROUP BY book_number, chapter, verse HAVING COUNT(*)>1 LIMIT 1").fetchone()
                if duplicate:
                    raise AuditError("Duplicate verse coordinates")
                invalid = db.execute("SELECT 1 FROM verses WHERE book_number <= 0 OR chapter<=0 OR verse < 0 LIMIT 1").fetchone()
                if invalid:
                    raise AuditError("Invalid verse coordinates")
                language_row = db.execute("SELECT value FROM info WHERE name='language' LIMIT 1").fetchone()
            return {
                "archive": p.name,
                "sqliteEntry": entry.filename,
                "sqliteSha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
                "books": books,
                "nonEmptyVerseRows": count,
                "blankVerseRows": blank_rows,
                "warnings": (["Source contains empty verse rows; inspect before Android approval"] if blank_rows else []),
                "language": str(language_row[0]) if language_row else "",
                "status": "sqlite_structure_verified_android_not_tested",
            }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--registry")
    group.add_argument("--file", help="Downloaded translation ZIP to check")
    parser.add_argument("--languages", nargs="+", default=["tg", "mn"])
    args = parser.parse_args()
    try:
        result = {"languages": args.languages, "candidates": registry_candidates(read_registry(args.registry), set(args.languages))} if args.registry else verify_zip(args.file)
    except (AuditError, OSError, json.JSONDecodeError, zipfile.BadZipFile, sqlite3.DatabaseError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
