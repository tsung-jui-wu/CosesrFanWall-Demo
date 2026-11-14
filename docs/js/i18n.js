// Languages for every page: English, Simplified Chinese, Traditional Chinese. The words live in
// public/locales/<lang>.json. Scripts call t(key, vars); static HTML marks text with data-i18n (plus
// data-i18n-vars for placeholders) and attributes with data-i18n-aria-label, -placeholder, -alt.
//
// Pages mark where the switcher goes with <div class="lang-switch" data-lang-switch></div>
// (data-lang-label names a more specific label key); this module builds it.
//
// Which language: the person's own pick on this device (localStorage only, never sent anywhere),
// else their browser when it asks for English or Chinese, else the event's default, else English.
// The print sign is read by the people who scan it, so there the event default comes first.
// Importing this module waits for the catalog, so t() is ready in every page script.
import { LANGS, LANG_NAMES, INTL, isLang, matchLang, format } from './i18n-core.js';

const root = document.documentElement;
const SCOPE = root.dataset.langScope || ''; // "print" on the sign, so its choice doesn't move the dashboard
const STORE_KEY = SCOPE ? `fanwall:lang:${SCOPE}` : 'fanwall:lang';
const catalogs = {};
const listeners = new Set();
let eventLang = null;
export let lang = 'en';

function picked() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}
const browserTags = () => (navigator.languages?.length ? [...navigator.languages] : [navigator.language || '']);
const fromBrowser = () => browserTags().map(matchLang).find(Boolean) ?? null;
const automatic = () => (SCOPE === 'print' ? eventLang ?? fromBrowser() : fromBrowser() ?? eventLang) ?? 'en';

async function load(l) {
  if (catalogs[l]) return;
  // Relative to this module, so it works on the server and under any folder in the static demo.
  const res = await fetch(new URL(`../locales/${l}.json`, import.meta.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  catalogs[l] = await res.json();
}

export const t = (key, vars) => format(catalogs[lang] ?? {}, lang, key, vars);
export const has = (key) => Object.hasOwn(catalogs[lang] ?? {}, key);

const ATTRS = ['aria-label', 'placeholder', 'alt', 'title'];
function readVars(node) {
  try { return node.dataset.i18nVars ? JSON.parse(node.dataset.i18nVars) : undefined; } catch { return undefined; }
}
export function translate(scope = document) {
  for (const node of scope.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n, readVars(node));
  for (const attr of ATTRS) {
    for (const node of scope.querySelectorAll(`[data-i18n-${attr}]`)) node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
  }
}

// Sets a node's text and remembers the key, so a language switch re-translates it. An empty key clears it.
export function setText(node, key, vars) {
  if (!key) {
    delete node.dataset.i18n;
    delete node.dataset.i18nVars;
    node.textContent = '';
    return;
  }
  node.dataset.i18n = key;
  if (vars) node.dataset.i18nVars = JSON.stringify(vars);
  else delete node.dataset.i18nVars;
  node.textContent = t(key, vars);
}
export const setTitle = (key, vars) => setText(document.querySelector('title'), key, vars);

// Server errors arrive as codes ({ error: 'too_long', field: 'message', max: 280 }); this finds their words.
export function errorKey(body, status) {
  const code = typeof body?.error === 'string' ? body.error : '';
  if (!code || !has(`error.${code}`)) return { key: 'error.http', vars: { status } };
  const vars = { ...body };
  if (typeof vars.field === 'string' && has(`field.${vars.field}`)) vars.field = t(`field.${vars.field}`);
  return { key: `error.${code}`, vars };
}

// Dates in the page language; a browser that asks for, say, en-GB keeps its own date style.
const intlTag = () => browserTags().find((tag) => matchLang(tag) === lang) ?? INTL[lang];
export const formatDate = (ts) => new Intl.DateTimeFormat(intlTag(), { dateStyle: 'long' }).format(ts);
export const formatDateTime = (ts) => new Intl.DateTimeFormat(intlTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(ts);

export const onLangChange = (fn) => listeners.add(fn);

function apply() {
  root.lang = lang;
  // Which Chinese glyph shapes fan-written text gets on an English page (see --font-cjk in app.css).
  root.dataset.cjk = lang !== 'en' ? lang
    : eventLang && eventLang !== 'en' ? eventLang
    : browserTags().map(matchLang).find((l) => l && l !== 'en') ?? 'zh-Hans';
  translate();
  for (const item of document.querySelectorAll('[data-lang-switch] [data-lang]')) item.setAttribute('aria-checked', String(item.dataset.lang === lang));
}

// Re-translates the page; listeners redraw what they built themselves. Keeps the current language
// if the new catalog can't be loaded.
async function switchTo(next) {
  try { await load(next); } catch { return false; }
  const changed = next !== lang;
  lang = next;
  apply();
  if (changed) for (const fn of listeners) fn(lang);
  return true;
}

// The person's own choice, from a switcher. Remembered on this device only.
export async function setLang(next) {
  if (!isLang(next)) return;
  try { localStorage.setItem(STORE_KEY, next); } catch {}
  await switchTo(next);
}

// Pages call this once they know the event's default language (null when the organizer set none).
export async function useEventLang(l) {
  eventLang = isLang(l) ? l : null;
  await switchTo(picked() ?? automatic());
}

// ---------- the switcher: a globe button that opens a small menu ----------
const SVG = 'http://www.w3.org/2000/svg';
function svgNode(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
// Outline globe in currentColor: the edge, one meridian, the equator, and two latitudes.
function globe() {
  const svg = svgNode('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.6, 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false',
  });
  svg.append(
    svgNode('circle', { cx: 12, cy: 12, r: 9 }),
    svgNode('ellipse', { cx: 12, cy: 12, rx: 4, ry: 9 }),
    svgNode('path', { d: 'M3 12h18M4.8 7.5h14.4M4.8 16.5h14.4' }),
  );
  return svg;
}

function mountSwitcher(box) {
  const labelKey = box.dataset.langLabel || 'lang.label';
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'lang-button', title: t(labelKey) });
  button.setAttribute('aria-label', t(labelKey));
  button.setAttribute('data-i18n-aria-label', labelKey);
  button.setAttribute('data-i18n-title', labelKey);
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.append(globe());

  const menu = Object.assign(document.createElement('ul'), { className: 'lang-menu', hidden: true });
  menu.setAttribute('role', 'menu');
  // Each language in its own words, marked with its own lang so screen readers say it right.
  const items = LANGS.map((l) => {
    const item = Object.assign(document.createElement('button'), { type: 'button', lang: l, textContent: LANG_NAMES[l] });
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(l === lang));
    item.dataset.lang = l;
    item.addEventListener('click', () => { close(); setLang(l); });
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    li.append(item);
    menu.append(li);
    return item;
  });

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items.find((i) => i.dataset.lang === lang) ?? items[0]).focus();
  }
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      items[(to + items.length) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault(); // inside the Manage drawer, Escape closes only the menu
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) close(false); });
  box.append(button, menu);
}

// ---------- start ----------
const first = picked() ?? automatic();
if (!(await switchTo(first)) && first !== 'en') await switchTo('en');
for (const box of document.querySelectorAll('[data-lang-switch]')) mountSwitcher(box);
root.classList.remove('i18n-pending');
