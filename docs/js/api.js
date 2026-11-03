// Small fetch + DOM helpers shared by the pages.

// The view-only demo (scripts/export-static.js, for GitHub Pages) marks its pages <html data-static>.
// There is no server there: reads come from pre-built JSON files, and a few changes are kept on the
// page only (gone on reload). Every path is relative to the page's <base>, so the site works under
// any folder, such as https://user.github.io/repo/.
export const STATIC = document.documentElement.hasAttribute('data-static');

// An app path ("/r/abc") as a link: unchanged on the server, relative to <base> in the static demo.
export const url = (path) => (STATIC ? path.replace(/^\//, '') : path);

// The path segment after `name`, e.g. the token in /r/<token>, wherever the site is mounted.
export function segmentAfter(name) {
  const parts = location.pathname.split('/');
  const i = parts.lastIndexOf(name);
  return i < 0 ? '' : decodeURIComponent(parts[i + 1] || '');
}

export const VIEW_ONLY = "This is a view-only demo, so that's turned off.";

// Changes that make sense to try in the demo, answered the way the server would; nothing is stored.
const LOCAL_CHANGES = [
  [/^\/api\/reveal\/[^/]+\/items\/[^/]+\/edit$/, 'POST', (body) => ({ edit: body.edit })],
  [/^\/api\/reveal\/[^/]+\/items\/[^/]+$/, 'POST', (body) => ({ hidden: body.hidden })],
  [/^\/api\/reveal\/[^/]+\/items\/[^/]+$/, 'DELETE', () => ({ ok: true })],
  [/^\/api\/reveal\/[^/]+\/optout$/, 'POST', () => ({ ok: true })],
  [/^\/api\/admin\/[^/]+\/submissions\/[^/]+$/, 'PATCH', (body) => ({ status: body.status })],
  [/^\/api\/admin\/[^/]+\/submissions\/bulk$/, 'POST', (body) => ({ updated: body.ids })],
];

async function staticApi(path, method, json) {
  if (method === 'GET') {
    const res = await fetch(`${path.replace(/^\//, '')}.json`);
    if (!res.ok) throw Object.assign(new Error('This link is not part of the demo.'), { status: res.status });
    return res.json();
  }
  const hit = LOCAL_CHANGES.find(([re, m]) => m === method && re.test(path));
  if (!hit) throw new Error(VIEW_ONLY);
  return hit[2](json ?? {});
}

export async function api(path, { method = 'GET', json, form } = {}) {
  if (STATIC) return staticApi(path, method, json);
  const res = await fetch(path, {
    method,
    headers: json === undefined ? undefined : { 'content-type': 'application/json' },
    body: json === undefined ? form : JSON.stringify(json),
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

export async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

// el('button', { class: 'primary', text: 'Save', onclick: fn }, ...children)
// Always sets text via textContent, never innerHTML, so fan-written text can't inject markup.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && !k.includes('-')) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

let statusTimer;
export function toast(message, { error = false } = {}) {
  const box = document.getElementById('status');
  if (!box) return;
  box.textContent = message;
  box.classList.toggle('error', error);
  box.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => box.classList.remove('show'), error ? 6000 : 2500);
}

// The clipboard API needs HTTPS (or localhost); elsewhere fall back to a prompt the person can copy from.
export async function copyText(text, what = 'link') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what[0].toUpperCase()}${what.slice(1)} copied.`);
  } catch {
    window.prompt(`Copy this ${what}:`, text);
  }
}
