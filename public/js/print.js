import { api, toast, url, segmentAfter } from './api.js';
import { t, setText, setTitle, onLangChange, useEventLang } from './i18n.js';

const cid = segmentAfter('print');
const base = `/api/admin/${encodeURIComponent(segmentAfter('admin'))}`;
const $ = (id) => document.getElementById(id);

$('print').addEventListener('click', () => window.print());

try {
  const { event, cosplayers } = await api(base);
  const c = cosplayers.find((x) => x.id === cid);
  if (!c) throw new Error(t('print.notFound'));
  await useEventLang(event.lang); // the sign starts in the event's language
  setTitle('print.docTitleFor', { name: c.name });
  $('event-name').textContent = event.name;
  $('cos-name').textContent = c.name;
  $('cos-character').textContent = c.character;
  $('cos-character').hidden = !c.character;
  setText($('cta'), 'print.cta', { name: c.name });
  const qrAlt = () => { $('qr').alt = t('print.qrAlt', { name: c.name }); };
  qrAlt();
  onLangChange(qrAlt);
  $('qr').src = url(`${base}/qr/${encodeURIComponent(c.id)}.svg`);
  $('sign').hidden = false;
} catch (err) {
  toast(err.message, { error: true });
}
