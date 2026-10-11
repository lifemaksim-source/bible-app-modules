"""Decode SWORD through pysword 0.2.8 (MIT); this is only a format adapter."""
import json
import sys
from pysword.modules import SwordModules

modules = SwordModules(sys.argv[1])
modules.parse_modules()
bible = modules.get_bible_from_module(sys.argv[2])
result = []
for testament in bible.get_structure().get_books().values():
    for book in testament:
        verses = []
        for chapter, length in enumerate(book.chapter_lengths, 1):
            for verse in range(1, length + 1):
                text = bible.get(books=book.osis_name, chapters=chapter, verses=verse).strip()
                if text:
                    verses.append([chapter, verse, text])
        result.append({'osis': book.osis_name, 'verses': verses})
with open(sys.argv[3], 'w', encoding='utf-8') as output:
    json.dump(result, output, ensure_ascii=False)
