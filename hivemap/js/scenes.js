// Scene library. Each scene: size, walls (segments), rooms (rects), object
// templates placed per seed, and spawn points for up to 10 robots.
import { rng } from './geom.js';

// Object categories: size class drives detection range and occlusion.
export const CATS = {
  // furniture / fixtures
  workbench: { r: 0.8, big: true }, toolbox: { r: 0.35, small: true }, '3d printer': { r: 0.4 }, 'fire extinguisher': { r: 0.2, small: true },
  desk: { r: 0.7 }, chair: { r: 0.3 }, bookshelf: { r: 0.6, big: true }, plant: { r: 0.35 }, bench: { r: 0.8 }, 'trash can': { r: 0.25 },
  'vending machine': { r: 0.5, big: true }, fridge: { r: 0.45, big: true }, table: { r: 0.6 }, 'coffee machine': { r: 0.3, small: true },
  sofa: { r: 1.0, big: true }, tv: { r: 0.6 }, lamp: { r: 0.25 }, armchair: { r: 0.45 }, door: { r: 0.0, landmarkOnly: true },
  // warehouse
  rack: { r: 1.6, big: true, block: true }, pallet: { r: 0.6 }, forklift: { r: 0.8, big: true }, box: { r: 0.3 }, cart: { r: 0.4 },
  'safety cone': { r: 0.2, small: true }, 'charging station': { r: 0.4 },
  // home
  bed: { r: 1.0, big: true }, sink: { r: 0.4 }, wardrobe: { r: 0.6, big: true }, 'dining table': { r: 0.8 }, backpack: { r: 0.2, small: true },
  laptop: { r: 0.2, small: true }, mug: { r: 0.08, small: true }, 'washing machine': { r: 0.35 },
  // hospital
  'hospital bed': { r: 1.0, big: true }, wheelchair: { r: 0.4 }, 'iv stand': { r: 0.2 }, 'medical cart': { r: 0.4 }, defibrillator: { r: 0.15, small: true },
  'reception desk': { r: 1.2, big: true },
};

const seg = (x1, y1, x2, y2) => [x1, y1, x2, y2];
// horizontal/vertical wall with door gaps: gaps = [[from, to], ...] along the wall
function wallH(y, x1, x2, gaps = []) { const out = []; let x = x1; for (const [a, b] of gaps.sort((p, q) => p[0] - q[0])) { if (a > x) out.push(seg(x, y, a, y)); x = b; } if (x < x2) out.push(seg(x, y, x2, y)); return out; }
function wallV(x, y1, y2, gaps = []) { const out = []; let y = y1; for (const [a, b] of gaps.sort((p, q) => p[0] - q[0])) { if (a > y) out.push(seg(x, y, x, a)); y = b; } if (y < y2) out.push(seg(x, y, x, y2)); return out; }
const box = (w, h) => [seg(0, 0, w, 0), seg(w, 0, w, h), seg(w, h, 0, h), seg(0, h, 0, 0)];

