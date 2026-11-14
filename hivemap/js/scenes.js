// Scene library. Each scene: size, walls (segments), rooms (rects), fixtures
// (racks, shelves), object templates placed per seed with simple layout rules
// (against a wall, in a corner, chairs at desks / around tables, nightstands
// beside beds, pallets in rack aisles ...) and spawn points for up to 10 robots.
import { rng } from './geom.js';

// Object categories: size class drives detection range and occlusion.
// r: radius used for detection / reach checks. w, l: footprint (local x, local z)
// for rectangular furniture; objects face local +z (back toward local -z).
// small: short detection range; big: long range and occludes; block: occludes like a wall.
export const CATS = {
  // furniture / fixtures
  workbench: { r: 0.8, big: true, w: 1.6, l: 0.8 }, toolbox: { r: 0.35, small: true }, '3d printer': { r: 0.4 }, 'fire extinguisher': { r: 0.2, small: true },
  desk: { r: 0.7, w: 1.4, l: 0.7 }, chair: { r: 0.3 }, bookshelf: { r: 0.6, big: true, w: 1.2, l: 0.35 }, plant: { r: 0.35 }, bench: { r: 0.8, w: 1.6, l: 0.42 }, 'trash can': { r: 0.25 },
  'vending machine': { r: 0.5, big: true, w: 0.9, l: 0.75 }, fridge: { r: 0.45, big: true, w: 0.8, l: 0.75 }, table: { r: 0.6, w: 1.2, l: 0.8 }, 'coffee machine': { r: 0.3, small: true, w: 0.6, l: 0.5 },
  sofa: { r: 1.0, big: true, w: 2.0, l: 0.9 }, tv: { r: 0.6, w: 1.3, l: 0.4 }, lamp: { r: 0.25 }, armchair: { r: 0.45 }, door: { r: 0.0, landmarkOnly: true },
  whiteboard: { r: 0.6, w: 1.6, l: 0.12 }, cabinet: { r: 0.45, big: true, w: 0.9, l: 0.5 }, nightstand: { r: 0.25, w: 0.45, l: 0.4 },
  // warehouse
  rack: { r: 1.6, big: true, block: true }, pallet: { r: 0.6, w: 1.2, l: 1.0 }, forklift: { r: 0.8, big: true, w: 1.0, l: 1.6 }, box: { r: 0.3 }, cart: { r: 0.4, w: 0.6, l: 0.9 },
  'safety cone': { r: 0.2, small: true }, 'charging station': { r: 0.4, w: 0.5, l: 0.25 },
  // home
  bed: { r: 1.0, big: true, w: 1.0, l: 2.0 }, sink: { r: 0.4, w: 0.8, l: 0.55 }, wardrobe: { r: 0.6, big: true, w: 1.2, l: 0.6 }, 'dining table': { r: 0.8, w: 1.6, l: 0.9 }, backpack: { r: 0.2, small: true },
  laptop: { r: 0.2, small: true }, mug: { r: 0.08, small: true }, 'washing machine': { r: 0.35, w: 0.6, l: 0.6 },
  // hospital
  'hospital bed': { r: 1.0, big: true, w: 0.95, l: 2.0 }, wheelchair: { r: 0.4 }, 'iv stand': { r: 0.2 }, 'medical cart': { r: 0.4, w: 0.6, l: 0.45 }, defibrillator: { r: 0.15, small: true },
  'reception desk': { r: 1.2, big: true, w: 2.4, l: 0.8 },
  // retail
  'display shelf': { r: 1.2, big: true, block: true }, 'checkout counter': { r: 0.9, big: true, w: 0.8, l: 1.8 }, 'shopping cart': { r: 0.4, w: 0.55, l: 0.9 },
  freezer: { r: 0.9, big: true, w: 1.8, l: 0.8 },
  // lab
  'fume hood': { r: 0.8, big: true, w: 1.5, l: 0.8 }, centrifuge: { r: 0.3, w: 0.5, l: 0.5 }, 'gas cylinder': { r: 0.15, small: true }, 'eyewash station': { r: 0.2, small: true },
};

// Footprint of an object: { hw, hl } (oriented rectangle) or { r } (circle).
export function footprint(o) {
  if (o.w && o.l) return { hw: o.w / 2, hl: o.l / 2 };
  const c = CATS[o.cat] || {};
  if (c.w) return { hw: c.w / 2, hl: c.l / 2 };
  return { r: c.r ?? 0.4 };
}
// Distance from a point to an object's footprint (0 inside).
export function objDist(o, x, y) {
  const f = footprint(o), dx = x - o.x, dy = y - o.y;
  if (f.r != null) return Math.max(0, Math.hypot(dx, dy) - f.r);
  const c = Math.cos(o.th), s = Math.sin(o.th), u = dx * c + dy * s, v = -dx * s + dy * c;
  return Math.hypot(Math.max(0, Math.abs(u) - f.hw), Math.max(0, Math.abs(v) - f.hl));
}
// Clearance used for navigation: robot centre must stay this far from walls / furniture.
export const CLEAR = { wall: 0.35, obj: 0.3, res: 0.2 };
// Objects robots can drive around but never through (doors are landmarks only).
export const isObstacle = (o) => o.cat !== 'door' && !o.hidden;

