// Tasks and team policies. The same task is run twice on identical worlds:
// once where robots share and optimize a team map, once where every robot
// only knows what it saw itself. Metrics show what the shared map buys.
import { roomAt, CATS } from './scenes.js';
import { makeNav } from './nav.js';
import { rng, segIntersect } from './geom.js';
import { embedText, COLOR_WORDS } from './embed.js';
import { MIN_SIGHTINGS } from './team.js';

// reached = within 1 m of the object's footprint
const reachedOk = (d, o) => d != null && d < (CATS[o?.cat]?.r ?? 0.4) + 1.0;

export const TASKS = [
  { id: 'fetch', name: 'Fetch', blurb: 'Robot 1 must go to an object that another robot saw.' },
  { id: 'inventory', name: 'Inventory', blurb: 'Robot 1 must report every instance of a category (with positions).' },
  { id: 'rendezvous', name: 'Rendezvous', blurb: 'All robots meet at an object only one robot saw.' },
  { id: 'dispatch', name: 'Dispatch', blurb: 'Visit every instance of a category, splitting the work across robots.' },
  { id: 'search', name: 'Search', blurb: 'A lost item turns up somewhere after the map was built; Robot 1 must get to it.' },
];

// Prior shift: robots split the rooms and explore them in parallel (same in both modes).
export async function priorExploration(T) {
  const rooms = T.scene.rooms.map((r) => r.name);
  await Promise.all(T.robots.map((_, r) => (async () => { for (let k = r; k < rooms.length; k += T.n) await T.exploreRoom(r, rooms[k]); })()));
}

const center = (T, room) => { const q = T.scene.rooms.find((x) => x.name === room); return { x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 }; };
const seenBy = (T, r, objId) => objId in T.local(r).lms;
// cheap check (no map solve): has robot r seen something matching the query at least twice?
const quickKnows = (T, r, task) => { const q = embedText(task.query), s = T.sims[r]; return Object.keys(s.sightings).some((id) => { if (s.sightings[id] < MIN_SIGHTINGS) return false; const l = s.quickLabel(id); if (!l || l.cat !== q.cat || (q.col && l.color !== q.col)) return false; if (!task.room) return true; const p = s.quickPos(id), rm = T.scene.rooms.find((x) => x.name === task.room); return p && p.x > rm.x0 - 1.5 && p.x < rm.x1 + 1.5 && p.y > rm.y0 - 1.5 && p.y < rm.y1 + 1.5; }); };
const sighted = (T, r, objId) => (T.sims[r].sightings[objId] || 0) >= MIN_SIGHTINGS;   // cheap: same rule as the map
const instances = (T, cat, color) => T.scene.objects.filter((o) => o.cat === cat && !o.hidden && (!color || o.color === color));
const pickBy = (arr, k) => arr[((k % arr.length) + arr.length) % arr.length];

// ---- lost item for the search task: a small object that appears after the prior shift
const LOST = ['backpack', 'laptop', 'toolbox', 'wheelchair', 'cart', 'box', 'safety cone'];
export function lostItem(T) {
  const R = rng(T.seed * 4099 + 17), sc = T.scene;
  const cats = LOST.filter((c) => CATS[c]);
  for (let t = 0; t < 400; t++) {
    const cat = pickBy(cats, Math.floor(R.next() * 1e6));
    const used = new Set(sc.objects.filter((o) => o.cat === cat).map((o) => o.color));
    const colors = COLOR_WORDS.filter((c) => !used.has(c)); if (!colors.length) continue;
    const color = pickBy(colors, Math.floor(R.next() * 1e6));
    const room = pickBy(sc.rooms, Math.floor(R.next() * 1e6));
    const x = room.x0 + 0.8 + R.next() * (room.x1 - room.x0 - 1.6), y = room.y0 + 0.8 + R.next() * (room.y1 - room.y0 - 1.6);
    const r = CATS[cat].r;
    // a free, reachable spot clear of furniture, not where the robots are parked
    if (!T.nav.isFree({ x, y }) || [[r + 0.4, 0], [-r - 0.4, 0], [0, r + 0.4], [0, -r - 0.4]].some(([dx, dy]) => !T.nav.isFree({ x: x + dx, y: y + dy }))) continue;
    if (sc.starts.some((s) => Math.hypot(s.x - x, s.y - y) < 2.5)) continue;
    if (!T.nav.plan(sc.starts[0], { x, y })) continue;
    const id = `o${sc.objects.reduce((m, o) => Math.max(m, +o.id.slice(1) || 0), 0) + 1}`;
    return { id, cat, color, x, y, th: R.next() * Math.PI * 2, room: room.name, lost: true };
  }
  return null;
}
// put the lost item into the world (idempotent); the planner and the sensors see it from now on
export function placeItem(T, item) {
  let o = T.scene.objects.find((q) => q.id === item.id);
  if (o) return o;
  o = { ...item }; T.scene.objects.push(o);
  T.nav = makeNav(T.scene);
  T.emit({ type: 'objectadded', object: o });
  return o;
}