// --- scene definitions. `objects` entries: [cat, color, room, x?, y?] (x,y optional fixed)
const OFFICE = {
  id: 'office', name: 'Office floor', w: 24, h: 16,
  walls: [...box(24, 16), ...wallV(8, 0, 16, [[6, 9]]), ...wallV(16, 0, 16, [[5, 8]]), ...wallH(8, 0, 8, [[3, 5]]), ...wallH(8, 16, 24, [[19, 21]])],
  rooms: [{ name: 'Lab', x0: 0, y0: 0, x1: 8, y1: 8 }, { name: 'Office', x0: 0, y0: 8, x1: 8, y1: 16 }, { name: 'Hall', x0: 8, y0: 0, x1: 16, y1: 16 },
    { name: 'Kitchen', x0: 16, y0: 0, x1: 24, y1: 8 }, { name: 'Lounge', x0: 16, y0: 8, x1: 24, y1: 16 }],
  doors: [[8, 7.5], [4, 8], [16, 6.5], [20, 8]],
  objects: [['workbench', 'gray', 'Lab'], ['toolbox', 'red', 'Lab'], ['3d printer', 'white', 'Lab'], ['fire extinguisher', 'red', 'Lab'],
    ['desk', 'brown', 'Office'], ['chair', 'blue', 'Office'], ['chair', 'blue', 'Office'], ['bookshelf', 'brown', 'Office'], ['plant', 'green', 'Office'], ['laptop', 'black', 'Office'],
    ['plant', 'green', 'Hall'], ['bench', 'gray', 'Hall'], ['chair', 'blue', 'Hall'], ['chair', 'blue', 'Hall'], ['trash can', 'gray', 'Hall'], ['fire extinguisher', 'red', 'Hall'], ['vending machine', 'black', 'Hall'],
    ['fridge', 'white', 'Kitchen'], ['table', 'brown', 'Kitchen'], ['chair', 'blue', 'Kitchen'], ['coffee machine', 'black', 'Kitchen'], ['toolbox', 'red', 'Kitchen'], ['mug', 'yellow', 'Kitchen'],
    ['sofa', 'green', 'Lounge'], ['tv', 'black', 'Lounge'], ['plant', 'green', 'Lounge'], ['lamp', 'yellow', 'Lounge'], ['armchair', 'orange', 'Lounge'], ['fire extinguisher', 'red', 'Lounge']],
  spawns: [[1.5, 1.2], [22.5, 4.2], [2.0, 14.5], [22.0, 14.5], [12.0, 1.5], [12.0, 14.5], [10, 8], [14, 8], [6.5, 2.5], [18, 2.5]],
};

const WAREHOUSE = {
  id: 'warehouse', name: 'Warehouse', w: 36, h: 22,
  walls: [...box(36, 22), ...wallV(26, 0, 22, [[3, 6], [15, 18]]), ...wallH(11, 26, 36, [[30, 32]])],
  rooms: [{ name: 'Storage', x0: 0, y0: 0, x1: 26, y1: 22 }, { name: 'Loading dock', x0: 26, y0: 0, x1: 36, y1: 11 }, { name: 'Control room', x0: 26, y0: 11, x1: 36, y1: 22 }],
  doors: [[26, 4.5], [26, 16.5], [31, 11]],
  racks: [[5, 5], [5, 11], [5, 17], [11, 5], [11, 11], [11, 17], [17, 5], [17, 11], [17, 17]],   // 2.8 x 1 m rack rows (aisles between)
  objects: [['pallet', 'brown', 'Storage'], ['pallet', 'brown', 'Storage'], ['pallet', 'brown', 'Storage'], ['box', 'orange', 'Storage'], ['box', 'orange', 'Storage'], ['box', 'blue', 'Storage'],
    ['box', 'green', 'Storage'], ['cart', 'blue', 'Storage'], ['cart', 'blue', 'Storage'], ['safety cone', 'orange', 'Storage'], ['safety cone', 'orange', 'Storage'], ['fire extinguisher', 'red', 'Storage'],
    ['fire extinguisher', 'red', 'Storage'], ['forklift', 'yellow', 'Storage'], ['toolbox', 'red', 'Storage'],
    ['forklift', 'yellow', 'Loading dock'], ['pallet', 'brown', 'Loading dock'], ['pallet', 'brown', 'Loading dock'], ['box', 'orange', 'Loading dock'], ['charging station', 'green', 'Loading dock'], ['safety cone', 'orange', 'Loading dock'],
    ['desk', 'gray', 'Control room'], ['chair', 'black', 'Control room'], ['tv', 'black', 'Control room'], ['fire extinguisher', 'red', 'Control room'], ['coffee machine', 'black', 'Control room'], ['first aid', 'white', 'Control room']],
  spawns: [[2, 2], [34, 2], [2, 20], [34, 20], [14, 2], [14, 20], [24, 11], [30, 6], [8, 11], [20, 8]],
};
WAREHOUSE.objects = WAREHOUSE.objects.map((o) => (o[0] === 'first aid' ? ['defibrillator', 'green', o[2]] : o));