const seg = (x1, y1, x2, y2) => [x1, y1, x2, y2];
// horizontal/vertical wall with door gaps: gaps = [[from, to], ...] along the wall
function wallH(y, x1, x2, gaps = []) { const out = []; let x = x1; for (const [a, b] of gaps.sort((p, q) => p[0] - q[0])) { if (a > x) out.push(seg(x, y, a, y)); x = b; } if (x < x2) out.push(seg(x, y, x2, y)); return out; }
function wallV(x, y1, y2, gaps = []) { const out = []; let y = y1; for (const [a, b] of gaps.sort((p, q) => p[0] - q[0])) { if (a > y) out.push(seg(x, y, x, a)); y = b; } if (y < y2) out.push(seg(x, y, x, y2)); return out; }
const box = (w, h) => [seg(0, 0, w, 0), seg(w, 0, w, h), seg(w, h, 0, h), seg(0, h, 0, 0)];

// ---- authoring helpers. `objects` entries: [cat, color, room, place?]
// place: undefined (free; big objects go against a wall) | 'wall' | 'corner' | 'center' | 'aisle' |
//        { at: [x, y], th } | { rel, k } (relative to the entry k positions back; children of a
//        group). rel: front (chair at a desk) | around (chairs at a table) | head (nightstand at a
//        bed head) | side (visitor chair beside a bed) | next (same wall, side by side) |
//        facing (tv facing a sofa) | near (small item next to the anchor)
const wl = (cat, color, room) => [cat, color, room, 'wall'];
const cn = (cat, color, room) => [cat, color, room, 'corner'];
function grp(anchor, ...kids) { return [anchor, ...kids.map(([cat, color, rel], j) => [cat, color, anchor[2], { rel, k: -(j + 1) }])]; }

// --- scene definitions
const OFFICE = {
  id: 'office', name: 'Office floor', note: 'Lab, offices, hall, kitchen and lounge.', w: 24, h: 16,
  walls: [...box(24, 16), ...wallV(8, 0, 16, [[6, 9]]), ...wallV(16, 0, 16, [[5, 8]]), ...wallH(8, 0, 8, [[3, 5]]), ...wallH(8, 16, 24, [[19, 21]])],
  rooms: [{ name: 'Lab', x0: 0, y0: 0, x1: 8, y1: 8 }, { name: 'Office', x0: 0, y0: 8, x1: 8, y1: 16 }, { name: 'Hall', x0: 8, y0: 0, x1: 16, y1: 16 },
    { name: 'Kitchen', x0: 16, y0: 0, x1: 24, y1: 8 }, { name: 'Lounge', x0: 16, y0: 8, x1: 24, y1: 16 }],
  doors: [[8, 7.5], [4, 8], [16, 6.5], [20, 8]],
  objects: [
    ...grp(wl('workbench', 'gray', 'Lab'), ['chair', 'black', 'front'], ['toolbox', 'red', 'next']), wl('3d printer', 'white', 'Lab'), wl('cabinet', 'gray', 'Lab'),
    wl('fire extinguisher', 'red', 'Lab'), wl('whiteboard', 'white', 'Lab'),
    ...grp(wl('desk', 'brown', 'Office'), ['chair', 'blue', 'front'], ['laptop', 'black', 'near']), ...grp(wl('desk', 'white', 'Office'), ['chair', 'blue', 'front']),
    wl('bookshelf', 'brown', 'Office'), cn('plant', 'green', 'Office'), wl('cabinet', 'gray', 'Office'),
    cn('plant', 'green', 'Hall'), ...grp(wl('bench', 'gray', 'Hall'), ['chair', 'blue', 'next'], ['chair', 'blue', 'next']), wl('trash can', 'gray', 'Hall'), wl('fire extinguisher', 'red', 'Hall'),
    wl('vending machine', 'black', 'Hall'), cn('plant', 'green', 'Hall'),
    ...grp(wl('fridge', 'white', 'Kitchen'), ['sink', 'white', 'next'], ['coffee machine', 'black', 'next']), ...grp(['table', 'brown', 'Kitchen', 'center'], ['chair', 'blue', 'around'], ['chair', 'blue', 'around'], ['chair', 'blue', 'around'], ['mug', 'yellow', 'near']),
    wl('trash can', 'gray', 'Kitchen'), wl('toolbox', 'red', 'Kitchen'),
    ...grp(wl('sofa', 'green', 'Lounge'), ['tv', 'black', 'facing'], ['armchair', 'orange', 'next'], ['lamp', 'yellow', 'next']), cn('plant', 'green', 'Lounge'), wl('fire extinguisher', 'red', 'Lounge'), wl('bookshelf', 'white', 'Lounge')],
  spawns: [[1.5, 1.2], [22.5, 4.2], [2.0, 14.5], [22.0, 14.5], [12.0, 1.5], [12.0, 14.5], [10, 8], [14, 8], [6.5, 2.5], [18, 2.5]],
};

