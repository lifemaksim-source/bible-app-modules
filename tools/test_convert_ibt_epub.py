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

    def test_no_text_fails_closed(self):
        with self.assertRaisesRegex(DraftError, "No unambiguous"):
            sqlite_draft({}, "gag", "b" * 64)


if __name__ == "__main__":
    unittest.main()
