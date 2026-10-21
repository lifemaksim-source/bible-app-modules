import io
from pathlib import Path
import tempfile
import unittest
import zipfile

from convert_ibt_epub import DraftError, VerseHtml, extract_epub, sqlite_draft


def make_epub(items):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, html in items:
            z.writestr(name, html)
    return out.getvalue()


CHAPTER = """
<html><body>
<h2 class="osis-s">Title not Scripture</h2>
<p class="osis-p"><span id="_1Cor.1.1"><sup class="xsl-verse-number">1</sup></span>
First <em>verse</em> text.<a epub:type="noteref" class="osis-note" href="#note">a</a>
<span id="_1Cor.1.2"><sup>2</sup></span> Second verse.</p>
<p class="osis-p">Continuation of verse two.</p>
<h3>Should not be in last verse</h3>
</body></html>"""


class EpubDraftTest(unittest.TestCase):
    def test_anchor_is_address_and_text_follows_span(self):
        p = VerseHtml()
        p.feed(CHAPTER)
        rows = dict(p.finish())
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[(530,1,1)], "First verse text.")
        self.assertEqual(rows[(530,1,2)], "Second verse. Continuation of verse two.")
        self.assertEqual(p.seen_anchors, 2)
        self.assertEqual(p.skipped_anchors, 0)
        self.assertNotIn("Title", repr(rows))
        self.assertNotIn("Should not", repr(rows))

    def test_proverbs_and_other_poetry_lines_are_real_verse_text(self):
        p = VerseHtml()
        p.feed('<div class="osis-lg"><div class="osis-l"><span id="Prov.1.1"><sup>1</sup></span>First line</div>'
               '<div class="osis-l1"><span id="Prov.1.2"><sup>2</sup></span>Second line</div></div>')
        self.assertEqual(dict(p.finish()), {
            (240, 1, 1): 'First line',
            (240, 1, 2): 'Second line',
        })

    def test_footnotes_not_accidentally_attached_to_preceding_verse(self):
        p = VerseHtml()
        p.feed('<p class="osis-p"><span id="Gen.1.1"><sup>1</sup></span>Real Scripture</p>'
               '<div class="xsl-footnote-section"><p class="osis-p">Publisher note</p></div>')
        self.assertEqual(dict(p.finish()), {(10, 1, 1): 'Real Scripture'})

    def test_hyperlinks_are_not_verse_addresses(self):
        p = VerseHtml()
        p.feed('<html><p class="osis-p"><a href="#Matt.1.1">reference</a></p></html>')
        self.assertEqual(p.finish(), [])

    def test_english_osis_ids_supported_without_underscore(self):
        p = VerseHtml()
        p.feed('<p class="osis-p"><span id="Gen.25.1"><sup>1</sup></span>Hello</p>')
        self.assertEqual(p.finish(), [((10,25,1), "Hello")])

    def test_duplicate_anchor_is_rejected_instead_of_silent_merge(self):
        epub = make_epub([("a.xhtml", CHAPTER), ("b.xhtml", CHAPTER)])
        with self.assertRaisesRegex(DraftError, "Duplicated verse anchor"):
            extract_epub(epub)

    def test_epub_partial_scope_preserved(self):
        epub = make_epub([("OEBPS/scripture.xhtml", CHAPTER)])
        parsed = extract_epub(epub)
        self.assertEqual(parsed["verseAnchors"], 2)
        self.assertEqual(len(parsed["verses"]), 2)
        self.assertEqual(parsed["filesWithVerses"], 1)
        self.assertEqual(parsed["unknownBooks"], {})

    def test_unknown_book_not_invented(self):
        epub = make_epub([("p.xhtml", '<p class="osis-p"><span id="Imagined.1.1"></span>Hi</p>')])
        parsed = extract_epub(epub)
        self.assertEqual(parsed["verses"], {})
        self.assertEqual(parsed["unknownBooks"], {"Imagined": 1})

    def test_sqlite_draft_schema_for_partial_translation(self):
        rows = {(240, 1, 1): "Verse 1", (240, 1, 3): "Verse 3"}
        result = sqlite_draft(rows, "dng", "a" * 64)
        self.assertEqual(result["books"], 1)
        self.assertEqual(result["bookNumbers"], [240])
        self.assertEqual(result["verseRows"], 2)
        self.assertEqual(len(result["sqliteSha256"]), 64)
        self.assertIn("not_published", result["status"])

    def test_real_registry_draft_status_is_not_skipped(self):
        import json
        from unittest.mock import patch
        from convert_ibt_epub import test_registry as run_registry
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "entries.json"
            source.write_text(json.dumps({"records": [{
                "language": "lbe", "sourceKind": "digital_epub_draft",
                "digitalEpubUrl": "https://ibtrussia.org/sites/default/files/ebm/ebook/safe/edition.epub"
            }]}), encoding="utf8")
            with patch("convert_ibt_epub.fetch_ibt", return_value=make_epub([("body.xhtml", CHAPTER)])):
                report = run_registry(source)
            self.assertEqual(report["attempted"], 1)
            self.assertEqual(report["draftsWithVerses"], 1)


    def test_exact_unicode_verse_survives_sqlite_without_text_replacement(self):
        source = {(470, 1, 1): "Ӏарбий гӀалгӀай — сагӀа́. 日本語 Ω"}
        report = sqlite_draft(source, "inh", "a" * 64)
        self.assertEqual(report["verseRows"], 1)
        self.assertEqual(report["books"], 1)

    def test_blank_anchors_diagnosed_without_inventing_verse(self):
        parser = VerseHtml()
        parser.feed('<p class="osis-p"><span id="Gen.1.1"><sup>1</sup></span>'
                    '<span id="Gen.1.2"><sup>2</sup></span> Real verse two</p>')
        rows = dict(parser.finish())
        self.assertEqual(rows, {(10, 1, 2): "Real verse two"})
        self.assertEqual(parser.skipped_anchors, 1)
        self.assertEqual(parser.blank_reasons["only_number_or_marker"], 1)
        self.assertEqual(parser.blank_samples[0]["verse"], 1)

    def test_direct_osis_div_verse_text_is_not_dropped(self):
        parser = VerseHtml()
        parser.feed('<div class="calibre1"><div class="osis-div">'
                    '<span id="Gen.10.2"></span> Text in OSIS div, not a paragraph.'
                    '<span id="Gen.10.3"></span> Another verse.</div></div>')
        self.assertEqual(dict(parser.finish()), {
            (10, 10, 2): "Text in OSIS div, not a paragraph.",
            (10, 10, 3): "Another verse.",
        })
        self.assertEqual(parser.skipped_anchors, 0)

    def test_inline_links_in_direct_osis_div_are_scripture_text(self):
        parser = VerseHtml()
        parser.feed('<div class="osis-div"><span id="Gen.10.2"></span>'
                    '<a class="osis-reference" href="glossary.xhtml">One</a> '
                    '<em>two</em><span id="Gen.10.3"></span>'
                    '<span class="osis-hi">Three</span></div>')
        self.assertEqual(dict(parser.finish()), {
            (10, 10, 2): "One two",
            (10, 10, 3): "Three",
        })

    def test_nested_non_osis_block_does_not_qualify_as_direct_scripture(self):
        parser = VerseHtml()
        parser.feed('<div class="osis-div"><span id="Gen.1.1"></span>'
                    '<div class="publisher-caption"><a>Not Scripture</a></div>'
                    '<a>Actual verse</a></div>')
        self.assertEqual(dict(parser.finish()), {(10, 1, 1): "Actual verse"})


    def test_osis_list_items_contain_real_scripture_in_original_verse(self):
        html = ('<div class="calibre1"><div class="osis-div"><ol class="osis-list">'
                '<li class="osis-item"><span id="Gen.10.2"></span>'
                '<span>First family</span></li>'
                '<li class="osis-item1"><span id="Gen.10.3"></span>'
                '<a class="osis-reference">Second family</a></li>'
                '</ol></div></div>')
        parser = VerseHtml()
        parser.feed(html)
        self.assertEqual(dict(parser.finish()), {
            (10, 10, 2): "First family",
            (10, 10, 3): "Second family",
        })
        self.assertEqual(parser.skipped_anchors, 0)

    def test_regular_lists_and_publisher_notes_never_create_scripture(self):
        html = ('<div class="calibre1"><ol class="list"><li class="osis-item">'
                '<span id="Gen.1.1"></span>Editorial navigation</li></ol>'
                '<div class="xsl-footnote-section"><ol class="osis-list">'
                '<li class="osis-item">Note-only reference</li></ol></div></div>')
        parser = VerseHtml()
        parser.feed(html)
        self.assertEqual(parser.finish(), [])
        self.assertEqual(parser.skipped_anchors, 1)

    def test_unrelated_non_osis_div_and_titles_are_not_attached(self):
        parser = VerseHtml()
        parser.feed('<div class="calibre1"><span id="Gen.1.1"></span>'
                    '<div class="publisher-intro">Unrelated heading</div>'
                    '<div class="osis-div">Actual verse content</div></div>')
        self.assertEqual(dict(parser.finish()), {(10, 1, 1): "Actual verse content"})

    def test_note_only_content_is_not_mistaken_for_scripture(self):
        parser = VerseHtml()
        parser.feed('<p class="osis-p"><span id="Gen.1.1"></span>'
                    '<a class="osis-note" epub:type="noteref">footnote symbol</a>'
                    '<span id="Gen.1.2"></span> Real text</p>')
        rows = dict(parser.finish())
        self.assertEqual(rows, {(10, 1, 2): "Real text"})
        self.assertEqual(parser.blank_reasons["notes_only"], 1)
        self.assertEqual(parser.note_reference_count, 1)

    def test_rejects_epub_invalid_utf8_instead_of_corrupting_scripture(self):
        epub = make_epub([("a.xhtml", b'<p class="osis-p"><span id="Gen.1.1"></span>\xff</p>')])
        with self.assertRaises(UnicodeDecodeError):
            extract_epub(epub)


    def test_local_zip_is_importable_mybible_sqlite_and_never_written_by_default(self):
        import sqlite3
        rows = {(470, 1, 1): "Салам, дүйнө! Ӏараб", (470, 1, 3): "Second verse."}
        with tempfile.TemporaryDirectory() as root:
            out = Path(root)
            original = sqlite_draft(rows, "inh", "a" * 64)
            self.assertNotIn("localTestZip", original)
            self.assertEqual(list(out.iterdir()), [])
            result = sqlite_draft(rows, "inh", "a" * 64, local_test_dir=out)
            archive = Path(result["localTestZip"])
            self.assertEqual(archive.name, "IBT_inh_LOCAL_TEST_ONLY.zip")
            with zipfile.ZipFile(archive) as z:
                self.assertEqual(z.namelist(), ["IBT_inh.SQLite3"])
                db_file = out / "private.sqlite3"
                db_file.write_bytes(z.read("IBT_inh.SQLite3"))
            with sqlite3.connect(db_file) as db:
                self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")
                self.assertEqual(db.execute(
                    "SELECT book_number, chapter, verse, text FROM verses ORDER BY verse"
                ).fetchall(), [(470, 1, 1, rows[(470, 1, 1)]),
                               (470, 1, 3, rows[(470, 1, 3)])])
                self.assertEqual(db.execute("SELECT value FROM info WHERE name='language'").fetchone()[0], "inh")
            with self.assertRaises(FileExistsError):
                sqlite_draft(rows, "inh", "a" * 64, local_test_dir=out)

    def test_local_test_zip_restricted_to_audited_sources(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(DraftError, "audited IBT"):
                sqlite_draft({(470, 1, 1): "Test"}, "not-a-language", "a" * 64,
                             local_test_dir=Path(root))

    def test_no_text_fails_closed(self):
        with self.assertRaisesRegex(DraftError, "No unambiguous"):
            sqlite_draft({}, "gag", "b" * 64)


if __name__ == "__main__":
    unittest.main()