const WAREHOUSE = {
  id: 'warehouse', name: 'Warehouse', note: 'Racks block the view; many identical pallets.', w: 36, h: 22,
  walls: [...box(36, 22), ...wallV(26, 0, 22, [[3, 6], [15, 18]]), ...wallH(11, 26, 36, [[30, 32]])],
  rooms: [{ name: 'Storage', x0: 0, y0: 0, x1: 26, y1: 22 }, { name: 'Loading dock', x0: 26, y0: 0, x1: 36, y1: 11 }, { name: 'Control room', x0: 26, y0: 11, x1: 36, y1: 22 }],
  doors: [[26, 4.5], [26, 16.5], [31, 11]],
  // 1 x 4.4 m rack rows (aisles between)
  fixtures: [[5, 5], [5, 11], [5, 17], [11, 5], [11, 11], [11, 17], [17, 5], [17, 11], [17, 17]].map(([x, y]) => ({ cat: 'rack', color: 'gray', x, y, th: 0, w: 1.0, l: 4.4 })),
  objects: [
    ...grp(['pallet', 'brown', 'Storage', 'aisle'], ['box', 'orange', 'near']), ...grp(['pallet', 'brown', 'Storage', 'aisle'], ['box', 'blue', 'near']), ['pallet', 'brown', 'Storage', 'aisle'],
    ['pallet', 'brown', 'Storage', 'aisle'], ...grp(['pallet', 'brown', 'Storage', 'aisle'], ['box', 'green', 'near']), ['box', 'orange', 'Storage', 'aisle'],
    ['cart', 'blue', 'Storage', 'aisle'], ['cart', 'blue', 'Storage'], ...grp(['forklift', 'yellow', 'Storage', 'aisle'], ['safety cone', 'orange', 'near'], ['safety cone', 'orange', 'near']),
    wl('fire extinguisher', 'red', 'Storage'), wl('fire extinguisher', 'red', 'Storage'), wl('toolbox', 'red', 'Storage'), wl('charging station', 'green', 'Storage'), wl('trash can', 'gray', 'Storage'),
    ...grp(wl('forklift', 'yellow', 'Loading dock'), ['safety cone', 'orange', 'near']), ...grp(wl('pallet', 'brown', 'Loading dock'), ['pallet', 'brown', 'next'], ['box', 'orange', 'near']),
    wl('charging station', 'green', 'Loading dock'), ['cart', 'blue', 'Loading dock'], wl('fire extinguisher', 'red', 'Loading dock'),
    ...grp(wl('desk', 'gray', 'Control room'), ['chair', 'black', 'front'], ['laptop', 'black', 'near']), wl('tv', 'black', 'Control room'), wl('fire extinguisher', 'red', 'Control room'),
    wl('coffee machine', 'black', 'Control room'), wl('defibrillator', 'green', 'Control room'), wl('cabinet', 'gray', 'Control room'), cn('plant', 'green', 'Control room')],
  spawns: [[2, 2], [34, 2], [2, 20], [34, 20], [14, 2], [14, 20], [24, 11], [30, 6], [8, 11], [20, 8]],
};

const HOME = {
  id: 'home', name: 'Apartment', note: 'Five rooms full of small objects.', w: 20, h: 14,
  walls: [...box(20, 14), ...wallV(8, 0, 14, [[3, 5], [9, 11]]), ...wallH(7, 0, 8, [[6, 7.6]]), ...wallV(14, 0, 14, [[2, 4], [10, 12]]), ...wallH(7, 14, 20, [[16, 17.6]])],
  rooms: [{ name: 'Living room', x0: 0, y0: 0, x1: 8, y1: 7 }, { name: 'Kitchen', x0: 0, y0: 7, x1: 8, y1: 14 }, { name: 'Hallway', x0: 8, y0: 0, x1: 14, y1: 14 },
    { name: 'Bedroom', x0: 14, y0: 0, x1: 20, y1: 7 }, { name: 'Kids room', x0: 14, y0: 7, x1: 20, y1: 14 }],
  doors: [[8, 4], [8, 10], [6.8, 7], [14, 3], [14, 11], [16.8, 7]],
  objects: [
    ...grp(wl('sofa', 'gray', 'Living room'), ['tv', 'black', 'facing'], ['armchair', 'blue', 'next'], ['lamp', 'yellow', 'next']), cn('plant', 'green', 'Living room'), ['laptop', 'gray', 'Living room'], wl('bookshelf', 'brown', 'Living room'),
    ...grp(wl('fridge', 'white', 'Kitchen'), ['sink', 'white', 'next'], ['washing machine', 'white', 'next']),
    ...grp(['dining table', 'brown', 'Kitchen', 'center'], ['chair', 'brown', 'around'], ['chair', 'brown', 'around'], ['chair', 'brown', 'around'], ['mug', 'red', 'near']), wl('trash can', 'gray', 'Kitchen'),
    cn('plant', 'green', 'Hallway'), ...grp(wl('bench', 'brown', 'Hallway'), ['backpack', 'blue', 'near']), wl('lamp', 'white', 'Hallway'),
    ...grp(wl('bed', 'white', 'Bedroom'), ['nightstand', 'brown', 'head'], ['nightstand', 'brown', 'head'], ['lamp', 'yellow', 'near']), wl('wardrobe', 'brown', 'Bedroom'), ['laptop', 'black', 'Bedroom'], cn('plant', 'green', 'Bedroom'),
    ...grp(wl('bed', 'blue', 'Kids room'), ['nightstand', 'white', 'head']), ...grp(wl('desk', 'white', 'Kids room'), ['chair', 'blue', 'front'], ['backpack', 'red', 'near']), wl('bookshelf', 'brown', 'Kids room')],
  spawns: [[1.5, 1.5], [18.5, 1.5], [1.5, 12.5], [18.5, 12.5], [11, 1.5], [11, 12.5], [11, 7], [4, 4], [16, 4], [16, 10]],
};