// Pick concrete task parameters from the world after the prior shift.
// Targets, categories and phrasing vary with the seed.
export function makeTask(T, kind) {
  const objs = T.scene.objects.filter((o) => o.cat !== 'door' && !CATS[o.cat]?.block && !o.hidden && !o.dock);
  const others = (o) => T.robots.some((_, r) => r !== 0 && seenBy(T, r, o.id));
  const inRoom = (o) => instances(T, o.cat, o.color).filter((q) => roomAt(T.scene, q.x, q.y) === roomAt(T.scene, o.x, o.y)).length === 1;
  const unique = (o) => instances(T, o.cat, o.color).length === 1;
  const nameable = (o) => unique(o) || inRoom(o);
  const K = T.seed * 13 + T.n * 7;
  if (kind === 'fetch' || kind === 'rendezvous') {
    let pool = objs.filter((o) => others(o) && !seenBy(T, 0, o.id) && nameable(o));
    if (!pool.length) pool = objs.filter((o) => T.robots.some((_, r) => seenBy(T, r, o.id)) && nameable(o));
    if (!pool.length) pool = objs.filter(nameable);
    // prefer targets the robots recognised correctly, and recognisable things over tiny clutter
    // what the robots think each object is: a good target is one whose description picks out only it
    const perceived = {};
    T.robots.forEach((_, r) => { for (const id of Object.keys(T.local(r).lms)) { const lab = T.labelOf(r, id); (perceived[lab] ||= new Set()).add(id); } });
    const readOk = (o) => { const ids = perceived[`${o.color} ${o.cat}`]; if (!ids || !ids.has(o.id)) return false; return unique(o) ? ids.size === 1 : [...ids].every((id) => { const q = T.scene.objects.find((x) => x.id === id); return id === o.id || !q || roomAt(T.scene, q.x, q.y) !== roomAt(T.scene, o.x, o.y); }); };
    if (pool.some(readOk)) pool = pool.filter(readOk);
    const big = pool.filter((o) => !CATS[o.cat]?.small);
    const o = pickBy(big.length >= 3 ? big : pool, K);
    const room = unique(o) ? null : roomAt(T.scene, o.x, o.y);
    const what = `${o.color} ${o.cat}${room ? ` in the ${room}` : ''}`;
    const fetchText = pickBy([`Robot 1: go to the ${what}.`, `Robot 1: check on the ${what}.`, `Robot 1: bring a sensor reading from the ${what}.`], K >> 2);
    return { kind, target: o, query: `${o.color} ${o.cat}`, room, text: kind === 'fetch' ? fetchText : `All robots: meet at the ${what}.` };
  }
  if (kind === 'search') {
    const item = lostItem(T);
    if (!item) return makeTask(T, 'fetch');
    return { kind, item, target: item, query: `${item.color} ${item.cat}`, text: `Someone lost a ${item.color} ${item.cat}. Robot 1: find it and go to it.` };
  }
  const counts = {}; for (const o of objs) counts[o.cat] = (counts[o.cat] || 0) + 1;
  const prefer = ['fire extinguisher', 'defibrillator', 'chair', 'pallet', 'plant', 'wheelchair', 'box', 'safety cone', 'trash can', 'cabinet', 'shopping cart', 'iv stand', 'nightstand', 'desk', 'fridge', 'medical cart', 'gas cylinder', 'freezer', 'checkout counter', 'whiteboard', 'bookshelf', 'lamp', 'cart'];
  // categories whose instances stand apart (a row of shopping carts can't be counted one by one)
  const apart = (c) => { const os = objs.filter((o) => o.cat === c); return os.every((a) => os.every((b) => a === b || Math.hypot(a.x - b.x, a.y - b.y) > 1.5)); };
  const cands = prefer.filter((c) => counts[c] >= 2 && counts[c] <= 10 && apart(c));
  const cat = cands.length ? pickBy(cands.slice(0, 6), K) : Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const text = kind === 'inventory'
    ? pickBy([`Robot 1: list every ${cat} in the building.`, `Robot 1: how many ${cat}s are there, and where?`], K >> 1)
    : pickBy([`Team: visit every ${cat}.`, `Team: inspect each ${cat}.`], K >> 1);
  return { kind, cat, query: cat, total: counts[cat], text };
}

