import { api, toast, url, segmentAfter } from './api.js';

const cid = segmentAfter('print');
const base = `/api/admin/${encodeURIComponent(segmentAfter('admin'))}`;
const $ = (id) => document.getElementById(id);

$('print').addEventListener('click', () => window.print());

try {
  const { event, cosplayers } = await api(base);
  const c = cosplayers.find((x) => x.id === cid);
  if (!c) throw new Error('That cosplayer is not in this event.');
  document.title = `Sign for ${c.name} · FanWall`;
  $('event-name').textContent = event.name;
  $('cos-name').textContent = c.name;
  $('cos-character').textContent = c.character;
  $('cos-character').hidden = !c.character;
  $('cta').textContent = `Scan to send ${c.name} a photo or a thank-you note`;
  $('qr').alt = `QR code linking to the page for sending ${c.name} photos and notes`;
  $('qr').src = url(`${base}/qr/${encodeURIComponent(c.id)}.svg`);
  $('sign').hidden = false;
} catch (err) {
  toast(err.message, { error: true });
}
