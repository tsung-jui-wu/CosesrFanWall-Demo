// Constellation planner. Pure and DOM-free, like mosaic.js: it places the photo stars, the lines between
// them, the faint background stars, and where notes drift; reveal.js and art.js draw them. Also runs
// under `node --test`.
//
// The sky always looks full. How many photo stars shine depends only on the screen, never on how many
// photos there are: with fewer photos than stars a photo shines more than once, kept apart from its
// copies; with more, the reveal cycles through them a star at a time. The background stars are the
// same however many photos arrived.
import { mulberry32, hashSeed } from './mosaic.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// aspect: width / height of the sky; stars: how many photo stars; radius: their size in width units;
// photos: how many photos (at least 1); dust: how many background stars; noteSpots: how many notes
// drift at once. Everything is in sky-width units: x runs 0..1 across and y 0..height down.
// Returns { height, stars: [{ x, y, r, photo, delay }], links: [[a, b]] (a tree joining every star),
// dust: [{ x, y, size, alpha, phase }], notes: [{ star, dx, dy }] }. A note drifts beside its star,
// away from the sky's middle along (dx, dy); delay (0..1) orders the intro.
export function planSky({ aspect, stars, radius, photos, seed = 1, dust = 140, noteSpots = 0 }) {
  if (!(aspect > 0) || !Number.isInteger(stars) || stars < 1 || !(radius > 0)) {
    throw new Error('planSky: needs aspect > 0, whole stars >= 1, and radius > 0');
  }
  if (!Number.isInteger(photos) || photos < 1) throw new Error('planSky: needs at least one photo');
  const rng = mulberry32(hashSeed(seed) ^ 0xc0ffee);
  const height = 1 / aspect;
  const mx = Math.min(radius * 2.2, 0.45), my = Math.min(radius * 2.2, height * 0.45);

  // Best-candidate sampling: each star takes the farthest of a dozen tries from the stars so far, which
  // spreads them out evenly without lining them up in a grid.
  const pts = [];
  for (let i = 0; i < stars; i++) {
    let best = null, bestD = -1;
    for (let k = 0; k < 14; k++) {
      const c = { x: mx + rng() * (1 - 2 * mx), y: my + rng() * (height - 2 * my) };
      const d = pts.reduce((m, p) => Math.min(m, dist(p, c)), Infinity);
      if (d > bestD) { best = c; bestD = d; }
    }
    pts.push({ ...best, r: radius * (0.82 + rng() * 0.36), photo: 0, delay: 0 });
  }

  // The constellation's lines: the shortest tree that joins every star (Prim's algorithm).
  const links = [];
  const joined = new Set([0]);
  while (joined.size < pts.length) {
    let best = null, bestD = Infinity;
    for (const a of joined) {
      for (let b = 0; b < pts.length; b++) {
        if (!joined.has(b) && dist(pts[a], pts[b]) < bestD) { bestD = dist(pts[a], pts[b]); best = [a, b]; }
      }
    }
    links.push(best);
    joined.add(best[1]);
  }
  const neighbors = pts.map(() => new Set());
  for (const [a, b] of links) { neighbors[a].add(b); neighbors[b].add(a); }

  // Photos: all different when there are enough; otherwise used about equally, never on two stars a
  // line joins when that can be avoided.
  if (photos >= pts.length) pts.forEach((p, i) => { p.photo = i; });
  else {
    const usage = new Uint32Array(photos);
    pts.forEach((p, i) => {
      const taken = new Set([...neighbors[i]].filter((j) => j < i).map((j) => pts[j].photo));
      let best = 0, bestKey = Infinity;
      for (let f = 0; f < photos; f++) {
        const key = (taken.has(f) ? 1000 : 0) + usage[f] + rng() * 0.5;
        if (key < bestKey) { best = f; bestKey = key; }
      }
      p.photo = best;
      usage[best]++;
    });
  }

  // The intro lights the stars along the lines, starting from the one nearest the middle.
  const middle = { x: 0.5, y: height / 2 };
  let root = 0;
  pts.forEach((p, i) => { if (dist(p, middle) < dist(pts[root], middle)) root = i; });
  const seen = [root], queue = [root];
  while (queue.length) {
    for (const j of neighbors[queue.shift()]) if (!seen.includes(j)) { seen.push(j); queue.push(j); }
  }
  seen.forEach((s, i) => { pts[s].delay = seen.length > 1 ? i / (seen.length - 1) : 0; });

  const sky = Array.from({ length: dust }, () => ({
    x: rng(), y: rng() * height, size: 0.0012 + rng() * 0.0024, alpha: 0.25 + rng() * 0.65, phase: rng() * Math.PI * 2,
  }));

  // Notes drift beside stars spread around the sky (evenly by angle from the middle).
  const byAngle = pts.map((p, i) => i).sort((a, b) =>
    Math.atan2(pts[a].y - middle.y, pts[a].x - middle.x) - Math.atan2(pts[b].y - middle.y, pts[b].x - middle.x));
  const notes = [];
  for (let k = 0; k < Math.min(noteSpots, pts.length); k++) {
    const s = byAngle[Math.floor((k * byAngle.length) / Math.min(noteSpots, pts.length))];
    // Outward from the middle, so notes by different stars spread apart instead of meeting there.
    const dx = pts[s].x - middle.x, dy = pts[s].y - middle.y, d = Math.hypot(dx, dy) || 1;
    notes.push({ star: s, dx: dx / d, dy: dy / d });
  }
  return { height, stars: pts, links, dust: sky, notes };
}