const PATIENT_ROOMS = ['Room 101', 'Room 102', 'Room 103', 'Room 104', 'Room 105', 'Room 201', 'Room 202', 'Room 204', 'Room 205'];
const HOSPITAL = {
  id: 'hospital', name: 'Hospital wing', note: 'Ten look-alike patient rooms.', w: 36, h: 18,
  walls: [...box(36, 18),
    ...wallH(6.5, 0, 36, [[3, 5], [10, 12], [17, 19], [24, 26], [31, 33]]), ...wallH(11.5, 0, 36, [[3, 5], [10, 12], [17, 19], [24, 26], [31, 33]]),
    ...wallV(7, 0, 6.5), ...wallV(14, 0, 6.5), ...wallV(21, 0, 6.5), ...wallV(28, 0, 6.5), ...wallV(7, 11.5, 18), ...wallV(14, 11.5, 18), ...wallV(21, 11.5, 18), ...wallV(28, 11.5, 18)],
  rooms: [
    ...[0, 7, 14, 21, 28].map((x, i) => ({ name: `Room ${101 + i}`, x0: x, y0: 0, x1: x + (i === 4 ? 8 : 7), y1: 6.5 })),
    { name: 'Corridor', x0: 0, y0: 6.5, x1: 36, y1: 11.5 },
    ...[0, 7, 14, 21, 28].map((x, i) => ({ name: i === 2 ? 'Nurse station' : `Room ${201 + i}`, x0: x, y0: 11.5, x1: x + (i === 4 ? 8 : 7), y1: 18 })),
  ],
  doors: [[4, 6.5], [11, 6.5], [18, 6.5], [25, 6.5], [32, 6.5], [4, 11.5], [11, 11.5], [18, 11.5], [25, 11.5], [32, 11.5]],
  objects: [
    // every patient room: bed against a wall, IV stand at the head, visitor chair beside; some extras
    ...PATIENT_ROOMS.flatMap((r, i) => [...grp(wl('hospital bed', 'white', r), ['iv stand', 'gray', 'head'], ['chair', 'blue', 'side'], ...(i % 2 ? [['nightstand', 'white', 'head']] : [])),
      ...(i % 3 === 0 ? [['wheelchair', 'black', r]] : []), ...(i % 3 === 1 ? [wl('medical cart', 'blue', r)] : []), ...(i % 4 === 2 ? [wl('sink', 'white', r)] : [])]),
    ...grp(wl('reception desk', 'white', 'Nurse station'), ['chair', 'blue', 'front'], ['chair', 'blue', 'front']), wl('medical cart', 'blue', 'Nurse station'), wl('defibrillator', 'green', 'Nurse station'),
    wl('cabinet', 'white', 'Nurse station'), wl('fridge', 'white', 'Nurse station'),
    wl('medical cart', 'blue', 'Corridor'), ['wheelchair', 'black', 'Corridor', 'wall'], wl('fire extinguisher', 'red', 'Corridor'), wl('fire extinguisher', 'red', 'Corridor'), cn('plant', 'green', 'Corridor'),
    wl('defibrillator', 'green', 'Corridor'), wl('trash can', 'gray', 'Corridor'), wl('vending machine', 'black', 'Corridor'), wl('bench', 'gray', 'Corridor'), cn('plant', 'green', 'Corridor')],
  spawns: [[1.5, 9], [34.5, 9], [10, 9], [26, 9], [18, 9], [3, 3], [33, 3], [3, 15], [33, 15], [18, 3]],
};

// Retail store: shelf aisles, freezers along the back wall, checkout lanes, stockroom and office.
const RETAIL = {
  id: 'retail', name: 'Retail store', note: 'Shelf aisles block the view; checkout lanes.', w: 30, h: 20,
  walls: [...box(30, 20), ...wallV(22, 0, 20, [[4, 6], [14.5, 16.5]]), ...wallH(12, 22, 30, [[25, 27]])],
  rooms: [{ name: 'Sales floor', x0: 0, y0: 0, x1: 22, y1: 13 }, { name: 'Checkout', x0: 0, y0: 13, x1: 22, y1: 20 },
    { name: 'Stockroom', x0: 22, y0: 0, x1: 30, y1: 12 }, { name: 'Office', x0: 22, y0: 12, x1: 30, y1: 20 }],
  doors: [[22, 5], [22, 15.5], [26, 12]],
  fixtures: [
    ...[4, 8, 12, 16].map((x) => ({ cat: 'display shelf', color: 'white', x, y: 6.8, th: 0, w: 0.9, l: 6.4 })),
    { cat: 'rack', color: 'gray', x: 25.0, y: 6.5, th: 0, w: 1.0, l: 4.4 }, { cat: 'rack', color: 'gray', x: 29.0, y: 3.0, th: 0, w: 1.0, l: 4.4 },
  ],
  objects: [
    wl('freezer', 'white', 'Sales floor'), wl('freezer', 'white', 'Sales floor'), wl('freezer', 'blue', 'Sales floor'),
    ['shopping cart', 'gray', 'Sales floor', 'aisle'], ['shopping cart', 'gray', 'Sales floor', 'aisle'], ['box', 'orange', 'Sales floor', 'aisle'], ['box', 'brown', 'Sales floor', 'aisle'],
    ['safety cone', 'yellow', 'Sales floor', 'aisle'], wl('fire extinguisher', 'red', 'Sales floor'), cn('plant', 'green', 'Sales floor'),
    ...grp(['checkout counter', 'gray', 'Checkout', { at: [5, 16.5], th: 0 }], ['chair', 'black', 'side']), ...grp(['checkout counter', 'gray', 'Checkout', { at: [9.5, 16.5], th: 0 }], ['chair', 'black', 'side']),
    ...grp(['checkout counter', 'gray', 'Checkout', { at: [14, 16.5], th: 0 }], ['trash can', 'gray', 'near']),
    ...grp(['shopping cart', 'gray', 'Checkout', { at: [19.2, 18.8], th: Math.PI / 2 }], ['shopping cart', 'gray', 'next'], ['shopping cart', 'gray', 'next']),
    cn('plant', 'green', 'Checkout'), wl('vending machine', 'red', 'Checkout'), wl('fire extinguisher', 'red', 'Checkout'), wl('defibrillator', 'green', 'Checkout'),
    ...grp(['pallet', 'brown', 'Stockroom', 'aisle'], ['box', 'orange', 'near'], ['box', 'orange', 'near']), ['pallet', 'brown', 'Stockroom', 'aisle'], ['cart', 'blue', 'Stockroom'],
    wl('charging station', 'green', 'Stockroom'), wl('toolbox', 'red', 'Stockroom'), wl('fire extinguisher', 'red', 'Stockroom'),
    ...grp(wl('desk', 'brown', 'Office'), ['chair', 'black', 'front'], ['laptop', 'gray', 'near']), wl('cabinet', 'gray', 'Office'), wl('coffee machine', 'black', 'Office'), wl('fridge', 'white', 'Office'),
    cn('plant', 'green', 'Office'), wl('whiteboard', 'white', 'Office')],
  spawns: [[2, 1.5], [20.5, 1.5], [2, 11.5], [20.5, 11.5], [2, 18.5], [12, 14], [6, 11.5], [14, 11.5], [24, 2], [26, 18]],
};

