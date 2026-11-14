// Stand-in for open-vocabulary features (e.g. SAM 2 masks + CLIP embeddings).
// Each category and colour gets a fixed random direction; a detection's
// embedding mixes its category and colour plus view noise. Text queries embed
// into the same space, so "red toolbox" matches objects by similarity.
import { rng } from './geom.js';
import { CATS } from './scenes.js';

export const DIM = 48;
export const CATEGORIES = Object.keys(CATS);
export const COLOR_WORDS = ['red', 'blue', 'green', 'gray', 'white', 'brown', 'black', 'yellow', 'orange'];
const SYNONYMS = {
  refrigerator: 'fridge', couch: 'sofa', television: 'tv', monitor: 'tv', screen: 'tv', extinguisher: 'fire extinguisher', extinguishers: 'fire extinguisher',
  'tool box': 'toolbox', toolboxes: 'toolbox', tools: 'toolbox', printer: '3d printer', shelf: 'bookshelf', bin: 'trash can', trash: 'trash can',
  doorway: 'door', entrance: 'door', grey: 'gray', seat: 'chair', coffee: 'coffee machine', vending: 'vending machine', bookcase: 'bookshelf',
  plants: 'plant', chairs: 'chair', doors: 'door', boxes: 'box', crate: 'box', crates: 'box', pallets: 'pallet', carts: 'cart', trolley: 'cart',
  cone: 'safety cone', cones: 'safety cone', charger: 'charging station', dock: 'charging station', aed: 'defibrillator', defib: 'defibrillator',
  defibrillators: 'defibrillator', beds: 'hospital bed', iv: 'iv stand', drip: 'iv stand', wheelchairs: 'wheelchair', cup: 'mug', notebook: 'laptop',
  computer: 'laptop', bag: 'backpack', closet: 'wardrobe', washer: 'washing machine', reception: 'reception desk', racks: 'rack', shelving: 'rack',
};

function unit(v) { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }
function dirFor(word, salt) {
  let h = salt; for (const c of word) h = (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0);
  const R = rng(h); return unit(Array.from({ length: DIM }, () => R.gauss()));
}
const catDir = (() => { const m = {}; return (c) => (m[c] ||= dirFor(c, 17)); })();
const colDir = (() => { const m = {}; return (c) => (m[c] ||= dirFor(c, 91)); })();
const mix = (cat, col, wc = 0.9, wl = 0.42) => Array.from({ length: DIM }, (_, i) => (cat ? wc * cat[i] : 0) + (col ? wl * col[i] : 0));

// view noise: smaller objects and far views produce noisier descriptors
export function embedObject(o, R, noise = 0.16) {
  return unit(mix(catDir(o.cat), colDir(o.color)).map((x) => x + noise * R.gauss()));
}
export const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

export function embedText(text) {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')} `;
  let cat = null, col = null;
  const phrases = [...Object.keys(SYNONYMS), ...CATEGORIES].sort((a, b) => b.length - a.length);
  for (const p of phrases) if (t.includes(` ${p} `)) { cat = SYNONYMS[p] || p; break; }
  for (const c of [...COLOR_WORDS, 'grey']) if (t.includes(` ${c} `)) { col = SYNONYMS[c] || c; break; }
  if (!cat && !col) return null;
  return { vec: unit(mix(cat && catDir(cat), col && colDir(col), cat ? 0.9 : 0, col ? 0.42 : 0)), cat, col };
}

export function labelFor(emb) {
  let best = null, bs = -2; for (const c of CATEGORIES) { const s = cosine(emb, catDir(c)); if (s > bs) { bs = s; best = c; } }
  let bc = null, bcs = -2; for (const c of COLOR_WORDS) { const s = cosine(emb, colDir(c)); if (s > bcs) { bcs = s; bc = c; } }
  return { cat: best, color: bc };
}