const matchesCat = (o, cat) => { const e = embedText(o.label); return e && e.cat === cat; };
const matchesTarget = (o, task) => { const e = embedText(o.label), q = embedText(task.query); return e && q && e.cat === q.cat && (!q.col || e.col === q.col) && (!task.room || o.room === task.room); };

// merge same-category reports within 1 m (one physical object seen twice)
function dedupe(list) {
  const out = [];
  for (const o of list) if (!out.some((q) => Math.hypot(q.x - o.x, q.y - o.y) < 1.0)) out.push(o);
  return out;
}

// Explore rooms (nearest first) that robot r has not explored, until found() is true.
async function exploreUntil(T, r, found, { avoid = new Set(), done = (n) => T.sims[r].explored.has(n), every = 3, cheap = null } = {}) {
  for (;;) {
    if (found()) return true;
    const p = T.pose[r];
    const todo = T.scene.rooms.map((q) => q.name).filter((n) => !done(n) && !avoid.has(n));
    if (!todo.length) return found();
    todo.sort((a, b) => Math.hypot(center(T, a).x - p.x, center(T, a).y - p.y) - Math.hypot(center(T, b).x - p.x, center(T, b).y - p.y));
    avoid.add(todo[0]);
    // full check (may re-solve the map) at most every few seconds, and only once the cheap check passes
    let last = -1e9;
    const until = () => { if (cheap && !cheap()) return false; if (T.time - last < Math.max(every, 3)) return false; last = T.time; return found(); };
    await T.exploreRoom(r, todo[0], { until: every === 0 && !cheap ? found : until, untilEvery: 0 });
  }
}

// Meeting slots around a point: free spots that see it, at least 0.9 m apart, closest first.
function meetingSlots(T, c, n, minR) {
  const out = [];
  const sees = (p) => !T.scene.walls.some((w) => segIntersect(p, c, { x: w[0], y: w[1] }, { x: w[2], y: w[3] }));
  for (let rad = minR; out.length < n && rad < minR + 4; rad += 0.45) {
    const m = Math.max(6, Math.floor((2 * Math.PI * rad) / 0.9));
    for (let i = 0; i < m && out.length < n; i++) {
      const a = (2 * Math.PI * i) / m + rad, p = { x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad };
      if (T.nav.isFree(p) && sees(p) && out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 0.9)) out.push(p);
    }
  }
  return out;
}

