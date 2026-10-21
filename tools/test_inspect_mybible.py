import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from inspect_mybible import ModuleError, inspect_module


class InspectModuleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name, "sample.SQLite3")
        with closing(sqlite3.connect(self.db)) as c:
            c.executescript("""
                CREATE TABLE info (name TEXT, value TEXT);
                CREATE TABLE books (book_color TEXT, book_number INTEGER, short_name TEXT, long_name TEXT, is_present INTEGER);
                CREATE TABLE verses (book_number INTEGER, chapter INTEGER, verse INTEGER, text TEXT);
                INSERT INTO info VALUES ('language', 'tg');
                INSERT INTO books VALUES ('', 470, 'MAT', 'Матто', 1);
                INSERT INTO verses VALUES (470, 1, 1, 'Матни озмоишӣ');
            """)
            c.commit()

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_partial_translation(self):
        report = inspect_module(str(self.db))
        self.assertEqual(report["books"], 1)
        self.assertEqual(report["verseRows"], 1)
        self.assertEqual(report["metadata"]["language"], "tg")
        self.assertEqual(report["inspection"], "structural_only_not_published")

    def test_unmapped_book_fails(self):
        with closing(sqlite3.connect(self.db)) as c:
            c.execute("UPDATE verses SET book_number = 999")
            c.commit()
        with self.assertRaisesRegex(ModuleError, "missing books"):
            inspect_module(str(self.db))

    def test_duplicate_address_fails(self):
        with closing(sqlite3.connect(self.db)) as c:
            c.execute("INSERT INTO verses VALUES (470, 1, 1, 'Повтор')")
            c.commit()
        with self.assertRaisesRegex(ModuleError, "Duplicate"):
            inspect_module(str(self.db))

    def test_missing_table_fails(self):
        with closing(sqlite3.connect(self.db)) as c:
            c.execute("DROP TABLE verses")
            c.commit()
        with self.assertRaisesRegex(ModuleError, "tables missing"):
            inspect_module(str(self.db))

    def test_non_sqlite_fails(self):
        self.db.write_bytes(b"not sqlite" * 20)
        with self.assertRaisesRegex(ModuleError, "Not an SQLite"):
            inspect_module(str(self.db))


if __name__ == "__main__":
    unittest.main()
