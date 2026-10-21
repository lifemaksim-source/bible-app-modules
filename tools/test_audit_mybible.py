import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from audit_mybible import AuditError, NT_BOOKS, OT_BOOKS, read_registry, registry_candidates, scope_from_book_ids, verify_zip


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def registry(self):
        return {
            'version': 800,
            'hosts': [
                {'alias': 'mz', 'path': 'https://mybible.zone/repository/modules/%s.zip'},
                {'alias': 'old', 'path': 'http://insecure/%s.zip'},
            ],
            'downloads': [
                {'lng': 'tg', 'fil': 'KM', 'abr': 'KM', 'des': 'Китоби Муқаддас', 'url': ['{mz}KM']},
                {'lng': 'mn', 'fil': 'АБ', 'abr': 'АБ', 'des': 'Ариун Библи', 'url': ['{mz}%D0%90%D0%91']},
                {'lng': 'tg', 'fil': 'tg.dictionary', 'abr': 'tg', 'des': 'Wordforms', 'url': ['{mz}tg.dictionary']},
                {'lng': 'tg', 'fil': 'Hidden', 'abr': 'H', 'hid': True, 'url': ['{mz}Hidden']},
                {'lng': 'en', 'fil': 'KJV', 'abr': 'KJV', 'url': ['{mz}KJV']},
                {'lng': 'mn', 'fil': 'Broken', 'abr': 'B', 'url': ['{old}Broken']},
            ],
        }

    def test_registry_zip_gives_two_real_candidates(self):
        archive = self.p / 'registry.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('registry.json', json.dumps(self.registry(), ensure_ascii=False))
        records = registry_candidates(read_registry(archive), {'tg', 'mn'})
        self.assertEqual([(r['language'], r['file']) for r in records], [('mn', 'АБ'), ('tg', 'KM')])
        self.assertEqual(records[0]['downloadUrls'], ['https://mybible.zone/repository/modules/%D0%90%D0%91.zip'])
        self.assertTrue(all(r['status'] == 'registry_entry_only' for r in records))

    def test_invalid_registry_rejected(self):
        file = self.p / 'empty.json'
        file.write_text('{"downloads":"not list"}')
        with self.assertRaises(AuditError):
            read_registry(file)

    def make_db(self):
        p = self.p / 'KM.SQLite3'
        with closing(sqlite3.connect(p)) as db:
            db.executescript("""CREATE TABLE info (name TEXT, value TEXT);
             INSERT INTO info VALUES ('language','tg');
             CREATE TABLE books (book_color TEXT,book_number INTEGER,short_name TEXT,long_name TEXT,is_present INTEGER);
             INSERT INTO books VALUES ('',470,'MAT','Матто',1);
             CREATE TABLE verses (book_number INTEGER,chapter INTEGER,verse INTEGER,text TEXT);
             INSERT INTO verses VALUES (470,1,1,'Китоби Муқаддас');""")
            db.commit()
        return p

    def test_real_zip_with_sidecar(self):
        p = self.make_db()
        archive = self.p / 'Tajik.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(p, 'folder/KM.SQLite3')
            z.writestr('KM.commentaries.SQLite3', 'unverified')
        result = verify_zip(archive)
        self.assertEqual(result['nonEmptyVerseRows'], 1)
        self.assertEqual(result['books'], 1)
        self.assertEqual(result['canonicalScope'], 'partial')
        self.assertEqual(result['booksWithNonEmptyText'], [470])
        self.assertEqual(result['blankVerseAddressSample'], [])
        self.assertEqual(result['missingChapterSamples'], {})
        self.assertEqual(result['language'], 'tg')
        self.assertEqual(result['status'], 'sqlite_structure_verified_android_not_tested')

    def test_equal_book_counts_do_not_make_mixed_27_books_a_new_testament(self):
        mixed = set(sorted(OT_BOOKS)[:6]) | set(sorted(NT_BOOKS)[:21])
        self.assertEqual(len(mixed), 27)
        self.assertEqual(scope_from_book_ids(mixed), 'partial')
        self.assertEqual(scope_from_book_ids(NT_BOOKS), 'nt')
        self.assertEqual(scope_from_book_ids(OT_BOOKS | NT_BOOKS), 'bible')

    def test_rejects_bad_zip(self):
        p = self.p / 'bad.zip'
        with zipfile.ZipFile(p, 'w') as z:
            z.writestr('KM.SQLite3', b'x'*200)
        with self.assertRaises(AuditError):
            verify_zip(p)

    def test_rejects_duplicate_verse(self):
        p = self.make_db()
        with closing(sqlite3.connect(p)) as db:
            db.execute("INSERT INTO verses VALUES (470,1,1,'Дигар')")
            db.commit()
        archive = self.p / 'bad.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(p, 'KM.SQLite3')
        with self.assertRaisesRegex(AuditError, 'Duplicate'):
            verify_zip(archive)

    def test_reports_blank_verse_placeholder_without_altering_source(self):
        p = self.make_db()
        with closing(sqlite3.connect(p)) as db:
            db.execute("UPDATE verses SET text = ' '")
            db.commit()
        archive = self.p / 'bad.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(p, 'KM.SQLite3')
        with self.assertRaisesRegex(AuditError, "No books or verses"):
            verify_zip(archive)

    def test_mixed_blank_and_valid_verses_allowed_with_warning(self):
        p = self.make_db()
        with closing(sqlite3.connect(p)) as db:
            db.execute("INSERT INTO verses VALUES (470, 1, 2, ' ')")
            db.commit()
        archive = self.p / "mixed.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.write(p, "KM.SQLite3")
        result = verify_zip(archive)
        self.assertEqual(result["nonEmptyVerseRows"], 1)
        self.assertEqual(result["blankVerseRows"], 1)
        self.assertEqual(result["blankVerseAddressSample"], [{"bookNumber": 470, "chapter": 1, "verse": 2}])
        self.assertEqual(result["booksWithNonEmptyText"], [470])
        self.assertTrue(result["warnings"])

    def test_reports_non_contiguous_chapter_numbers(self):
        p = self.make_db()
        with closing(sqlite3.connect(p)) as db:
            db.execute("INSERT INTO verses VALUES(470, 3, 1, 'Дигар')")
            db.commit()
        archive = self.p / "gaps.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.write(p, "KM.SQLite3")
        result = verify_zip(archive)
        self.assertEqual(result["missingChapterSamples"], {"470": [2]})
        self.assertEqual(result["booksWithNonEmptyText"], [470])

    def test_rejects_missing_book(self):
        p = self.make_db()
        with closing(sqlite3.connect(p)) as db:
            db.execute('DELETE FROM books')
            db.commit()
        archive = self.p / 'bad.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(p, 'KM.SQLite3')
        with self.assertRaisesRegex(AuditError, 'No books'):
            verify_zip(archive)


if __name__ == '__main__':
    unittest.main()
