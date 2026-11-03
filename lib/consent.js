import { HARD_CAP_DAYS } from './store.js';

export const CONSENT_VERSION = '2026-11-v1';

// Shown in full on the fan page, above the checkbox. Keep it short and plain.
export function consentCopy({ cosplayerName, retentionDays }) {
  const who = cosplayerName || 'the cosplayer';
  return {
    version: CONSENT_VERSION,
    title: 'Before you send',
    points: [
      { h: 'What you are sharing', t: `The photo and/or message you submit, plus a name only if you choose to type one. No account, email, or location is collected, and photos are re-saved without their hidden location data.` },
      { h: 'Who sees it', t: `The event organizer reviews everything first. Approved items go to ${who}, who keeps them as a thank-you gallery. Your photo may appear as one small tile inside a mosaic, and ${who} may post the finished mosaic image on their social accounts.` },
      { h: 'Control', t: `${who} can hide or remove anything at any time, and can ask for the whole page to be wiped. You can delete your own submission whenever you like with the delete code shown after you send.` },
      { h: 'How long it is kept', t: `Everything is deleted automatically ${retentionDays} days after the event closes, and never kept longer than ${HARD_CAP_DAYS} days.` },
      { h: 'Please', t: `Only upload photos you took or have permission to share, and avoid photos where bystanders are the main subject.` },
    ],
    checkbox: `I took this photo or have permission to share it, I am 13 or older (or have a parent's OK), and I agree to the above.`,
  };
}
