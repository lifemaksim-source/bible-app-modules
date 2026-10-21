"""Read-only structural inspection of a locally downloaded MyBible SQLite translation.

This does not certify Bible text accuracy, numbering, licensing, or Android compatibility.
Usage: python3 tools/inspect_mybible.py translation.SQLite3
"""
import argparse
import json
import hashlib
import sqlite3
from pathlib import Path


class ModuleError(Exception):
    pass


def inspect_module(filename: str) -> dict:
    path = Path(filename).resolve(strict=True)
    if not path.is_file() or path.stat().st_size < 100:
        raise ModuleError("Missing or unexpectedly small SQLite file")
    with path.open("rb") as handle:
        if handle.read(16) != b"SQLite format 3\x00":
            raise ModuleError("Not an SQLite 3 database")

    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA trusted_schema = OFF")
        check = connection.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise ModuleError(f"SQLite quick_check failed: {check}")
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        required = {"info", "books", "verses"}
        if not required.issubset(tables):
            raise ModuleError(f"Required MyBible tables missing: {sorted(required - tables)}")
        columns = {
            table: {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            for table in required
        }
        expected = {
            "info": {"name", "value"},
            "books": {"book_number", "short_name", "long_name"},
            "verses": {"book_number", "chapter", "verse", "text"},
        }
        for table, names in expected.items():
            if not names.issubset(columns[table]):
                raise ModuleError(f"Unsupported {table} columns: missing {sorted(names - columns[table])}")
        book_count = connection.execute("SELECT COUNT(*) FROM books").fetchone()[0]
        verse_count = connection.execute("SELECT COUNT(*) FROM verses").fetchone()[0]
        if book_count < 1 or verse_count < 1:
            raise ModuleError("Module contains no books or verses")
        if connection.execute("SELECT 1 FROM verses WHERE book_number <= 0 OR chapter <= 0 OR verse < 0 LIMIT 1").fetchone():
            raise ModuleError("Invalid book/chapter/verse addresses")
        blank_rows = connection.execute("SELECT COUNT(*) FROM verses WHERE text IS NULL OR TRIM(text) = ''").fetchone()[0]
        if connection.execute("SELECT 1 FROM verses GROUP BY book_number, chapter, verse HAVING COUNT(*) > 1 LIMIT 1").fetchone():
            raise ModuleError("Duplicate verse addresses")
        if connection.execute("SELECT 1 FROM verses v LEFT JOIN books b ON v.book_number = b.book_number WHERE b.book_number IS NULL LIMIT 1").fetchone():
            raise ModuleError("Verses reference missing books")
        sample = connection.execute("SELECT book_number, chapter, verse, substr(text,1,140) FROM verses ORDER BY book_number, chapter, verse LIMIT 1").fetchone()
        metadata = {}
        for name, value in connection.execute("SELECT name, value FROM info"):
            if isinstance(name, str) and name in {"description", "language", "origin", "year", "code", "numbering", "license", "app_format"}:
                metadata[name] = str(value or "")[:300]
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        return {
            "sha256": digest,
            "inspection": "structural_only_not_published",
            "file": path.name,
            "sizeBytes": path.stat().st_size,
            "sqliteQuickCheck": "ok",
            "books": book_count,
            "verseRows": verse_count,
            "blankVerseRows": blank_rows,
            "bookNumbersWithVerses": connection.execute("SELECT COUNT(DISTINCT book_number) FROM verses").fetchone()[0],
            "sample": {"bookNumber": sample[0], "chapter": sample[1], "verse": sample[2], "textStart": sample[3]},
            "metadata": metadata,
            "warnings": ["Verse numbering, text fidelity, and Android loading were not verified"] +
                        (["Source contains blank verse placeholders"] if blank_rows else []),
        }
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="Extracted MyBible .SQLite3 or project .db file")
    args = parser.parse_args()
    try:
        result = inspect_module(args.file)
    except (OSError, sqlite3.Error, ModuleError) as exc:
        print(json.dumps({"inspection": "failed", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
