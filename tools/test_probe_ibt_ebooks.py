import hashlib
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
import zipfile
from probe_ibt_ebooks import inspect_ebook, inspect_xml, fetch_ibt, probe_registry

FB2 = b'''<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
<body><section id="Mt"><title><p>Matthew</p></title>
<section id="Mt.1"><title><p>1</p></title>
<p><strong>1</strong> text of verse one.</p><p><strong>2</strong> text of verse two.</p>
</section></section></body></FictionBook>
'''


def zips(*members):
    b = BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as out:
        for name, value in members:
            out.writestr(name, value)
    return b.getvalue()


class IbtebooksTest(unittest.TestCase):
    def test_fb2_zip_discovers_paragraphs_but_not_verse_text(self):
        blob = zips(("Bible.fb2", FB2))
        result = inspect_ebook(blob, "fb2.zip")
        self.assertEqual(result["ebookFormat"], "fb2.zip")
        self.assertEqual(result["fileSha256"], hashlib.sha256(blob).hexdigest())
        p = result["profiles"][0]["structure"]
        self.assertEqual(p["rootTag"], "fictionbook")
        self.assertGreaterEqual(dict(p["tagCounts"])["section"], 2)
        self.assertGreaterEqual(p["paragraphsStartingWithNumber"], 1)
        self.assertNotIn("text of verse", json.dumps(result))

    def test_epub_parses_html_attributes_without_scripture(self):
        blob = zips(("OEBPS/text/1.xhtml", b'<html><body><p class="v">Verse 1</p><sup class="versenum">1</sup></body></html>'))
        result = inspect_ebook(blob, "epub")
        self.assertEqual(result["profiles"][0]["structure"]["format"], "xhtml")
        self.assertIn("sup", dict(result["profiles"][0]["structure"]["tagCounts"]))
        self.assertNotIn("Verse 1", json.dumps(result))

    def test_rejects_zips_without_text(self):
        with self.assertRaisesRegex(ValueError, "No FB2/XHTML"):
            inspect_ebook(zips(("cover.jpg", b"hi")), "epub")

    def test_rejects_path_traversal(self):
        with self.assertRaisesRegex(ValueError, "Unsafe member"):
            inspect_ebook(zips(("../evil.fb2", FB2)), "fb2.zip")

    def test_rejects_entities(self):
        with self.assertRaisesRegex(ValueError, "DTD/entities"):
            inspect_xml(b'<!DOCTYPE a [<!ENTITY foo "bar">]><FictionBook>&foo;</FictionBook>', "fb2")

    def test_registry_records_are_not_published(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "registry.json"
            source.write_text(json.dumps({"records": [
                {"sourceKind": "digital_ebook_listing", "language": "tab",
                 "sourceUrl": "https://ibtrussia.org/Tabasaran", "digitalDownloadUrl": "https://ibtrussia.org/sites/default/files/ebm/ebook/test.fb2.zip",
                 "digitalFormat": "fb2.zip"}
            ]}))
            report = probe_registry(source, lambda url: zips(("test.fb2", FB2)))
            self.assertEqual(report["verified"], 1)
            self.assertEqual(report["items"][0]["status"], "bytes_inspected_not_converted")

    def test_source_whitelist(self):
        with self.assertRaisesRegex(ValueError, "Untrusted"):
            fetch_ibt("https://example.com/file.fb2")


if __name__ == "__main__":
    unittest.main()
