import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from scan_regional_mybible import (
    ALL_LANGUAGES, LANGUAGE_GROUPS, permitted_https, summary_from_registry,
    verify_one_per_language,
)


class RegionalRegistryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def registry(self):
        return {
            "version": 42,
            "hosts": [
                {"alias": "good", "path": "https://mybible.zone/repository/modules/%s.zip"},
                {"alias": "bad", "path": "http://example.com/%s.zip"},
            ],
            "downloads": [
                {"fil": "KM", "lng": "tg", "abr": "KM", "des": "Таджикский", "url": ["{good}KM"]},
                {"fil": "AB", "lng": "mn", "abr": "AB", "des": "Монгол", "url": ["{good}AB"]},
                {"fil": "BIBLE", "lng": "pl", "abr": "PL", "url": ["{good}PL"]},
                {"fil": "hidden", "lng": "bg", "hid": True, "url": ["{good}hidden"]},
                {"fil": "dictionary.dictionary", "lng": "tg", "url": ["{good}wordforms"]},
                {"fil": "RST", "lng": "ru", "url": ["{bad}RST"]},
            ],
        }

    def make_valid_zip(self, lang):
        dbfile = self.root / f"{lang}.db"
        with closing(sqlite3.connect(dbfile)) as db:
            db.executescript("""
                CREATE TABLE info(name TEXT, value TEXT);
                CREATE TABLE books(book_color TEXT, book_number INTEGER,
                    short_name TEXT, long_name TEXT, is_present INTEGER);
                CREATE TABLE verses(book_number INTEGER, chapter INTEGER, verse INTEGER, text TEXT);
                INSERT INTO books VALUES('', 470, 'MAT', 'Matthew', 1);
                INSERT INTO verses VALUES(470, 1, 1, 'Test translation');
            """)
            db.execute("INSERT INTO info VALUES('language', ?)", (lang,))
            db.commit()
        p = self.root / f"{lang}.zip"
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(dbfile, "sample.SQLite3")
        return p.read_bytes()

    def test_includes_all_priority_regions_and_minority_languages(self):
        self.assertTrue({"tg", "mn", "pl", "mk", "lt", "tt", "sah", "cv", "hu", "sq"} <= set(ALL_LANGUAGES))
        self.assertEqual(len(ALL_LANGUAGES), len(set(ALL_LANGUAGES)))
        self.assertIn("mn", LANGUAGE_GROUPS["mongolia"])

    def test_registry_only_includes_actual_https_bible_offers(self):
        report = summary_from_registry(self.registry(), ["tg", "mn", "bg", "pl", "ru"])
        self.assertEqual(report["languagesWithOffers"], 3)
        self.assertEqual(report["moduleOffers"], 3)
        self.assertEqual(set(report["languages"]), {"tg", "mn", "pl"})
        self.assertEqual(report["languages"]["tg"]["status"], "registry_listing_not_checked")
        self.assertFalse(permitted_https("http://mybible.zone/f.zip"))
        self.assertFalse(permitted_https("https://malicious.example/f.zip"))

    def test_probes_only_downloads_with_valid_declared_language(self):
        report = summary_from_registry(self.registry(), ["tg", "mn"])
        zip_by_url = {
            "https://mybible.zone/repository/modules/KM.zip": self.make_valid_zip("tg"),
            "https://mybible.zone/repository/modules/AB.zip": self.make_valid_zip("mn"),
        }
        out = verify_one_per_language(report, lambda url, limit: zip_by_url[url])
        self.assertEqual(out["languagesWithVerifiedSqlite"], 2)
        self.assertEqual(out["languages"]["tg"]["verified"]["books"], 1)
        self.assertEqual(out["languages"]["mn"]["verified"]["nonEmptyVerseRows"], 1)

    def test_rejects_mismatched_language_without_promoting_entry(self):
        report = summary_from_registry(self.registry(), ["tg"])
        out = verify_one_per_language(report, lambda url, limit: self.make_valid_zip("mn"))
        self.assertEqual(out["languagesWithVerifiedSqlite"], 0)
        self.assertEqual(out["languages"]["tg"]["status"], "no_compatible_archive_verified")
        self.assertIn("Module declares language", out["languages"]["tg"]["failures"][0]["reason"])

    def test_archive_errors_do_not_abort_other_languages(self):
        report = summary_from_registry(self.registry(), ["tg", "mn"])
        def remote(url, _):
            if "KM" in url:
                raise OSError("HTTP 403")
            return self.make_valid_zip("mn")
        out = verify_one_per_language(report, remote)
        self.assertEqual(out["languagesWithVerifiedSqlite"], 1)
        self.assertEqual(out["languages"]["tg"]["status"], "no_compatible_archive_verified")
        self.assertEqual(out["languages"]["mn"]["status"], "one_archive_sqlite_verified")


if __name__ == "__main__":
    unittest.main()
