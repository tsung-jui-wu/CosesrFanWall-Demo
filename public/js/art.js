// Canvas drawing for the polaroid wall and the constellation, shared by the stage (reveal.js) and
// Save image, so a saved picture matches what was on screen. Photos arrive as square canvases.
// Layouts come from the pure planners (polaroid.js, constellation.js), in width units.
import { PRINT_RATIO, PRINT_PHOTO } from './polaroid.js';

const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

// Draws a pre-rendered piece centered at (x, y), turned by rot and scaled.
export function drawPiece(g, piece, x, y, rot = 0, scale = 1, alpha = 1) {
  if (alpha <= 0) return;
  const c = Math.cos(rot) * scale, s = Math.sin(rot) * scale;
  g.globalAlpha = alpha;
  g.setTransform(c, s, -s, c, x, y);
  g.drawImage(piece, -piece.width / 2, -piece.height / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
}

// ---------- the wall ----------
export function paintWall(g, w, h) {
  g.fillStyle = '#17130f';
  g.fillRect(0, 0, w, h);
  const light = g.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.45, Math.hypot(w, h) * 0.62);
  light.addColorStop(0, 'rgba(255, 220, 180, 0.08)');
  light.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
  g.fillStyle = light;
  g.fillRect(0, 0, w, h);
}

// One print, upright, with room around it for its shadow and its tape: a cream card, the photo, and a
// strip of tape across the top. wPx is the card's width in pixels.
export function printPiece(photo, wPx) {
  const w = Math.max(8, Math.round(wPx)), h = Math.round(w * PRINT_RATIO);
  const pad = Math.ceil(w * 0.12);
  const c = makeCanvas(w + 2 * pad, h + 2 * pad);
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(0, 0, 0, 0.55)';
  g.shadowBlur = w * 0.07;
  g.shadowOffsetY = w * 0.03;
  g.fillStyle = '#f3efe6';
  g.fillRect(pad, pad, w, h);
  g.shadowColor = 'transparent';
  const side = w * PRINT_PHOTO, inset = (w - side) / 2;
  g.imageSmoothingQuality = 'high';
  g.drawImage(photo, pad + inset, pad + inset, side, side);
  g.translate(pad + w / 2, pad);
  g.rotate(-0.05);
  g.fillStyle = 'rgba(232, 222, 190, 0.75)';
  g.fillRect(-w * 0.17, -w * 0.05, w * 0.34, w * 0.1);
  return c;
}

// ---------- the sky ----------
export function paintSky(g, w, h) {
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#04050d');
  sky.addColorStop(0.6, '#0b1130');
  sky.addColorStop(1, '#1a1242');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
}

// The background stars, stretched over the whole w x h canvas. They twinkle unless `still`.
export function paintDust(g, dust, planHeight, w, h, t, still, fade = 1) {
  g.fillStyle = '#ffffff';
  for (const d of dust) {
    const twinkle = still ? 1 : 0.6 + 0.4 * Math.sin(t / 900 + d.phase);
    g.globalAlpha = d.alpha * twinkle * fade;
    g.beginPath();
    g.arc(d.x * w, (d.y / planHeight) * h, Math.max(0.6, d.size * w), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

// A constellation line between two points, drawn `p` (0..1) of the way.
export function paintLink(g, ax, ay, bx, by, p, width) {
  if (p <= 0) return;
  g.strokeStyle = 'rgba(190, 205, 255, 0.32)';
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(ax + (bx - ax) * p, ay + (by - ay) * p);
  g.stroke();
}

// One photo star: a soft glow, a thin bright ring, and the photo in a circle of radius rPx.
export function starPiece(photo, rPx) {
  const r = Math.max(4, Math.round(rPx)), glow = Math.round(r * 2.1);
  const c = makeCanvas(glow * 2, glow * 2);
  const g = c.getContext('2d');
  const halo = g.createRadialGradient(glow, glow, r * 0.8, glow, glow, glow);
  halo.addColorStop(0, 'rgba(190, 210, 255, 0.45)');
  halo.addColorStop(1, 'rgba(190, 210, 255, 0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, glow * 2, glow * 2);
  g.save();
  g.beginPath();
  g.arc(glow, glow, r, 0, Math.PI * 2);
  g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(photo, glow - r, glow - r, r * 2, r * 2);
  g.restore();
  g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  g.lineWidth = Math.max(1, r * 0.06);
  g.beginPath();
  g.arc(glow, glow, r, 0, Math.PI * 2);
  g.stroke();
  return c;
}