// Research lab building: central corridor with labs, storage, seminar room, offices and a break room.
const LABS = {
  id: 'labs', name: 'Lab building', note: 'Wet lab, robotics lab, seminar room and offices off one corridor.', w: 32, h: 18,
  walls: [...box(32, 18),
    ...wallH(7.5, 0, 32, [[4, 6], [15.5, 17.5], [26, 28]]), ...wallH(10.5, 0, 32, [[5, 7], [16, 18], [26, 28]]),
    ...wallV(11, 0, 7.5), ...wallV(22, 0, 7.5, [[3, 4.6]]), ...wallV(12, 10.5, 18), ...wallV(22, 10.5, 18)],
  rooms: [{ name: 'Wet lab', x0: 0, y0: 0, x1: 11, y1: 7.5 }, { name: 'Robotics lab', x0: 11, y0: 0, x1: 22, y1: 7.5 }, { name: 'Storage', x0: 22, y0: 0, x1: 32, y1: 7.5 },
    { name: 'Corridor', x0: 0, y0: 7.5, x1: 32, y1: 10.5 },
    { name: 'Seminar room', x0: 0, y0: 10.5, x1: 12, y1: 18 }, { name: 'Offices', x0: 12, y0: 10.5, x1: 22, y1: 18 }, { name: 'Break room', x0: 22, y0: 10.5, x1: 32, y1: 18 }],
  doors: [[5, 7.5], [16.5, 7.5], [27, 7.5], [22, 3.8], [6, 10.5], [17, 10.5], [27, 10.5]],
  objects: [
    ...grp(['workbench', 'white', 'Wet lab', 'center'], ['chair', 'gray', 'front'], ['centrifuge', 'white', 'next']), wl('fume hood', 'gray', 'Wet lab'), wl('fume hood', 'gray', 'Wet lab'),
    ...grp(wl('sink', 'white', 'Wet lab'), ['eyewash station', 'green', 'next']), wl('fridge', 'white', 'Wet lab'), cn('gas cylinder', 'blue', 'Wet lab'), wl('fire extinguisher', 'red', 'Wet lab'),
    ...grp(wl('workbench', 'gray', 'Robotics lab'), ['chair', 'black', 'front'], ['toolbox', 'red', 'next']), wl('3d printer', 'white', 'Robotics lab'), wl('3d printer', 'black', 'Robotics lab'),
    wl('charging station', 'green', 'Robotics lab'), ['cart', 'blue', 'Robotics lab'], ...grp(wl('desk', 'gray', 'Robotics lab'), ['chair', 'black', 'front'], ['laptop', 'black', 'near']), wl('whiteboard', 'white', 'Robotics lab'),
    wl('cabinet', 'gray', 'Storage'), wl('cabinet', 'gray', 'Storage'), wl('bookshelf', 'gray', 'Storage'), ['box', 'brown', 'Storage'], ['box', 'orange', 'Storage'], cn('gas cylinder', 'green', 'Storage'),
    ...grp(['pallet', 'brown', 'Storage'], ['box', 'brown', 'near']), wl('fire extinguisher', 'red', 'Storage'),
    ...grp(['table', 'white', 'Seminar room', 'center'], ['chair', 'black', 'around'], ['chair', 'black', 'around'], ['chair', 'black', 'around'], ['chair', 'black', 'around'], ['chair', 'black', 'around']),
    wl('whiteboard', 'white', 'Seminar room'), wl('tv', 'black', 'Seminar room'), cn('plant', 'green', 'Seminar room'),
    ...grp(wl('desk', 'brown', 'Offices'), ['chair', 'blue', 'front'], ['laptop', 'gray', 'near']), ...grp(wl('desk', 'brown', 'Offices'), ['chair', 'blue', 'front']), ...grp(wl('desk', 'white', 'Offices'), ['chair', 'red', 'front']),
    wl('bookshelf', 'brown', 'Offices'), cn('plant', 'green', 'Offices'), wl('cabinet', 'gray', 'Offices'),
    ...grp(wl('fridge', 'white', 'Break room'), ['sink', 'white', 'next'], ['coffee machine', 'black', 'next']), ...grp(['table', 'brown', 'Break room', 'center'], ['chair', 'orange', 'around'], ['chair', 'orange', 'around'], ['mug', 'blue', 'near']),
    ...grp(wl('sofa', 'blue', 'Break room'), ['plant', 'green', 'next']), wl('vending machine', 'black', 'Break room'),
    cn('plant', 'green', 'Corridor'), wl('fire extinguisher', 'red', 'Corridor'), wl('defibrillator', 'green', 'Corridor'), wl('trash can', 'gray', 'Corridor'), wl('bench', 'gray', 'Corridor'), wl('fire extinguisher', 'red', 'Corridor')],
  spawns: [[1.5, 9], [30.5, 9], [10, 9], [22, 9], [16, 9], [2, 1.5], [20, 1.5], [2, 16.5], [20, 16.5], [30, 16.5]],
};

