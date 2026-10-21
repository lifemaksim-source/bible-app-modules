// AUTO-GENERATED: enable only locales with complete UI + 78 book names.
import locale_kk from './locales/kk.json';
import books_kk from './books/kk.json';
import locale_ky from './locales/ky.json';
import books_ky from './books/ky.json';
import locale_tg from './locales/tg.json';
import books_tg from './books/tg.json';
import locale_tt from './locales/tt.json';
import books_tt from './books/tt.json';
import locale_uz from './locales/uz.json';
import books_uz from './books/uz.json';

export const EXTRA_LANGUAGE_NAMES = {
  kk: "Қазақша",
  ky: "Кыргызча",
  tg: "Тоҷикӣ",
  tt: "Татарча",
  uz: "Oʻzbekcha",
} as const;

export const EXTRA_RESOURCES = {
  kk: { translation: locale_kk },
  ky: { translation: locale_ky },
  tg: { translation: locale_tg },
  tt: { translation: locale_tt },
  uz: { translation: locale_uz },
};

export const EXTRA_BOOKS = {
  kk: books_kk,
  ky: books_ky,
  tg: books_tg,
  tt: books_tt,
  uz: books_uz,
};
