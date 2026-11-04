// Language basics shared by the pages (i18n.js) and the server (lib/i18n.js, lib/consent.js).
// Pure and DOM-free. Catalogs are flat JSON objects in public/locales/<lang>.json whose keys name
// meanings ("fan.send"), not English sentences. Placeholders look like {name}.
export const LANGS = ['en', 'zh-Hans', 'zh-Hant'];

// Each language in its own words, the same in every catalog, so anyone can find theirs.
export const LANG_NAMES = { en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' };

export const isLang = (v) => LANGS.includes(v);

// The locale for Intl dates in each language (Taiwan usage for Traditional).
export const INTL = { en: 'en', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };

// A browser language tag to one of ours: zh-TW, zh-HK, zh-MO and zh-Hant to Traditional; zh-CN,
// zh-SG, zh-Hans and a bare zh to Simplified; any English to English. Anything else is null, so the
// event's default (or English) decides.
export function matchLang(tag) {
  const t = typeof tag === 'string' ? tag.toLowerCase() : '';
  if (/^en(-|$)/.test(t)) return 'en';
  if (!/^zh(-|$)/.test(t)) return null;
  return /^zh-(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-Hant' : 'zh-Hans';
}

// The words for key with {placeholders} filled from vars, or the key itself if it's missing.
// A key with plural forms has "<key>.one" and "<key>.other" entries instead, chosen by vars.count
// (Chinese only ever uses "other").
export function format(catalog, lang, key, vars = {}) {
  let s = catalog[key];
  if (s === undefined && typeof vars.count === 'number') {
    s = catalog[`${key}.${new Intl.PluralRules(lang).select(vars.count)}`] ?? catalog[`${key}.other`];
  }
  if (typeof s !== 'string') return key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

// The {placeholders} a string uses, for checking that translations keep them all.
export const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
