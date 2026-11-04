// The server's own words (messages.txt in the ZIP) come from the same catalogs as the pages.
// API errors never need this: they are codes, and the pages put them into words.
import fs from 'node:fs';
import { LANGS, format } from '../public/js/i18n-core.js';

const catalogs = Object.fromEntries(LANGS.map((l) =>
  [l, JSON.parse(fs.readFileSync(new URL(`../public/locales/${l}.json`, import.meta.url), 'utf8'))]));

export const translate = (lang, key, vars) => format(catalogs[lang] ?? catalogs.en, lang, key, vars);
