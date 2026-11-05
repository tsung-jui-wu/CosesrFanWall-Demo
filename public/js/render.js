// Still pictures, one renderer per reveal style: what the reveal's Save image saves (for the wall and
// the sky) and what the year in review shows for each event (every style). Adding a style:
//   1. its pure planner in its own module, registered in styles.js (STYLES);
//   2. its still renderer here (RENDERERS), which Save image and the year in review both use;
//   3. its stage animation in reveal.js (prepare, computeLayout, draw, itemAt);
//   4. style.<id>.name, style.<id>.about and reveal.stage.<id> in all three catalogs.
// A renderer takes photos (canvases or bitmaps, any shape) and returns a canvas. Whatever the style,
// photos are drawn small (styles.js EXPORT_MAX_PHOTO) and no notes or names are ever drawn: fans
// agreed to appear as small tiles in a picture the cosplayer may post, and to nothing more.
import { tileFeature, targetCells, chooseGrid, planMosaic } from './mosaic.js';
import { planWall } from './polaroid.js';
import { planSky } from './constellation.js';
import { isStyle, DEFAULT_STYLE, EXPORT } from './styles.js';
import { makeCanvas, shrinkInto, coverCrop, drawPiece, paintWall, printPiece, paintSky, paintDust, paintLink, starPiece, ARRIVE, easeOut } from './art.js';

const TILE_PX = 64; // mosaic tiles are cut at this height, as on the stage
const MOSAIC_PX = 2160; // a saved mosaic's long side; it keeps its picture's shape
const SQUARE_PX = 256; // the wall's and the sky's photos are cut square at this size
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A square, center-cropped copy, as prints and stars need.
export function squareCut(img, px = SQUARE_PX) {
  if (img.width === img.height && img.width <= px) return img;
  const c = makeCanvas(px, px);
  shrinkInto(c, img, ...coverCrop(img.width, img.height, 1), px, px);
  return c;
}

// The wall and the sky as they come together, on a w x h canvas: { end, draw(g, t) } draws the
// picture at t ms, with the stage's timing (art.js ARRIVE). From `end` on it is the still picture.
// Save GIF plays it; the still renderers draw its last moment. A piece only grows into its place, so
// none is ever drawn bigger than in the still.
function wallScene({ photos, seed }, w, h) {
  const plan = planWall({ aspect: w / h, photos: photos.length, seed, ...EXPORT.polaroid });
  const base = (w / EXPORT.polaroid.cols) * 0.94;
  const made = new Map(); // one piece per photo
  const { t0, wall: spread, piece } = ARRIVE;
  return {
    end: t0 + spread + piece,
    draw(g, t) {
      paintWall(g, w, h);
      for (const p of plan.prints) {
        const a = clamp((t - (t0 + p.delay * spread)) / piece, 0, 1);
        if (a === 0) continue;
        const e = easeOut(a); // each print drops onto the wall and settles
        if (!made.has(p.photo)) made.set(p.photo, printPiece(squareCut(photos[p.photo]), base));
        drawPiece(g, made.get(p.photo), p.x * w, p.y * w - (1 - e) * 0.015 * w, p.rot + (1 - e) * 0.25, ((p.w * w) / base) * (0.9 + 0.1 * e), a);
      }
    },
  };
}

function skyScene({ photos, seed }, w, h) {
  const plan = planSky({ aspect: w / h, photos: photos.length, seed, dust: 260, ...EXPORT.constellation });
  const base = EXPORT.constellation.radius * 1.18 * w;
  const made = new Map();
  const { t0, sky: spread, piece } = ARRIVE;
  const lit = (s, t) => clamp((t - (t0 + s.delay * spread)) / piece, 0, 1);
  return {
    end: t0 + spread + piece,
    draw(g, t) {
      paintSky(g, w, h);
      paintDust(g, plan.dust, plan.height, w, h, 0, true, clamp(t / 1200, 0, 1));
      for (const [a, b] of plan.links) {
        // Each line draws itself toward the later of its two stars as that star lights up.
        const [from, to] = plan.stars[a].delay <= plan.stars[b].delay ? [plan.stars[a], plan.stars[b]] : [plan.stars[b], plan.stars[a]];
        paintLink(g, from.x * w, from.y * w, to.x * w, to.y * w, lit(to, t), w / 600);
      }
      for (const st of plan.stars) {
        const a = lit(st, t);
        if (a === 0) continue;
        if (!made.has(st.photo)) made.set(st.photo, starPiece(squareCut(photos[st.photo]), base));
        drawPiece(g, made.get(st.photo), st.x * w, st.y * w, 0, ((st.r * w) / base) * (0.6 + 0.4 * easeOut(a)), a);
      }
    },
  };
}

