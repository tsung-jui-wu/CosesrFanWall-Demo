// Calendar reminders (.ics), made on the device: nothing is sent anywhere and no email is asked for.
// Pure and DOM-free (tested under node --test).

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const day = (iso) => iso.replace(/-/g, '');
const nextDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// Lines over 75 bytes are folded (RFC 5545): split on whole characters, the rest indented by a space.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '', size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// events: [{ uid, date: 'YYYY-MM-DD', summary, description?, url? }], each an all-day reminder with
// an alert at 9:00 that day. uid keeps a re-imported reminder from being added twice; it must not
// carry anything secret (no tokens: a calendar may sync to someone's cloud).
export function makeIcs(events, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FanWall//Reminders//EN', 'CALSCALE:GREGORIAN'];
  for (const e of events) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error(`makeIcs: bad date ${e.date}`);
    lines.push(
      'BEGIN:VEVENT', `UID:${esc(e.uid)}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(e.date)}`, `DTEND;VALUE=DATE:${day(nextDay(e.date))}`,
      `SUMMARY:${esc(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.summary)}`, 'TRIGGER:PT9H', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// The next 1 December on or after `today` (YYYY-MM-DD): when the year in review reminder goes.
export const nextDecember = (today) => (today.slice(5) <= '12-01' ? `${today.slice(0, 4)}-12-01` : `${Number(today.slice(0, 4)) + 1}-12-01`);