// ---------- policies
export async function runTask(T, task, log = () => {}) {
  const t0 = T.time, d0 = T.sims.map((s) => s.distance), b0 = T.bytes.objects + T.bytes.dgs;
  const shared = T.shared;
  const say = (msg) => log(`[t=${Math.round(T.time - t0)}s] ${msg}`);
  let out = {};
  if (task.kind === 'search' && task.item) { task = { ...task, target: placeItem(T, task.item) }; say(`a ${task.query} was left somewhere in the building`); }
  const syncMap = async () => {
    let ex = T.exchange();
    say(`maps exchanged: ${ex.robots_merged.length}/${T.n} robots merged, ${ex.verified_matches} object matches, ${ex.robot_encounters_used} encounters`);
    if (ex.robots_not_overlapping.length) {
      // isolated robots drive to the nearest merged teammate so an encounter links their maps
      say(`${ex.robots_not_overlapping.join(', ')} not linked yet: driving to a teammate to connect maps`);
      await Promise.all(T.M.missing.map((r) => {
        const mates = T.M.joined.map((j) => ({ j, d: Math.hypot(T.pose[j].x - T.pose[r].x, T.pose[j].y - T.pose[r].y) })).sort((a, b) => a.d - b.d);
        return mates.length ? T.goTo(r, { x: T.pose[mates[0].j].x, y: T.pose[mates[0].j].y }, `${T.robots[mates[0].j].name}`) : null;
      }));
      ex = T.exchange();
      say(`re-exchanged: ${ex.robots_merged.length}/${T.n} robots merged`);
    }
    const op = await T.optimize(T.animated);
    say(`team map optimized: disagreement ${op.map_disagreement_before_m} -> ${op.map_disagreement_after_m} m`);
  };
  if (shared) await syncMap();

  if (task.kind === 'fetch') {
    const find = () => T.objectsFor(0).find((o) => matchesTarget(o, task));
    if (!find()) { say('Robot 1 does not know the target; exploring'); await exploreUntil(T, 0, () => !!find(), { cheap: () => quickKnows(T, 0, task) }); }
    const o = find();
    if (o) { say(`Robot 1 drives to ${o.label} (${o.id})`); const nav = await T.goTo(0, { x: o.x, y: o.y, gt: task.target }, o.label); out = { reached_m: nav.distance_to_real_object_m }; }
    const ok = reachedOk(out.reached_m, task.target);
    out.success = ok; out.score = ok ? 1 : 0;
  }
  if (task.kind === 'search') {
    const id = task.target.id;
    // the item is whatever matches the description, or a new object of that kind (colour misread from a few views)
    const q = embedText(task.query), before = T.objectsFor(0).filter((o) => matchesCat(o, q.cat));
    const isNew = (o) => matchesCat(o, q.cat) && !before.some((b) => Math.hypot(b.x - o.x, b.y - o.y) < 1.5);
    const find = () => { const os = T.objectsFor(0); return os.find((o) => matchesTarget(o, task) && isNew(o)) || os.find(isNew); };
    let finder = null;
    if (shared) {
      // the team splits the rooms (nearest robot per room, balanced) and stops as soon as anyone sees the item
      const seen = () => { if (finder == null) { const r = T.robots.findIndex((_, i) => sighted(T, i, id)); if (r >= 0) finder = r; } return finder != null; };
      const rooms = T.scene.rooms.map((q) => q.name), queues = T.robots.map(() => []), pos = T.pose.map((p) => ({ ...p }));
      const order = rooms.slice().sort((a, b) => Math.hypot(center(T, a).x - T.pose[0].x, center(T, a).y - T.pose[0].y) - Math.hypot(center(T, b).x - T.pose[0].x, center(T, b).y - T.pose[0].y));
      for (const room of order) {
        let best = null;
        T.robots.forEach((_, r) => { const c = center(T, room), d = Math.hypot(c.x - pos[r].x, c.y - pos[r].y) + queues[r].length * 12; if (!best || d < best.d) best = { d, r }; });
        queues[best.r].push(room); pos[best.r] = center(T, room);
      }
      say(`search split: ${queues.map((q, r) => (q.length ? `${T.robots[r].id} → ${q.join(', ')}` : null)).filter(Boolean).join('; ')}`);
      await Promise.all(queues.map((q, r) => (async () => { for (const room of q) { if (seen()) return; await T.exploreRoom(r, room, { until: seen, untilEvery: 0 }); } })()));
      if (finder != null) { say(`${T.robots[finder].id} spotted the ${task.query}; sharing the map`); await syncMap(); }
    } else {
      // without a shared map nobody else can tell Robot 1 where it is: Robot 1 searches by itself
      say('Robot 1 searches the building room by room');
      await exploreUntil(T, 0, () => sighted(T, 0, id), { done: () => false, every: 0 });
    }
    const o = find();
    if (o) { say(`Robot 1 drives to ${o.label}`); const nav = await T.goTo(0, { x: o.x, y: o.y, gt: task.target }, o.label); out = { reached_m: nav.distance_to_real_object_m }; }
    else say(`the ${task.query} was not found`);
    const ok = reachedOk(out.reached_m, task.target);
    out.success = ok; out.score = ok ? 1 : 0;
  }
  if (task.kind === 'inventory') {
    const list = () => dedupe(T.objectsFor(0).filter((o) => matchesCat(o, task.cat)));
    if (!shared) { say(`Robot 1 must survey the rooms it has not seen itself`); await exploreUntil(T, 0, () => false); }
    const reported = list(), gt = instances(T, task.cat);
    const used = new Set(); let hit = 0;
    for (const o of reported) { const g = gt.find((q) => !used.has(q.id) && Math.hypot(q.x - o.x, q.y - o.y) < 1.0); if (g) { used.add(g.id); hit++; } }
    out = { reported: reported.length, found: hit, total: gt.length, recall: hit / gt.length, precision: reported.length ? hit / reported.length : 0 };
    say(`Robot 1 reports ${reported.length} × ${task.cat}: ${hit}/${gt.length} correct`);
    out.success = out.recall >= 0.99 && out.precision >= 0.99; out.score = out.recall;
  }
  if (task.kind === 'rendezvous') {
    // everyone heads for its own slot around the meeting point (slots are ranked the same way by every robot)
    const near = (CATS[task.target.cat]?.r ?? 0.4) + 1.5;
    const claims = new Set();
    const arrivals = await Promise.all(T.robots.map((_, r) => (async () => {
      const find = () => T.objectsFor(r).find((o) => matchesTarget(o, task));
      if (!find()) await exploreUntil(T, r, () => !!find(), { cheap: () => quickKnows(T, r, task) });
      const o = find(); if (!o) return null;
      // approach, then claim the nearest free spot of the ring around the meeting point (claims go over the radio)
      const slots = meetingSlots(T, o, T.n + 4, (CATS[task.target.cat]?.r ?? 0.4) + 0.75);
      if (Math.hypot(T.pose[r].x - o.x, T.pose[r].y - o.y) > 3.5) await T.goTo(r, { x: o.x, y: o.y, standoff: 3.0 }, o.label);
      const key = (q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      const cost = (q) => Math.hypot(q.x - o.x, q.y - o.y) + 0.3 * Math.hypot(q.x - T.pose[r].x, q.y - T.pose[r].y);   // inner ring first
      const free = slots.filter((q) => !claims.has(key(q)) && T.robots.every((_, j) => j === r || Math.hypot(T.pose[j].x - q.x, T.pose[j].y - q.y) > 0.6)).sort((a, b) => cost(a) - cost(b));
      const s = free[0] || o; if (free[0]) claims.add(key(free[0]));
      await T.goTo(r, { x: s.x, y: s.y, standoff: 0.05, faceTo: { x: o.x, y: o.y }, ...(free[0] ? {} : { gt: task.target }) }, o.label);
      const p = T.pose[r];
      // at the meeting point = close to the real object, allowing for the ring of teammates around it
      return { d: Math.hypot(task.target.x - p.x, task.target.y - p.y), allow: Math.max(near, Math.hypot(s.x - o.x, s.y - o.y) + 1.3) };
    })()));
    const ok = arrivals.filter((a) => a && a.d < a.allow).length;
    out = { arrived: ok, robots: T.n, distances_m: arrivals.map((a) => (a ? +a.d.toFixed(2) : null)) }; out.success = ok === T.n; out.score = ok / T.n;
    say(`${ok}/${T.n} robots at the meeting point`);
  }
  if (task.kind === 'dispatch') {
    const gt = instances(T, task.cat), visited = new Set();
    const known = (r) => dedupe(T.objectsFor(r).filter((o) => matchesCat(o, task.cat)));
    if (shared) {
      // central assignment over the team map: greedy nearest robot per target, robots work their queues in parallel
      const targets = known(0).slice(), queues = T.robots.map(() => []), pos = T.pose.map((p) => ({ ...p }));
      while (targets.length) {
        let best = null;
        targets.forEach((o, ti) => T.robots.forEach((_, r) => { const d = Math.hypot(o.x - pos[r].x, o.y - pos[r].y) + queues[r].length * 6; if (!best || d < best.d) best = { d, ti, r }; }));
        const o = targets.splice(best.ti, 1)[0]; queues[best.r].push(o); pos[best.r] = { x: o.x, y: o.y };
      }
      await Promise.all(queues.map((q, r) => (async () => { for (const o of q) { const nav = await T.goTo(r, { x: o.x, y: o.y, gt: o._gt }, o.label); if (o._gt && reachedOk(nav.distance_to_real_object_m, o._gt)) visited.add(o._gt.id); } })()));
    } else {
      // each robot visits what it knows; nobody knows what the others know
      await Promise.all(T.robots.map((_, r) => (async () => { for (const o of known(r)) { const nav = await T.goTo(r, { x: o.x, y: o.y, gt: o._gt }, o.label); if (o._gt && reachedOk(nav.distance_to_real_object_m, o._gt)) visited.add(o._gt.id); } })()));
    }
    const gtIds = new Set(gt.map((o) => o.id));
    const v = [...visited].filter((x) => gtIds.has(x)).length;
    out = { visited: v, total: gt.length }; out.success = v === gt.length; out.score = v / gt.length;
    say(`${v}/${gt.length} ${task.cat} visited`);
  }
  out.time_s = Math.round(T.time - t0);
  out.distance_m = +T.sims.reduce((a, s, r) => a + s.distance - d0[r], 0).toFixed(1);
  out.bytes = T.bytes.objects + T.bytes.dgs - b0;
  return out;
}

// Headless comparison on identical worlds.
export async function compare(TeamCls, sceneDef, n, seed, kind) {
  const results = {};
  let task;
  for (const shared of [true, false]) {
    const T = new TeamCls(sceneDef, n, seed, { shared });
    await T.runHeadless(priorExploration);
    task ||= makeTask(T, kind);
    const t = { ...task, target: task.target && (T.scene.objects.find((o) => o.id === task.target.id) || task.target) };
    const logs = [];
    results[shared ? 'shared' : 'independent'] = { ...(await T.runHeadless((TT) => runTask(TT, t, (m) => logs.push(m)))), logs };
  }
  return { task, results };
}
