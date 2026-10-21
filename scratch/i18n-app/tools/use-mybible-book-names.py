"""Use the actual book names from installed-format MyBible ZIPs, where available.

Complements the UI draft translator: never machine-invent a name when the
real Scripture module provides it. Works on JSONs already in src/i18n/books.
No Bible texts are saved. Python standard library only.
"""
import json
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile
from io import BytesIO

BOOKS = {
    "tg": "KM'92", "mn": "АБ'2013", "kk": "KAZB'10", "uz": "UZB",
    "ky": "KYB", "tt": "TTRB", "ba": "BaI", "sah": "YKT",
}


def official_book_names(lang, file_code):
    url = "https://mybible.zone/repository/modules/" + quote(file_code, safe="") + ".zip"
    with urlopen(Request(url, headers={"User-Agent": "BibleApp/UI-book-labels"}), timeout=30) as response:
        archive = response.read(24 * 1024 * 1024 + 1)
    if len(archive) > 24 * 1024 * 1024:
        raise ValueError("Download exceeds book-name extraction limit")
    with zipfile.ZipFile(BytesIO(archive)) as z:
        candidates = [f for f in z.infolist() if not f.is_dir() and
                      f.filename.lower().endswith(".sqlite3") and
                      ".commentaries." not in f.filename.lower() and
                      ".dictionary." not in f.filename.lower()]
        if len(candidates) != 1 or candidates[0].file_size > 96 * 1024 * 1024:
            raise ValueError("Unexpected MyBible SQLite archive")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "module.sqlite3"
            path.write_bytes(z.read(candidates[0]))
            db = sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True)
            try:
                rows = db.execute("SELECT book_number, short_name, long_name FROM books").fetchall()
            finally:
                db.close()
    names = {}
    for number, abbr, full in rows:
        if not isinstance(number, int):
            continue
        name = str(full or "").strip()
        short = str(abbr or "").strip()
        if name and len(name) <= 140:
            names[str(number)] = {"name": name, "abbr": short or name[:6]}
    return names


def main():
    for lang, file_code in BOOKS.items():
        output = Path("src/i18n/books") / f"{lang}.json"
        if not output.is_file():
            continue
        books = json.loads(output.read_text("utf8"))
        try:
            official = official_book_names(lang, file_code)
            merged = 0
            for number, entry in official.items():
                if number in books:
                    books[number] = entry
                    merged += 1
            if not merged:
                raise ValueError("No matching canonical IDs")
            output.write_text(json.dumps(books, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
            print(lang, merged, "native book names from official MyBible module")
        except Exception as exc:
            print("WARNING", lang, "keeping machine-draft names:", str(exc)[:160])


if __name__ == "__main__":
    main()