const still = (makeScene) => (input) => {
  const { width: w, height: h } = EXPORT;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  makeScene(input, w, h).draw(g, Infinity);
  return c;
};
const wall = still(wallScene);
const sky = still(skyScene);

// The mosaic needs its picture to assemble into; without one it returns null (see renderPicture).
function mosaic({ photos, picture, seed }) {
  if (!picture) return null;
  const aspect = picture.width / picture.height;
  const { cols, rows } = chooseGrid(photos.length, aspect);
  const target = makeCanvas(cols * 2, rows * 2);
  shrinkInto(target, picture, 0, 0, picture.width, picture.height, cols * 2, rows * 2);
  const { features, meanRGB } = targetCells(target.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cols * 2, rows * 2).data, cols, rows);
  const cellAspect = (picture.width / cols) / (picture.height / rows);
  const th = TILE_PX, tw = clamp(Math.round(TILE_PX * cellAspect), 8, 256);
  const px2 = makeCanvas(2, 2);
  const px2g = px2.getContext('2d', { willReadFrequently: true });
  const tiles = photos.map((img, i) => {
    const tile = makeCanvas(tw, th);
    shrinkInto(tile, img, ...coverCrop(img.width, img.height, tw / th), tw, th);
    shrinkInto(px2, tile, 0, 0, tw, th, 2, 2);
    return { id: String(i), feature: tileFeature(px2g.getImageData(0, 0, 2, 2).data), img: tile };
  });
  const plan = planMosaic({ cols, rows, cellFeatures: features, meanRGB, tiles, seed });
  const imgs = new Map(tiles.map((t) => [t.id, t.img]));
  const w = aspect >= 1 ? MOSAIC_PX : Math.round(MOSAIC_PX * aspect);
  const h = aspect >= 1 ? Math.round(MOSAIC_PX / aspect) : MOSAIC_PX;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  for (const cell of plan.cells) {
    const x0 = Math.round((cell.col * w) / cols), x1 = Math.round(((cell.col + 1) * w) / cols);
    const y0 = Math.round((cell.row * h) / rows), y1 = Math.round(((cell.row + 1) * h) / rows);
    g.globalAlpha = 1;
    g.drawImage(imgs.get(cell.tileId), x0, y0, x1 - x0, y1 - y0);
    g.globalAlpha = cell.tint.alpha;
    g.fillStyle = `rgb(${cell.tint.rgb.join(',')})`;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  g.globalAlpha = 1;
  return c;
}

export const RENDERERS = { mosaic, polaroid: wall, constellation: sky };

// The still picture for `style`, from at least one photo. An unknown style (a bundle saved by a newer
// FanWall) is drawn as the default; a mosaic without its picture is drawn as a wall.
// input: { photos, picture (the mosaic's picture, or null), seed }.
export function renderPicture(style, input) {
  if (!input.photos?.length) throw new Error('renderPicture: needs at least one photo');
  const draw = RENDERERS[isStyle(style) && RENDERERS[style] ? style : DEFAULT_STYLE];
  return draw(input) ?? RENDERERS.polaroid(input);
}

// The wall or the sky coming together on a w x h canvas, for Save GIF: { end, draw(g, t) }, from the
// same plan as the still picture, so the GIF ends on the saved image. input: { photos, seed }.
export function animatePicture(style, input, w, h) {
  return (style === 'constellation' ? skyScene : wallScene)(input, w, h);
}