export const SCENES = [OFFICE, WAREHOUSE, HOME, HOSPITAL, RETAIL, LABS];

// ---- build a concrete scene instance for a seed: place objects with layout rules.
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
const half = (f) => (f.r != null ? { hw: f.r, hl: f.r } : f);
// half-extent of a footprint along world direction a for an object with heading th
function extent(f, th, a) { const h = half(f), d = a - th; return Math.abs(Math.cos(d)) * h.hw + Math.abs(Math.sin(d)) * h.hl; }

// Occupancy grid shared by placement and navigation: 1 = robot centre may not be here.
export function occupancyGrid(scene, objects = scene.objects) {
  const RES = CLEAR.res, W = Math.round(scene.w / RES), H = Math.round(scene.h / RES), occ = new Uint8Array(W * H);
  for (const w of scene.walls) stampWall(occ, W, H, RES, w, CLEAR.wall);
  for (const o of objects) if (isObstacle(o)) stampObj(occ, W, H, RES, o, CLEAR.obj, 1);
  return { W, H, RES, occ };
}
function stampWall(g, W, H, RES, w, pad) {
  const [x1, y1, x2, y2] = w;
  const i0 = Math.max(0, Math.floor((Math.min(x1, x2) - pad) / RES)), i1 = Math.min(W - 1, Math.floor((Math.max(x1, x2) + pad) / RES));
  const j0 = Math.max(0, Math.floor((Math.min(y1, y2) - pad) / RES)), j1 = Math.min(H - 1, Math.floor((Math.max(y1, y2) + pad) / RES));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (segDist((i + 0.5) * RES, (j + 0.5) * RES, x1, y1, x2, y2) < pad) g[j * W + i] = 1;
}
function cellsOf(W, H, RES, o, pad) {   // cell indices whose centre is within pad of o's footprint
  const f = half(footprint(o)), R = Math.hypot(f.hw, f.hl) + pad, out = [];
  const i0 = Math.max(0, Math.floor((o.x - R) / RES)), i1 = Math.min(W - 1, Math.floor((o.x + R) / RES));
  const j0 = Math.max(0, Math.floor((o.y - R) / RES)), j1 = Math.min(H - 1, Math.floor((o.y + R) / RES));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (objDist(o, (i + 0.5) * RES, (j + 0.5) * RES) <= pad) out.push(j * W + i);
  return out;
}
function stampObj(g, W, H, RES, o, pad, v) { for (const c of cellsOf(W, H, RES, o, pad)) g[c] = v; }