const HOME = {
  id: 'home', name: 'Apartment', w: 20, h: 14,
  walls: [...box(20, 14), ...wallV(8, 0, 14, [[3, 5], [9, 11]]), ...wallH(7, 0, 8, [[6, 7.6]]), ...wallV(14, 0, 14, [[2, 4], [10, 12]]), ...wallH(7, 14, 20, [[16, 17.6]])],
  rooms: [{ name: 'Living room', x0: 0, y0: 0, x1: 8, y1: 7 }, { name: 'Kitchen', x0: 0, y0: 7, x1: 8, y1: 14 }, { name: 'Hallway', x0: 8, y0: 0, x1: 14, y1: 14 },
    { name: 'Bedroom', x0: 14, y0: 0, x1: 20, y1: 7 }, { name: 'Kids room', x0: 14, y0: 7, x1: 20, y1: 14 }],
  doors: [[8, 4], [8, 10], [6.8, 7], [14, 3], [14, 11], [16.8, 7]],
  objects: [['sofa', 'gray', 'Living room'], ['tv', 'black', 'Living room'], ['armchair', 'blue', 'Living room'], ['plant', 'green', 'Living room'], ['lamp', 'yellow', 'Living room'], ['laptop', 'gray', 'Living room'],
    ['fridge', 'white', 'Kitchen'], ['dining table', 'brown', 'Kitchen'], ['chair', 'brown', 'Kitchen'], ['chair', 'brown', 'Kitchen'], ['sink', 'white', 'Kitchen'], ['mug', 'red', 'Kitchen'], ['washing machine', 'white', 'Kitchen'],
    ['plant', 'green', 'Hallway'], ['backpack', 'blue', 'Hallway'], ['bench', 'brown', 'Hallway'],
    ['bed', 'white', 'Bedroom'], ['wardrobe', 'brown', 'Bedroom'], ['lamp', 'yellow', 'Bedroom'], ['laptop', 'black', 'Bedroom'],
    ['bed', 'blue', 'Kids room'], ['desk', 'white', 'Kids room'], ['chair', 'blue', 'Kids room'], ['backpack', 'red', 'Kids room'], ['bookshelf', 'brown', 'Kids room']],
  spawns: [[1.5, 1.5], [18.5, 1.5], [1.5, 12.5], [18.5, 12.5], [11, 1.5], [11, 12.5], [11, 7], [4, 4], [16, 4], [16, 10]],
};

const HOSPITAL = {
  id: 'hospital', name: 'Hospital wing', w: 36, h: 18,
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
    ...['Room 101', 'Room 102', 'Room 103', 'Room 104', 'Room 105', 'Room 201', 'Room 202', 'Room 204', 'Room 205'].flatMap((r, i) => [['hospital bed', 'white', r], i % 2 ? ['iv stand', 'gray', r] : ['chair', 'blue', r], ...(i % 3 === 0 ? [['wheelchair', 'black', r]] : [])]),
    ['reception desk', 'white', 'Nurse station'], ['chair', 'blue', 'Nurse station'], ['medical cart', 'blue', 'Nurse station'], ['defibrillator', 'green', 'Nurse station'],
    ['medical cart', 'blue', 'Corridor'], ['wheelchair', 'black', 'Corridor'], ['fire extinguisher', 'red', 'Corridor'], ['fire extinguisher', 'red', 'Corridor'], ['plant', 'green', 'Corridor'],
    ['defibrillator', 'green', 'Corridor'], ['trash can', 'gray', 'Corridor'], ['vending machine', 'black', 'Corridor']],
  spawns: [[1.5, 9], [34.5, 9], [10, 9], [26, 9], [18, 9], [3, 3], [33, 3], [3, 15], [33, 15], [18, 3]],
};

export const SCENES = [OFFICE, WAREHOUSE, HOME, HOSPITAL];

