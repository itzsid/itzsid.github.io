// Tasks and team policies. The same task is run twice on identical worlds:
// once where robots share and optimize a team map, once where every robot
// only knows what it saw itself. Metrics show what the shared map buys.
import { roomAt, CATS } from './scenes.js';

// reached = within 1 m of the object's footprint
const reachedOk = (d, o) => d != null && d < (CATS[o?.cat]?.r ?? 0.4) + 1.0;
import { embedText } from './embed.js';

export const TASKS = [
  { id: 'fetch', name: 'Fetch', blurb: 'Robot 1 must go to an object that another robot saw.' },
  { id: 'inventory', name: 'Inventory', blurb: 'Robot 1 must report every instance of a category (with positions).' },
  { id: 'rendezvous', name: 'Rendezvous', blurb: 'All robots meet at an object only one robot saw.' },
  { id: 'dispatch', name: 'Dispatch', blurb: 'Visit every instance of a category, splitting the work across robots.' },
];

// Prior shift: robots split the rooms and explore them in parallel (same in both modes).
export async function priorExploration(T) {
  const rooms = T.scene.rooms.map((r) => r.name);
  await Promise.all(T.robots.map((_, r) => (async () => { for (let k = r; k < rooms.length; k += T.n) await T.exploreRoom(r, rooms[k]); })()));
}

const center = (T, room) => { const q = T.scene.rooms.find((x) => x.name === room); return { x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 }; };
const seenBy = (T, r, objId) => objId in T.local(r).lms;
const instances = (T, cat, color) => T.scene.objects.filter((o) => o.cat === cat && (!color || o.color === color));

// Pick concrete task parameters from the world after the prior shift.
export function makeTask(T, kind) {
  const objs = T.scene.objects.filter((o) => o.cat !== 'door' && o.cat !== 'rack');
  const others = (o) => T.robots.some((_, r) => r !== 0 && seenBy(T, r, o.id));
  const unique = (o) => instances(T, o.cat, o.color).length === 1;
  if (kind === 'fetch' || kind === 'rendezvous') {
    let pool = objs.filter((o) => others(o) && !seenBy(T, 0, o.id) && unique(o));
    if (!pool.length) pool = objs.filter((o) => !seenBy(T, 0, o.id) && unique(o));
    if (!pool.length) pool = objs.filter(unique);
    const o = pool[(T.seed * 13) % pool.length];
    return { kind, target: o, query: `${o.color} ${o.cat}`, text: kind === 'fetch' ? `Robot 1: go to the ${o.color} ${o.cat}.` : `All robots: meet at the ${o.color} ${o.cat}.` };
  }
  const counts = {}; for (const o of objs) counts[o.cat] = (counts[o.cat] || 0) + 1;
  const prefer = ['fire extinguisher', 'defibrillator', 'chair', 'pallet', 'plant', 'wheelchair', 'box', 'safety cone'];
  const cat = prefer.find((c) => counts[c] >= 2) || Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return { kind, cat, query: cat, total: counts[cat], text: kind === 'inventory' ? `Robot 1: list every ${cat} in the building.` : `Team: visit every ${cat}.` };
}

const matchesCat = (o, cat) => { const e = embedText(o.label); return e && e.cat === cat; };
const matchesTarget = (o, task) => { const e = embedText(o.label), q = embedText(task.query); return e && q && e.cat === q.cat && (!q.col || e.col === q.col); };

// merge same-category reports within 1 m (one physical object seen twice)
function dedupe(list) {
  const out = [];
  for (const o of list) if (!out.some((q) => Math.hypot(q.x - o.x, q.y - o.y) < 1.0)) out.push(o);
  return out;
}

// Explore rooms (nearest first) that robot r has not explored, until found() is true.
async function exploreUntil(T, r, found, { avoid = new Set() } = {}) {
  for (;;) {
    if (found()) return true;
    const p = T.pose[r];
    const todo = T.scene.rooms.map((q) => q.name).filter((n) => !T.sims[r].explored.has(n) && !avoid.has(n));
    if (!todo.length) return found();
    todo.sort((a, b) => Math.hypot(center(T, a).x - p.x, center(T, a).y - p.y) - Math.hypot(center(T, b).x - p.x, center(T, b).y - p.y));
    await T.exploreRoom(r, todo[0]);
  }
}

// ---------- policies
export async function runTask(T, task, log = () => {}) {
  const t0 = T.time, d0 = T.sims.map((s) => s.distance), b0 = T.bytes.objects + T.bytes.dgs;
  const shared = T.shared;
  const say = (msg) => log(`[t=${Math.round(T.time - t0)}s] ${msg}`);
  let out = {};
  if (shared) {
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
  }

  if (task.kind === 'fetch') {
    const find = () => T.objectsFor(0).find((o) => matchesTarget(o, task));
    if (!find()) { say('Robot 1 does not know the target; exploring'); await exploreUntil(T, 0, () => !!find()); }
    const o = find();
    if (o) { say(`Robot 1 drives to ${o.label} (${o.id})`); const nav = await T.goTo(0, { x: o.x, y: o.y, gt: task.target }, o.label); out = { reached_m: nav.distance_to_real_object_m }; }
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
    const arrivals = await Promise.all(T.robots.map((_, r) => (async () => {
      const find = () => T.objectsFor(r).find((o) => matchesTarget(o, task));
      if (!find()) await exploreUntil(T, r, () => !!find());
      const o = find(); if (!o) return null;
      const nav = await T.goTo(r, { x: o.x, y: o.y, gt: task.target }, o.label);
      return nav.distance_to_real_object_m;
    })()));
    const ok = arrivals.filter((d) => d != null && d < (CATS[task.target.cat]?.r ?? 0.4) + 1.5).length;
    out = { arrived: ok, robots: T.n }; out.success = ok === T.n; out.score = ok / T.n;
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
    out = { visited: visited.size, total: gt.length }; out.success = visited.size === gt.length; out.score = visited.size / gt.length;
    say(`${visited.size}/${gt.length} ${task.cat} visited`);
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
    const t = { ...task, target: task.target && T.scene.objects.find((o) => o.id === task.target.id) };
    const logs = [];
    results[shared ? 'shared' : 'independent'] = { ...(await T.runHeadless((TT) => runTask(TT, t, (m) => logs.push(m)))), logs };
  }
  return { task, results };
}