export function buildScene(def, seed) {
  const R = rng(seed * 7919 + def.id.length);
  const walls = def.walls.slice();
  const objects = []; let id = 0;
  const spawnPts = def.spawns.map(([x, y]) => ({ x, y }));
  const doorPts = def.doors.map(([x, y]) => ({ x, y }));
  // fine grid (0.1 m) for overlap tests, coarse grid (nav resolution) for reachability
  const FR = 0.1, FW = Math.round(def.w / FR), FH = Math.round(def.h / FR);
  const wallG = new Uint8Array(FW * FH), objG = new Uint8Array(FW * FH);
  for (const w of walls) stampWall(wallG, FW, FH, FR, w, 0.08);
  const cfg = occupancyGrid({ ...def, walls }, []);
  const { W, H, RES } = cfg, occ = cfg.occ;
  const cellOf = (p) => Math.min(H - 1, Math.max(0, Math.floor(p.y / RES))) * W + Math.min(W - 1, Math.max(0, Math.floor(p.x / RES)));
  const startCell = cellOf(spawnPts[0]);
  const mustReach = [...spawnPts, ...doorPts].map(cellOf);
  const stack = new Int32Array(W * H), seen = new Uint8Array(W * H);
  const flood = () => {
    seen.fill(0); let n = 0, sp = 0; if (occ[startCell]) return { n: 0, seen };
    stack[sp++] = startCell; seen[startCell] = 1;
    while (sp) {
      const c = stack[--sp]; n++; const i = c % W, j = (c / W) | 0;
      if (i > 0 && !occ[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
      if (i < W - 1 && !occ[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
      if (j > 0 && !occ[c - W] && !seen[c - W]) { seen[c - W] = 1; stack[sp++] = c - W; }
      if (j < H - 1 && !occ[c + W] && !seen[c + W]) { seen[c + W] = 1; stack[sp++] = c + W; }
    }
    return { n, seen };
  };
  let reach = flood().n;
  const addObject = (o) => { objects.push(o); if (isObstacle(o)) { stampObj(objG, FW, FH, FR, o, 0, 1); stampObj(occ, W, H, RES, o, CLEAR.obj, 1); } return o; };
  for (const f of def.fixtures || []) { addObject({ id: `o${id++}`, ...f }); }
  reach = flood().n;
  const roomOf = (n) => def.rooms.find((r) => r.name === n);
  const hasWall = (x, y) => walls.some((w) => segDist(x, y, ...w) < 0.12);
  // can o be placed? pad = free space kept to other furniture
  const fits = (o, room, pad) => {
    const f = half(footprint(o));
    for (const a of [0, Math.PI / 2]) {   // stay inside the room
      const ex = extent(footprint(o), o.th, a);
      if (a === 0 && (o.x - ex < room.x0 + 0.1 || o.x + ex > room.x1 - 0.1)) return false;
      if (a !== 0 && (o.y - ex < room.y0 + 0.1 || o.y + ex > room.y1 - 0.1)) return false;
    }
    for (const d of doorPts) if (objDist(o, d.x, d.y) < 0.9) return false;
    for (const s of spawnPts) if (objDist(o, s.x, s.y) < 0.6) return false;
    for (const c of cellsOf(FW, FH, FR, o, 0.02)) if (wallG[c]) return false;
    for (const c of cellsOf(FW, FH, FR, o, pad)) if (objG[c]) return false;
    // keep the building connected: no robot-reachable area may be cut off
    const newly = cellsOf(W, H, RES, o, CLEAR.obj).filter((c) => !occ[c]);
    for (const c of newly) occ[c] = 1;
    const fl = flood(), ok = mustReach.every((c) => fl.seen[c] || occ[c] && !newly.includes(c)) && reach - fl.n <= newly.length + 10;
    for (const c of newly) occ[c] = 0;
    if (ok) reach = fl.n;
    return ok;
  };
  const placedAt = [];   // per template entry: placed object or null
  const facingTh = (fx, fy, x, y) => Math.atan2(fy - y, fx - x) - Math.PI / 2;   // object front (+z) points at (fx, fy)
  def.objects.forEach(([cat, color, roomName, place], ei) => {
    const room = roomOf(roomName), fp = footprint({ cat }), info = CATS[cat] || {};
    const spec = place && typeof place === 'object' ? place : null;
    let mode = spec ? 'spec' : place ?? (info.big ? 'wall' : 'free');
    const anchor = spec && spec.rel ? placedAt[ei + spec.k] : null;
    if (spec && spec.rel && !anchor) { placedAt.push(null); return; }
    let placed = null;
    for (let t = 0; t < 300 && !placed; t++) {
      let x, y, th = Math.floor(R.next() * 4) * (Math.PI / 2) + (R.next() - 0.5) * 0.2, pad = 0.5;
      if (spec && spec.at) { [x, y] = spec.at; th = spec.th ?? 0; pad = 0.05; if (t > 0) break; }
      else if (mode === 'wall' || mode === 'corner') {
        const side = Math.floor(R.next() * 4), inward = [Math.PI / 2, -Math.PI / 2, 0, Math.PI][side];
        th = inward - Math.PI / 2;   // back against the wall
        const off = extent(fp, th, inward) + 0.13;
        const end = R.next() < 0.5 ? 0 : 1;
        const along = (lo, hi, e) => (mode === 'corner' ? (end ? hi - e - 0.13 : lo + e + 0.13) : lo + e + 0.15 + R.next() * (hi - lo - 2 * e - 0.3));
        if (side < 2) { x = along(room.x0, room.x1, extent(fp, th, 0)); y = side === 0 ? room.y0 + off : room.y1 - off; }
        else { y = along(room.y0, room.y1, extent(fp, th, Math.PI / 2)); x = side === 2 ? room.x0 + off : room.x1 - off; }
        // the back must touch a real wall (not a door gap or an open room boundary)
        if (!hasWall(x - Math.cos(inward) * off, y - Math.sin(inward) * off)) continue;
        if (mode === 'corner' && t < 200) {   // ... and so must the side
          const sx = side < 2 ? (end ? room.x1 : room.x0) : x, sy = side < 2 ? y : (end ? room.y1 : room.y0);
          if (!hasWall(sx, sy)) continue;
        }
        pad = 0.15;
      } else if (mode === 'center') {
        x = (room.x0 + room.x1) / 2 + (R.next() - 0.5) * (room.x1 - room.x0) * 0.3; y = (room.y0 + room.y1) / 2 + (R.next() - 0.5) * (room.y1 - room.y0) * 0.3;
        th = Math.floor(R.next() * 2) * (Math.PI / 2) + (R.next() - 0.5) * 0.1;
      } else if (mode === 'aisle') {
        const shelves = objects.filter((o) => (o.cat === 'rack' || o.cat === 'display shelf') && o.x > room.x0 && o.x < room.x1 && o.y > room.y0 && o.y < room.y1);
        if (!shelves.length) { mode = 'free'; continue; }
        const s = shelves[Math.floor(R.next() * shelves.length)], sf = footprint(s), side = R.next() < 0.5 ? -1 : 1;
        th = s.th + (R.next() < 0.5 ? 0 : Math.PI / 2);
        const off = sf.hw + extent(fp, th, s.th) + 0.15 + R.next() * 0.2, al = (R.next() * 2 - 1) * (sf.hl - extent(fp, th, s.th + Math.PI / 2));
        x = s.x + Math.cos(s.th) * off * side - Math.sin(s.th) * al; y = s.y + Math.sin(s.th) * off * side + Math.cos(s.th) * al;
        pad = 0.25;
      } else if (anchor) {
        const A = anchor, af = footprint(A), Fd = A.th + Math.PI / 2, Rd = A.th, side = R.next() < 0.5 ? -1 : 1;
        const ext = (a) => extent(af, A.th, a), gap = 0.06 + R.next() * 0.1;
        const at = (fwd, right) => [A.x + Math.cos(Fd) * fwd + Math.cos(Rd) * right, A.y + Math.sin(Fd) * fwd + Math.sin(Rd) * right];
        pad = 0.04;
        if (spec.rel === 'front') { th = A.th + Math.PI + (R.next() - 0.5) * 0.3; [x, y] = at(ext(Fd) + extent(fp, th, Fd) + gap, (R.next() - 0.5) * ext(Rd)); }
        else if (spec.rel === 'around') {
          const s = Math.floor(R.next() * 4), dir = Fd + (s * Math.PI) / 2, along = (R.next() - 0.5) * 1.2 * Math.max(0, extent(af, A.th, dir + Math.PI / 2) - 0.3);
          const d = ext(dir) + extent(fp, 0, 0) + gap;
          x = A.x + Math.cos(dir) * d - Math.sin(dir) * along; y = A.y + Math.sin(dir) * d + Math.cos(dir) * along; th = facingTh(A.x, A.y, x, y) + (R.next() - 0.5) * 0.3;
        } else if (spec.rel === 'head') { th = A.th; const cw = extent(fp, th, Rd), cl = extent(fp, th, Fd); [x, y] = at(-(ext(Fd) - cl - 0.05), side * (ext(Rd) + cw + 0.08)); }
        else if (spec.rel === 'side') { const c = extent(fp, 0, 0); [x, y] = at((R.next() - 0.3) * ext(Fd) * 0.8, side * (ext(Rd) + c + 0.2)); th = facingTh(A.x, A.y, x, y) + (R.next() - 0.5) * 0.4; }
        else if (spec.rel === 'next') { th = A.th; const cw = extent(fp, th, Rd); const back = -ext(Fd) + extent(fp, th, Fd); [x, y] = at(back, side * (ext(Rd) + cw + 0.08 + R.next() * 0.25)); }
        else if (spec.rel === 'facing') { th = A.th + Math.PI; [x, y] = at(ext(Fd) + 2.0 + R.next() * 0.8 + extent(fp, th, Fd), (R.next() - 0.5) * 0.4); }
        else { const a = R.next() * 2 * Math.PI, d = ext(a) + extent(fp, 0, 0) + 0.12 + R.next() * 0.35; x = A.x + Math.cos(a) * d; y = A.y + Math.sin(a) * d; }
        if (t > 150 && spec.rel !== 'near') { const a = R.next() * 2 * Math.PI, d = ext(a) + extent(fp, 0, 0) + 0.15 + R.next() * 0.5; x = A.x + Math.cos(a) * d; y = A.y + Math.sin(a) * d; }
      } else {
        x = room.x0 + 0.7 + R.next() * (room.x1 - room.x0 - 1.4); y = room.y0 + 0.7 + R.next() * (room.y1 - room.y0 - 1.4);
      }
      const o = { id: '', cat, color, x, y, th: Math.atan2(Math.sin(th), Math.cos(th)), room: roomName };
      if (fits(o, room, pad)) placed = o;
    }
    if (placed) { placed.id = `o${id++}`; addObject(placed); }
    placedAt.push(placed);
  });
  for (const [x, y] of def.doors) objects.push({ id: `o${id++}`, cat: 'door', color: 'white', x, y, th: 0 });
  // coverage waypoints per room: a coarse lawnmower grid snapped to reachable free cells
  const fl = flood();
  const ok = (c, room) => { const x = ((c % W) + 0.5) * RES, y = (((c / W) | 0) + 0.5) * RES; return !occ[c] && fl.seen[c] && x > room.x0 + 0.3 && x < room.x1 - 0.3 && y > room.y0 + 0.3 && y < room.y1 - 0.3; };
  const coverage = {};
  for (const room of def.rooms) {
    const pts = [], step = 3.2;
    const nx = Math.max(1, Math.round((room.x1 - room.x0) / step)), ny = Math.max(1, Math.round((room.y1 - room.y0) / step));
    for (let j = 0; j < ny; j++) {
      const row = [];
      for (let i = 0; i < nx; i++) {
        const x = room.x0 + ((i + 0.5) * (room.x1 - room.x0)) / nx, y = room.y0 + ((j + 0.5) * (room.y1 - room.y0)) / ny;
        // nearest reachable free cell inside the room (search rings up to 1.6 m)
        const ci = Math.floor(x / RES), cj = Math.floor(y / RES); let best = null;
        for (let rr = 0; rr <= 8 && !best; rr++) for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue;
          const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= W || b >= H) continue;
          const c = b * W + a; if (!ok(c, room)) continue;
          const d = Math.hypot(di, dj); if (!best || d < best.d) best = { d, x: (a + 0.5) * RES, y: (b + 0.5) * RES };
        }
        if (best && !pts.concat(row).some((p) => Math.hypot(p.x - best.x, p.y - best.y) < 1.2)) row.push({ x: best.x, y: best.y });
      }
      if (j % 2) row.reverse(); pts.push(...row);
    }
    if (!pts.length) pts.push({ x: (room.x0 + room.x1) / 2, y: (room.y0 + room.y1) / 2 });
    coverage[room.name] = pts;
  }
  return { ...def, walls, objects, coverage, seed };
}

export function roomAt(scene, x, y) {
  const r = scene.rooms.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1);
  return r ? r.name : 'outside';
}

export const ROBOT_COLORS = ['#2563eb', '#0d9488', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#db2777', '#4b5563', '#7c3aed'];