// ---- build a concrete scene instance for a seed: place objects in free spots.
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function buildScene(def, seed) {
  const R = rng(seed * 7919 + def.id.length);
  const walls = def.walls.slice();
  const objects = []; let id = 0;
  const blockers = [];   // circles that later objects must not overlap
  const spawnPts = def.spawns.map(([x, y]) => ({ x, y }));
  const doorPts = def.doors.map(([x, y]) => ({ x, y }));
  // racks (warehouse): fixed obstacles; add walls-like occluders as objects
  for (const [x, y] of def.racks || []) {
    objects.push({ id: `o${id++}`, cat: 'rack', color: 'gray', x, y: y, th: 0, w: 1.0, l: 4.4 });
    blockers.push({ x, y, r: 0, rect: [x - 0.5, y - 2.2, x + 0.5, y + 2.2] });
  }
  const free = (x, y, r) => {
    for (const w of walls) if (segDist(x, y, ...w) < r + 0.35) return false;
    for (const b of blockers) {
      if (b.rect) { if (x > b.rect[0] - r - 0.6 && x < b.rect[2] + r + 0.6 && y > b.rect[1] - r - 0.6 && y < b.rect[3] + r + 0.6) return false; }
      else if (Math.hypot(x - b.x, y - b.y) < r + b.r + 0.5) return false;
    }
    for (const d of doorPts) if (Math.hypot(x - d.x, y - d.y) < r + 1.0) return false;
    for (const s of spawnPts) if (Math.hypot(x - s.x, y - s.y) < r + 0.8) return false;
    return true;
  };
  const roomOf = (n) => def.rooms.find((r) => r.name === n);
  for (const [cat, color, roomName, fx, fy] of def.objects) {
    const info = CATS[cat] || { r: 0.4 };
    const room = roomOf(roomName); let placed = null;
    // fixtures near walls are more realistic: bias big objects toward room edges
    for (let t = 0; t < 400 && !placed; t++) {
      let x = fx ?? room.x0 + 0.7 + R.next() * (room.x1 - room.x0 - 1.4);
      let y = fy ?? room.y0 + 0.7 + R.next() * (room.y1 - room.y0 - 1.4);
      if (info.big && fx == null && R.next() < 0.7) {
        const side = Math.floor(R.next() * 4), m = info.r + 0.45;
        if (side === 0) y = room.y0 + m; else if (side === 1) y = room.y1 - m; else if (side === 2) x = room.x0 + m; else x = room.x1 - m;
      }
      if (free(x, y, info.r)) placed = { x, y };
    }
    if (!placed) continue;
    const o = { id: `o${id++}`, cat, color, x: placed.x, y: placed.y, th: Math.floor(R.next() * 4) * (Math.PI / 2) + (R.next() - 0.5) * 0.3, room: roomName };
    objects.push(o); blockers.push({ x: o.x, y: o.y, r: info.r });
  }
  for (const [x, y] of def.doors) objects.push({ id: `o${id++}`, cat: 'door', color: 'white', x, y, th: 0 });
  // coverage waypoints per room: a coarse lawnmower grid of free points
  const coverage = {};
  for (const room of def.rooms) {
    const pts = [], step = 3.2;
    const nx = Math.max(1, Math.round((room.x1 - room.x0) / step)), ny = Math.max(1, Math.round((room.y1 - room.y0) / step));
    for (let j = 0; j < ny; j++) {
      const row = [];
      for (let i = 0; i < nx; i++) {
        const x = room.x0 + ((i + 0.5) * (room.x1 - room.x0)) / nx, y = room.y0 + ((j + 0.5) * (room.y1 - room.y0)) / ny;
        row.push({ x, y });
      }
      if (j % 2) row.reverse(); pts.push(...row);
    }
    coverage[room.name] = pts;
  }
  return { ...def, walls, objects, coverage, seed };
}

export function roomAt(scene, x, y) {
  const r = scene.rooms.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1);
  return r ? r.name : 'outside';
}

export const ROBOT_COLORS = ['#2563eb', '#0d9488', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#db2777', '#4b5563', '#7c3aed'];
