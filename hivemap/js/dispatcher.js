// Team dispatcher: takes a task in plain words, makes sure the team map is
// current, decides which robot(s) should do it (real path length, who is idle,
// who actually knows where the object is) and hands the work to their agents.
import { embedText, CATEGORIES } from './embed.js';
import { roomAt } from './scenes.js';
import { fmt } from './engine.js';

// ---------------------------------------------------------------- parsing
const NUMBER_WORDS = { one: 1, a: 1, an: 1, single: 1, two: 2, both: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// phrase -> words embedText understands (applied before embedding)
const PHRASES = {
  'coffee maker': 'coffee machine', 'espresso machine': 'coffee machine', 'garbage can': 'trash can', 'garbage bin': 'trash can', 'waste bin': 'trash can',
  'rubbish bin': 'trash can', 'trash bin': 'trash can', 'wastebasket': 'trash can', garbage: 'trash can', rubbish: 'trash can', 'work bench': 'workbench',
  'book shelf': 'bookshelf', bookshelves: 'bookshelf', shelves: 'bookshelf', 'easy chair': 'armchair', recliner: 'armchair', stool: 'chair', stools: 'chair',
  'potted plant': 'plant', houseplant: 'plant', houseplants: 'plant', flowers: 'plant', flower: 'plant', 'fork lift': 'forklift', 'charging dock': 'charging station',
  'charging stations': 'charging station', gurney: 'hospital bed', stretcher: 'hospital bed', 'drip stand': 'iv stand', cupboard: 'wardrobe', telly: 'tv', tvs: 'tv',
  'first aid': 'defibrillator', 'washing machines': 'washing machine', dryer: 'washing machine', 'kitchen table': 'dining table', 'medical carts': 'medical cart',
  'fire extinguishers': 'fire extinguisher', 'trash cans': 'trash can', 'vending machines': 'vending machine', 'coffee machines': 'coffee machine', '3d printers': '3d printer',
};
const ROBOT_WORDS = /\b(robots?|bots?|team|everyone|everybody|all of you|units?)\b/;
const MANIPULATE = /\b(pick (it |them )?up|grab|lift|carry|open|close|shut|clean|wipe|push|pull|turn (on|off)|switch (on|off)|plug|unplug|repair|fix|cook|make (me )?(a )?coffee|water the)\b/;

const vocab = (() => {
  const words = new Set();
  for (const c of CATEGORIES) for (const w of c.split(' ')) words.add(w);
  return words;
})();
function singular(w) {
  if (vocab.has(w)) return w;
  for (const [suf, rep] of [['ies', 'y'], ['ves', 'f'], ['es', ''], ['s', '']]) if (w.endsWith(suf) && vocab.has(w.slice(0, -suf.length) + rep)) return w.slice(0, -suf.length) + rep;
  return w;
}
export function normalizeText(text) {
  let t = ` ${String(text).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const [p, rep] of Object.entries(PHRASES).sort((a, b) => b[0].length - a[0].length)) t = t.split(` ${p} `).join(` ${rep} `);
  return ` ${t.trim().split(' ').map(singular).join(' ')} `;
}

// rooms mentioned in the text, with their position; aliases: "hall" for Hallway, "101" for Room 101
function findRooms(scene, t) {
  const out = [];
  const names = scene.rooms.map((q) => q.name).sort((a, b) => b.length - a.length);
  let rest = t;
  const take = (alias, name) => {
    const k = rest.indexOf(` ${alias} `); if (k < 0) return false;
    out.push({ name, at: k, alias }); rest = rest.slice(0, k) + ' ' + '#'.repeat(alias.length) + ' ' + rest.slice(k + alias.length + 2); return true;
  };
  for (const n of names) while (take(normalizeText(n).trim(), n));
  for (const n of names) {
    const low = n.toLowerCase(), first = low.split(' ')[0];
    const num = low.match(/\d+/);
    if (num) take(num[0], n);
    else if (first.length > 3 && !vocab.has(first) && !scene.rooms.some((q) => q.name !== n && q.name.toLowerCase().startsWith(first))) take(first, n);
    if (low === 'hallway' || low === 'corridor') { take('hall', n); take('hallway', n); take('corridor', n); }
    if (low === 'hall') take('hallway', n);
    if (low === 'lab') take('laboratory', n);
  }
  return { rooms: out.sort((a, b) => a.at - b.at), rest };
}

// Parse a task into { intent, target{col,cat,text}, objRoom, robots[], robotRoom, count, everyone, ... }.
export function parseTask(scene, nRobots, text) {
  const raw = String(text).trim();
  let t = normalizeText(raw);
  const out = { raw, intent: null, target: null, objRoom: null, rooms: [], robots: [], robotRoom: null, count: null, everyone: false, plural: false };
  // explicit robots: "Robot 3", "R2", "robots 2 and 4", "robot two"
  const numWord = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const toNum = (s) => (/\d/.test(s) ? +s : NUMBER_WORDS[s]);
  for (const m of t.matchAll(new RegExp(`\\b(?:robots?|r)\\s?${numWord}((?:\\s(?:and|or)?\\s?(?:r\\s?)?${numWord}\\b)*)`, 'g'))) {
    const nums = [m[1], ...(m[2] || '').split(/\s|and|or|r/).filter(Boolean)].map(toNum).filter((x) => x >= 1);
    if (/^ ?r ?\d/.test(m[0]) || /^robots? /.test(m[0])) for (const x of nums) if (!out.robots.includes(x - 1)) out.robots.push(x - 1);
  }
  t = t.replace(new RegExp(`\\b(?:robots?|r)\\s?${numWord}((?:\\s(?:and|or)?\\s?(?:r\\s?)?${numWord}\\b)*)`, 'g'), ' ').replace(/\s+/g, ' ');
  const cm = t.match(new RegExp(`\\b${numWord}\\s(?:of (?:the |your )?)?(?:robots?|bots?)\\b`));
  if (cm && !out.robots.length) out.count = toNum(cm[1]);
  out.everyone = /\b(everyone|everybody|all robots|all the robots|all of you|every robot|whole team|the team|all units|all \d+ robots|all \w+ robots|team)\b/.test(t) || /\b(robots|you all)\b/.test(t) && !out.count && /\b(all|every)\b/.test(t);

  const { rooms, rest } = findRooms(scene, t);
  out.rooms = rooms.map((r) => r.name);
  // "the robot in the kitchen" -> robot filter; "the chair in the office" -> object filter
  for (const r of rooms) {
    const before = t.slice(Math.max(0, r.at - 40), r.at + 1);
    if (/\b(robot|bot|one|whoever|anyone)( that s| that is| who is| currently| which is)? (in|at|inside) (the )?$/.test(before)) out.robotRoom = r.name;
  }
  const otherRooms = rooms.filter((r) => r.name !== out.robotRoom);
  out.room = otherRooms[0]?.name || null;
  const q = embedText(rest.replace(/\b(robots?|bots?)\b/g, ' '));
  if (q) {
    out.target = { col: q.col, cat: q.cat, text: `${q.col || ''} ${q.cat || ''}`.trim() };
    out.objRoom = out.room;
    const last = (q.cat || '').split(' ').pop();
    const noRobots = t.replace(/\b(all|every|each)( of)?( the| you| your)? (robots?|bots?|of you|units?)\b|\beveryone\b/g, ' ');
    out.plural = new RegExp(`\\b(${last}s|${last}es)\\b`).test(` ${raw.toLowerCase()} `) || /\b(every|all|each)\b/.test(noRobots);
    out.every = /\b(every|all|each)\b/.test(noRobots);
  }

  // intent
  const has = (re) => re.test(t);
  if (has(/^ (help|what can you do|commands|how does this work|\?) $/) || has(/^ (hi|hello|hey) $/)) out.intent = 'help';
  else if (has(/\b(status|report in|what are (you|the robots|they|robots|everyone) doing|where (are|is) (the )?(robots?|everyone|everybody|you)\b|whos (busy|idle|free))/) || (out.robots.length && has(/^ (where is|where s|status of|what is .* doing) $/))) out.intent = 'status';
  else if (MANIPULATE.test(t) && !has(/\b(go|drive|send|navigate|head|visit|find)\b/)) out.intent = 'unsupported';
  else if (has(/\b(return|go back|come back|head back|back to (the )?(start|base|home|spawn)|go home|return to base|park|to your start)\b/) && !(q && q.cat === 'charging station' && !has(/\bstart\b/))) out.intent = 'return';
  else if (has(/\b(patrol|tour|sweep)\b/) && !q) { out.intent = 'explore'; out.force = true; }
  else if (has(/\b(explore|survey|map|scan|search|look around|check out)\b/) && (!q || has(/\b(explore|survey|map) (the |every |all )/)) && (rooms.length || has(/\b(building|everything|everywhere|all rooms|every room|the rest|whole|house|floor|area|unexplored|remaining|new rooms)\b/) || !q)) out.intent = 'explore';
  else if (q && has(/\b(how many|count|number of|tally)\b/)) out.intent = 'count';
  else if (q && has(/\b(meet|gather|rendezvous|assemble|regroup|converge|join (me|us)?|congregate)\b/)) out.intent = 'meet';
  else if (q && has(/\b(visit|check|inspect|tour|patrol|stop by|look at|go to|go round|go around|clean)\b/) && out.every) out.intent = 'visit_all';
  else if (out.robots.length && has(/\bask\b/)) out.intent = 'ask';
  else if (q && has(/\b(list|inventory|catalog|enumerate)\b/)) out.intent = 'list';
  else if (q && has(/^ (where are|which rooms?|what rooms?|are there|do we have|how many)\b/)) out.intent = out.plural || has(/^ (are there|which rooms)/) ? 'list' : 'answer';
  else if (has(/^ (where|what|which|is there|is the|do we|does|do you|have you|has anyone|has any|did anyone|can you see|any|who|tell me|show me|whats|is anything)\b/) || has(/\?$/)) out.intent = rooms.length && !q ? 'room_contents' : 'answer';
  else if (q && out.everyone && has(/\b(go|drive|head|come|move|send|get|navigate|run)\b/) && !out.plural) out.intent = 'meet';
  else if (q && out.plural && has(/\b(go|drive|head|send|visit|navigate|check|inspect)\b/)) out.intent = 'visit_all';
  else if (q) out.intent = 'go_to';
  else if (out.room && has(/\b(go|drive|head|send|move|navigate|come|get|meet|gather|be)\b/)) out.intent = out.everyone || has(/\b(meet|gather|assemble)\b/) ? 'meet' : 'go_room';
  else if (out.room) out.intent = 'room_contents';
  else if (has(/\b(merge|exchange|share|sync)\b/)) out.intent = 'sync';
  else out.intent = 'unknown';
  if (out.intent === 'go_room' && out.robotRoom && !out.room) out.intent = 'unknown';
  if (out.intent === 'meet' && out.robots.length === 1) out.intent = q ? 'go_to' : 'go_room';
  return out;
}

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['go_to', 'go_room', 'meet', 'visit_all', 'list', 'count', 'answer', 'room_contents', 'explore', 'return', 'status', 'unsupported'] },
    target: { type: 'string' },
    room: { type: 'string' },
    robots: { type: 'array', items: { type: 'integer' } },
    count: { type: 'integer' },
  },
  required: ['intent', 'target', 'room'],
};

const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const plural = (w, n) => (n === 1 ? w : /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`);
const listNames = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const FAIR = 0.15, FAIR_CAP = 3;   // metres of extra cost per metre recently driven, capped

export class Dispatcher {
  constructor(team, ui) { this.T = team; this.ui = ui; this.load = team.robots.map(() => 0); this.cache = new Map(); }
  note(text, extra = {}) { this.ui.log({ kind: 'dispatch', text, ...extra }); }
  name(r) { return this.T.robots[r].name; }

  // -------- interpretation: rules first, the in-browser LLM refines when loaded
  async interpret(text) {
    const T = this.T, base = parseTask(T.scene, T.n, text);
    // the rules are certain about these; a named robot with an open request goes to its own agent
    if (!this.ui.llm?.ready || ['help', 'status', 'ask', 'unsupported', 'return', 'sync'].includes(base.intent)) return base;
    if (base.robots.length === 1 && base.intent === 'unknown') return base;
    try {
      const out = await this.ui.llm.json([
        { role: 'system', content: `Turn a task for ${T.n} indoor robots (R1-R${T.n}) into JSON. Rooms: ${T.scene.rooms.map((r) => r.name).join(', ')}.
intent: go_to = one robot drives to an object; go_room = drive to a room; meet = several/all robots gather at an object or room; visit_all = visit every instance of a kind; list = report where every instance is; count = how many; answer = question about one object; room_contents = what is in a room; explore = map a room or the whole building; return = go back to start; status = what robots are doing; unsupported = needs arms or anything else robots cannot do.
target = object words only (color + kind, e.g. "red toolbox"), "" if none. room = a room name from the list or "". robots = robot numbers named in the task, [] if none. count = how many robots if a number is given, else 0.` },
        { role: 'user', content: text },
      ], INTENT_SCHEMA, 90);
      const room = T.scene.rooms.find((r) => r.name.toLowerCase() === String(out.room || '').toLowerCase())?.name;
      const q = out.target ? embedText(normalizeText(out.target)) : null;
      const it = { ...base };
      if (INTENT_SCHEMA.properties.intent.enum.includes(out.intent)) it.intent = out.intent;
      if (q?.cat && !base.target) it.target = { col: q.col, cat: q.cat, text: `${q.col || ''} ${q.cat}`.trim() };
      if (room && !base.room) { it.room = room; if (it.target) it.objRoom = room; }
      if (!base.robots.length && Array.isArray(out.robots)) it.robots = out.robots.map((x) => x - 1).filter((x) => x >= 0 && x < T.n);
      if (!base.count && out.count > 0) it.count = out.count;
      // keep the rules' answer when the model picks an intent that cannot run with what it found
      if (['go_to', 'meet', 'visit_all', 'list', 'count', 'answer'].includes(it.intent) && !it.target && !(it.intent === 'meet' && it.room)) it.intent = base.intent;
      if (it.intent === 'go_room' && !it.room) it.intent = base.intent;
      return it;
    } catch { return base; }
  }

  // -------- shared map
  async syncMap() {
    const T = this.T;
    if (!T.shared) return;
    if (!T.M || !T.mergedFresh()) {
      const before = T.M?.joined.length || 0;
      const ex = T.exchange();
      const out = ex.robots_not_overlapping.length ? ` ${listNames(ex.robots_not_overlapping)} ${ex.robots_not_overlapping.length > 1 ? 'are' : 'is'} not linked yet (no overlap or sighting).` : '';
      if (ex.robots_merged.length !== before || !this._synced) this.note(`Merged maps from ${ex.robots_merged.length}/${T.n} robots (${ex.verified_matches} shared objects${ex.robot_encounters_used ? `, ${ex.robot_encounters_used} robot sightings` : ''}).${out}`, { tool: 'exchange_maps', output: ex });
      this._synced = true;
    }
    if (T.M && !T.optimized && T.M.disInit > 0.12) {
      const op = await T.optimize(true);
      // say it the first time and whenever it matters; routine re-optimizations stay quiet
      if (!this._optimized || op.map_disagreement_before_m - op.map_disagreement_after_m >= 0.15) this.note(`Optimized the team map: disagreement ${op.map_disagreement_before_m} → ${op.map_disagreement_after_m} m.`, { tool: 'optimize_team_map', output: op });
      this._optimized = true;
    }
    this.cache.clear();
  }
  merged(r) { return !!(this.T.shared && this.T.M && this.T.M.joined.includes(r)); }
  allMerged() { return this.T.robots.every((_, r) => this.merged(r)); }

  // Everything any robot knows that matches the target, grouped per physical
  // object. refs[r] = the id robot r can navigate to (only robots that know it).
  resolve(target, room = null) {
    const T = this.T, groups = [];
    if (!target) return groups;
    for (let r = 0; r < T.n; r++) {
      for (const o of T.objectsFor(r)) {
        const e = embedText(o.label);
        if (!e || (target.cat && e.cat !== target.cat)) continue;
        const oroom = this.roomNear(o);
        if (room && oroom !== room) continue;
        let g = groups.find((x) => x.cat === e.cat && Math.hypot(x.x - o.x, x.y - o.y) < 1.0);
        if (!g) { g = { label: o.label, cat: e.cat, col: e.col, x: o.x, y: o.y, room: oroom, refs: {}, seenBy: new Set() }; groups.push(g); }
        if (!(r in g.refs) || /^T/.test(o.id)) g.refs[r] = o.id;
        o.seen_by.forEach((s) => g.seenBy.add(s));
      }
    }
    const exact = groups.filter((g) => !target.col || g.col === target.col);
    if (exact.length || !target.col) return exact;
    // colours are estimated from noisy views: fall back to the same kind of object
    groups.forEach((g) => (g.approx = true));
    return groups;
  }
  idle() { return this.T.robots.map((_, r) => r).filter((r) => !this.T.jobs[r] && !this.ui.agents[r].busy); }
  pathCost(r, p) {
    const from = this.T.pose[r], key = `${from.x.toFixed(1)},${from.y.toFixed(1)}>${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    if (!this.cache.has(key)) { const pl = this.T.nav.plan(from, p); this.cache.set(key, pl ? pl.length : Infinity); }
    return this.cache.get(key);
  }
  between(a, b) {
    const key = `${a.x.toFixed(1)},${a.y.toFixed(1)}>${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    if (!this.cache.has(key)) { const pl = this.T.nav.plan(a, b); this.cache.set(key, pl ? pl.length : Infinity); }
    return this.cache.get(key);
  }
  roomCenter(name) {
    const q = this.T.scene.rooms.find((x) => x.name === name);
    const pts = this.T.scene.coverage[name] || [], c = { x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 };
    return this.T.nav.isFree(c) || !pts.length ? c : pts.slice().sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
  }
  roomOf(r) { return this.roomNear(this.T.pose[r]); }
  // room containing a point; points on a wall line count for the nearest room
  roomNear(p) {
    const n = roomAt(this.T.scene, p.x, p.y);
    if (n !== 'outside') return n;
    const d = (q) => Math.hypot(Math.max(q.x0 - p.x, 0, p.x - q.x1), Math.max(q.y0 - p.y, 0, p.y - q.y1));
    return this.T.scene.rooms.slice().sort((a, b) => d(a) - d(b))[0].name;
  }
  unexplored() { const T = this.T; return T.scene.rooms.map((q) => q.name).filter((n) => !T.robots.some((_, i) => T.sims[i].explored.has(n))); }
  fairCost(r, d) { return d + Math.min(FAIR_CAP, FAIR * this.load[r]); }
  instr(g, r) { return `Go to the ${g.label} (${g.refs[r]}) at (${fmt(g.x)}, ${fmt(g.y)}).`; }

  // candidate robots for a task: explicit robots, robots in a named room, else idle ones
  pool(it, idle) {
    const T = this.T;
    if (it.robots.length) return it.robots.filter((r) => r < T.n);
    if (it.robotRoom) return idle.filter((r) => this.roomOf(r) === it.robotRoom);
    return idle;
  }

  // -------- main entry
  async handle(text) {
    const T = this.T, ctx = { t0: T.time, d0: T.sims.reduce((a, s) => a + s.distance, 0) };
    this.load = this.load.map((x) => x * 0.5);   // older work matters less
    this.ui.log({ kind: 'task', text });
    try {
      return await this.dispatch(text, ctx);
    } catch (e) {
      return this.done(`Something went wrong: ${e.message}`, ctx);
    }
  }

  async dispatch(text, ctx) {
    const T = this.T;
    const it = await this.interpret(text);
    const bad = it.robots.filter((r) => r >= T.n);
    if (bad.length) return this.done(`There is no Robot ${bad[0] + 1}: this run has ${T.n} robot${T.n > 1 ? 's' : ''} (R1–R${T.n}).`, ctx);

    if (it.intent === 'help' || (it.intent === 'unknown' && it.robots.length !== 1)) return this.done(this.helpText(it.intent === 'unknown'), ctx);
    if (it.intent === 'unsupported') return this.done(`These robots can drive, explore and map, but have no arms.${it.target ? ` Try "Send a robot to the ${it.target.text}" instead.` : ' Try sending one to an object or room.'}`, ctx);
    if (it.intent === 'status') return this.done(this.statusText(it.robots), ctx);

    // a single named robot with a request the dispatcher can't structure: let its agent handle it
    const askOne = it.intent === 'ask' && text.match(/^\s*(?:please\s+)?ask\s+(?:robot\s*|r)(\d+)\s*(?:if|whether|about|what|where|to)?\b\s*(.*)$/i);
    if (askOne) {
      const r = +askOne[1] - 1;
      this.note(`Asking ${this.name(r)}.`, { r });
      return this.done(`${this.name(r)}: ${await this.run(r, /\?$/.test(text) || /^\s*ask\s+\S+\s*\d*\s*(what|where|which|how|is|are|do|did|have|has)\b/i.test(text) ? text.replace(/^\s*(please\s+)?ask\s+(robot\s*|r)\d+\s*/i, '') : text)}`, ctx);
    }
    if (it.intent === 'ask' || (it.robots.length === 1 && it.intent === 'sync')) return this.done(await this.run(it.robots[0], text.replace(/^\s*(robot\s*\d+|r\d+)\s*[,:]?\s*/i, '')), ctx);
    if (it.robots.length === 1 && !['go_to', 'go_room', 'explore', 'return', 'answer', 'list', 'count', 'room_contents', 'visit_all'].includes(it.intent)) {
      const r = it.robots[0];
      if (this.ui.agents[r].busy || T.jobs[r]) return this.done(`${this.name(r)} is busy right now.`, ctx);
      this.note(`Passing the request to ${this.name(r)} as asked.`, { r });
      return this.done(await this.run(r, text.replace(/^\s*(robot\s*\d+|r\d+)\s*[,:]?\s*/i, '')), ctx);
    }
    if (it.intent === 'sync') { await this.syncMap(); return this.done(T.M ? `Team map: ${T.M.joined.length}/${T.n} robots merged.` : 'Map sharing is off in this run.', ctx); }

    await this.syncMap();
    const idle = this.idle();
    const needsRobot = ['go_to', 'go_room', 'meet', 'visit_all', 'explore', 'return'].includes(it.intent);
    if (needsRobot && !idle.length) return this.done('All robots are busy right now. Try again when one is free.', ctx);
    if (it.robots.length && needsRobot) {
      const busy = it.robots.filter((r) => !idle.includes(r));
      if (busy.length === it.robots.length) return this.done(`${listNames(busy.map((r) => this.name(r)))} ${busy.length > 1 ? 'are' : 'is'} busy (${T.jobs[busy[0]]?.label || 'working'}). Try again shortly or leave the robot unnamed.`, ctx);
      if (busy.length) this.note(`${listNames(busy.map((r) => this.name(r)))} ${busy.length > 1 ? 'are' : 'is'} busy; continuing with the others.`);
    }
    if (it.robotRoom && needsRobot && !this.pool(it, idle).length) return this.done(`No idle robot is in the ${it.robotRoom} right now (${this.statusText([], true)}).`, ctx);

    switch (it.intent) {
      case 'return': return this.doReturn(it, idle, ctx);
      case 'explore': return this.doExplore(it, idle, ctx);
      case 'go_room': return this.doGoRoom(it, idle, ctx);
      case 'room_contents': return this.doRoomContents(it, ctx);
      case 'answer': case 'list': case 'count': return this.doReport(it, idle, ctx);
      case 'meet': return it.target ? this.doMeet(it, idle, ctx) : this.doMeetRoom(it, idle, ctx);
      case 'visit_all': return this.doVisitAll(it, idle, ctx);
      default: return this.doGoTo(it, idle, ctx);
    }
  }

  helpText(unknown) {
    const T = this.T, room = T.scene.rooms[1]?.name || T.scene.rooms[0].name;
    return `${unknown ? "I didn't catch a task there. " : ''}Try: "Send a robot to the plant", "Robot 2, go to the ${room}", "Check every chair", "Everyone meet at the ${T.scene.objects.find((o) => o.cat !== 'door' && o.cat !== 'rack')?.cat || 'door'}", "How many chairs are there?", "Explore the ${room}", "Explore the building", "Where are the robots?", "Everyone return to start".`;
  }
  statusText(robots = [], short = false) {
    const T = this.T, list = (robots.length ? robots : T.robots.map((_, r) => r));
    return list.map((r) => `${T.robots[r].id} ${this.roomOf(r)}${T.jobs[r] ? ` (${T.jobs[r].label})` : this.ui.agents[r].busy ? ' (busy)' : short ? '' : ' (idle)'}`).join(', ') + (short ? '' : '.');
  }

  // -------- explore / patrol: rooms split across idle robots, nearest first
  async doExplore(it, idle, ctx) {
    const T = this.T;
    let rooms = it.rooms.length ? it.rooms.filter((n) => n !== it.robotRoom || it.rooms.length === 1) : it.force ? T.scene.rooms.map((q) => q.name) : this.unexplored();
    if (!rooms.length) return this.done(`Every room has been explored already. Say "Patrol the building" to sweep again, or "Explore the ${T.scene.rooms[0].name}" for one room.`, ctx);
    let robots = this.pool(it, idle).filter((r) => idle.includes(r));
    if (it.count) robots = this.nearestTo(robots, this.roomCenter(rooms[0])).slice(0, it.count);
    if (rooms.length === 1 && !it.robots.length) robots = this.nearestTo(robots, this.roomCenter(rooms[0])).slice(0, 1);
    if (!robots.length) return this.done('No idle robot can take this right now.', ctx);
    if (rooms.length === 1) {
      const r = robots[0], d = this.pathCost(r, this.roomCenter(rooms[0]));
      this.note(`${this.name(r)} explores the ${rooms[0]}${it.robots.length ? ' as asked' : `: ${this.roomOf(r) === rooms[0] ? 'already there' : `${fmt(d)} m away, closest of ${idle.length} idle`}`}.`, { r });
    } else this.note(`Exploring ${rooms.length} rooms with ${robots.length} robot${robots.length > 1 ? 's' : ''}, each taking the nearest room left.`, { robots });
    const res = await this.surveyRooms(rooms, robots, () => false, rooms.length > 1);
    await this.syncMap();
    const objs = res.reduce((a, x) => a + (x.new_objects || 0), 0);
    return this.done(`Explored ${listNames(res.map((x) => x.room))}: ${objs} new object${objs === 1 ? '' : 's'} mapped.`, ctx);
  }

  async surveyRooms(rooms, robots, stop = () => false, announce = true) {
    const todo = rooms.slice(), results = [], first = {};
    // first rooms: global greedy matching (closest robot-room pair first), so
    // robot order doesn't matter; afterwards each robot takes the nearest room left
    const free = robots.slice();
    while (free.length && todo.length) {
      let best = null;
      for (const r of free) for (const room of todo) { const d = this.pathCost(r, this.roomCenter(room)); if (!best || d < best.d) best = { r, room, d }; }
      first[best.r] = best.room; free.splice(free.indexOf(best.r), 1); todo.splice(todo.indexOf(best.room), 1);
    }
    await Promise.all(robots.map(async (r) => {
      while ((first[r] || todo.length) && !stop()) {
        let room = first[r]; delete first[r];
        if (!room) { todo.sort((a, b) => this.pathCost(r, this.roomCenter(a)) - this.pathCost(r, this.roomCenter(b))); room = todo.shift(); }
        if (announce) this.note(`${this.name(r)} → ${room} (${fmt(this.pathCost(r, this.roomCenter(room)))} m).`, { r });
        const reply = await this.run(r, `Explore the ${room}.`);
        const m = String(reply).match(/(\d+) new objects?/);
        results.push({ room, r, new_objects: m ? +m[1] : 0 });
      }
    }));
    return results;
  }
  nearestTo(robots, p) { return robots.slice().sort((a, b) => this.pathCost(a, p) - this.pathCost(b, p)); }

  // -------- find unknown objects: search rooms nobody explored, stop when found
  async findOrSearch(it, idle) {
    let groups = this.resolve(it.target, it.objRoom);
    if (groups.length && !groups.every((g) => g.approx)) return groups;
    const rooms = it.objRoom ? this.unexplored().filter((n) => n === it.objRoom) : this.unexplored();
    const free = idle.filter((r) => !this.T.jobs[r] && !this.ui.agents[r].busy);
    if (!rooms.length || !free.length) return groups;
    const what = `${an(it.target.text)} ${it.target.text}`;
    this.note(`Nobody has seen ${what}${it.objRoom ? ` in the ${it.objRoom}` : ''} yet; searching ${rooms.length > 1 ? `${rooms.length} unexplored rooms in parallel` : `the ${rooms[0]}`}.`);
    await this.surveyRooms(rooms, rooms.length === 1 ? this.nearestTo(free, this.roomCenter(rooms[0])).slice(0, 1) : free, () => this.resolve(it.target, it.objRoom).some((g) => !g.approx));
    await this.syncMap();
    groups = this.resolve(it.target, it.objRoom);
    return groups;
  }
  missText(it) {
    const left = this.unexplored(), what = `${an(it.target.text)} ${it.target.text}`;
    return left.length ? `Nobody has seen ${what}${it.objRoom ? ` in the ${it.objRoom}` : ''} yet. Unexplored: ${listNames(left)}.` : `No ${it.target.text}${it.objRoom ? ` in the ${it.objRoom}` : ''}: the team has explored every room and nobody saw one.`;
  }
  approxNote(it, groups) {
    if (groups[0]?.approx) this.note(`No ${it.target.text} in the maps; the closest match is ${groups.map((g) => g.label).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(' / ')} (colours are estimated from camera views).`);
  }

  // -------- go_to: best (robot, instance) pair by real path + a modest fairness term
  async doGoTo(it, idle, ctx) {
    const T = this.T;
    if (/\b(bring|fetch|get me|carry|deliver)\b/i.test(it.raw)) this.note("Robots can't carry things, so one will drive to it instead.");
    const groups = await this.findOrSearch(it, idle);
    if (!groups.length) return this.done(this.missText(it), ctx);
    this.approxNote(it, groups);
    const free = this.idle(), pool = this.pool(it, free).filter((r) => free.includes(r));
    const want = Math.max(1, Math.min(it.count || 1, pool.length));
    const opts = [];
    for (const r of pool) for (const g of groups) if (r in g.refs) { const d = this.pathCost(r, g); if (d < Infinity) opts.push({ r, g, d, c: this.fairCost(r, d) }); }
    if (!opts.length) return this.goViaTeammate(it, groups, pool, ctx);
    opts.sort((a, b) => a.c - b.c);
    const picks = [];
    for (const o of opts) if (!picks.some((p) => p.r === o.r) && picks.length < want) picks.push(o);
    const g = picks[0].g, rb = picks.map((p) => p.r);
    this.note(this.pickReason(picks, opts, pool, it, groups), { r: rb[0], robots: rb, pick: picks.map((p) => ({ r: p.r, d: +p.d.toFixed(1) })) });
    const replies = await Promise.all(picks.map((p) => this.run(p.r, this.instr(p.g, p.r))));
    if (picks.length === 1) return this.done(replies[0], ctx);
    const ok = replies.filter((x) => /^Reached/.test(x)).length;
    return this.done(`${ok}/${picks.length} robots reached the ${g.label}.`, ctx);
  }

  pickReason(picks, opts, pool, it, groups) {
    const T = this.T, p = picks[0], g = p.g, rb = this.name(p.r);
    const where = `${g.label} ${g.refs[p.r]} is in the ${g.room}`;
    if (picks.length > 1) return `${where}. Sending the ${picks.length} closest robots: ${picks.map((q) => `${T.robots[q.r].id} ${fmt(q.d)} m`).join(', ')}.`;
    if (it.robots.length) return `${where}. ${rb} goes as asked (${fmt(p.d)} m).`;
    const knowers = new Set(opts.map((o) => o.r));
    const blind = pool.filter((r) => !knowers.has(r));
    const byDist = opts.slice().sort((a, b) => a.d - b.d), nearest = byDist[0];
    const others = byDist.filter((o) => o.r !== p.r);
    const next = others[0];
    let why;
    if (nearest.r !== p.r) why = `${fmt(p.d)} m away; ${T.robots[nearest.r].id} is ${fmt(p.d - nearest.d)} m closer but has driven ${fmt(this.load[nearest.r])} m recently, so the work is shared`;
    else if (pool.length === 1) why = `the only ${it.robotRoom ? `idle robot in the ${it.robotRoom}` : 'idle robot'} (${fmt(p.d)} m away)`;
    else if (!next) why = `${fmt(p.d)} m away`;
    else why = `${fmt(p.d)} m away, closest of ${new Set(opts.map((o) => o.r)).size} ${it.robotRoom ? `robots in the ${it.robotRoom}` : blind.length ? 'idle robots that have it in their maps' : 'idle robots'}${next ? ` (next: ${T.robots[next.r].id} at ${fmt(next.d)} m)` : ''}`;
    if (blind.length && !this.allMerged()) why += `; ${listNames(blind.map((r) => T.robots[r].id))} ${blind.length > 1 ? "don't" : "doesn't"} have it in ${blind.length > 1 ? 'their maps' : 'its map'} (maps not linked yet)`;
    if (groups.length > 1 && !it.objRoom) why += `; nearest of ${groups.length} ${plural(g.cat, groups.length)}`;
    return `${where}. Picked ${rb}: ${why}.`;
  }

  // Nobody idle knows the object (their maps aren't linked to the robot that saw
  // it): drive the nearest idle robot to that teammate, re-exchange, then go.
  async goViaTeammate(it, groups, pool, ctx) {
    const T = this.T, g = groups[0];
    const knowers = Object.keys(g.refs).map(Number);
    if (!pool.length) return this.done(`${listNames(knowers.map((r) => this.name(r)))} saw the ${g.label}, but ${knowers.length > 1 ? 'they are' : 'it is'} busy and no other idle robot has it in its map.`, ctx);
    let best = null;
    for (const r of pool) for (const k of knowers) { const d = this.between(T.pose[r], T.pose[k]); if (!best || d < best.d) best = { r, k, d }; }
    if (!best || best.d === Infinity) return this.done(`Only ${listNames(knowers.map((r) => this.name(r)))} knows where the ${g.label} is and no idle robot can reach it.`, ctx);
    this.note(`Only ${this.name(best.k)} has the ${g.label} in its map and the maps aren't linked; ${this.name(best.r)} drives to ${this.name(best.k)} (${fmt(best.d)} m) so they can link maps.`, { r: best.r });
    await this.run(best.r, `Drive to Robot ${best.k + 1}.`);
    await this.syncMap();
    const again = this.resolve(it.target, it.objRoom).find((x) => best.r in x.refs);
    if (!again) return this.done(`${this.name(best.r)} reached ${this.name(best.k)}, but their maps still don't link, so it can't navigate to the ${g.label} yet.`, ctx);
    this.note(`Maps linked: ${this.name(best.r)} now heads to ${again.label} ${again.refs[best.r]}.`, { r: best.r });
    return this.done(await this.run(best.r, this.instr(again, best.r)), ctx);
  }

  // -------- meet: everyone (or the named robots) in parallel
  async doMeet(it, idle, ctx) {
    const T = this.T;
    const groups = await this.findOrSearch(it, idle);
    if (!groups.length) return this.done(this.missText(it), ctx);
    this.approxNote(it, groups);
    const free = this.idle();
    let robots = (it.robots.length ? it.robots : it.robotRoom ? free.filter((r) => this.roomOf(r) === it.robotRoom) : free).filter((r) => free.includes(r));
    // meeting point: the instance with the lowest total path for the known robots
    const score = (g) => robots.reduce((a, r) => a + (r in g.refs ? this.pathCost(r, g) : 0), 0) - 50 * robots.filter((r) => r in g.refs).length;
    const g = groups.slice().sort((a, b) => score(a) - score(b))[0];
    if (it.count && !it.robots.length) robots = this.nearestTo(robots.filter((r) => r in g.refs), g).slice(0, it.count);
    const know = robots.filter((r) => r in g.refs), blind = robots.filter((r) => !(r in g.refs));
    if (!know.length) return this.goViaTeammate(it, [g], robots, ctx);
    const skipped = T.robots.map((_, r) => r).filter((r) => !robots.includes(r) && !it.robots.length && !it.count && !it.robotRoom);
    this.note(`${robots.length === T.n ? `All ${T.n} robots` : listNames(robots.map((r) => T.robots[r].id))} meet at ${g.label} ${g.refs[know[0]] || ''} in the ${g.room}${skipped.length ? ` (${listNames(skipped.map((r) => T.robots[r].id))} busy)` : ''}.${blind.length ? ` ${listNames(blind.map((r) => T.robots[r].id))} ${blind.length > 1 ? "aren't" : "isn't"} linked to the team map yet, so ${blind.length > 1 ? 'they follow' : 'it follows'} the nearest teammate.` : ''}`, { robots });
    const res = await Promise.all(know.map((r) => this.run(r, this.instr(g, r))));
    // unlinked robots: drive to the nearest teammate at the meeting point, then try the object once maps link
    const res2 = await Promise.all(blind.map(async (r) => {
      const mates = know.slice().sort((a, b) => this.between(T.pose[r], T.pose[a]) - this.between(T.pose[r], T.pose[b]));
      if (!mates.length) return 'could not find a teammate';
      return this.run(r, `Drive to Robot ${mates[0] + 1}.`);
    }));
    if (blind.length) await this.syncMap();
    const ok = [...res, ...res2].filter((x) => /^Reached/.test(x)).length;
    return this.done(`${ok}/${robots.length} robots reached the ${g.label} in the ${g.room}.`, ctx);
  }
  async doMeetRoom(it, idle, ctx) {
    const T = this.T, room = it.room;
    const robots = (it.robots.length ? it.robots : idle).filter((r) => idle.includes(r));
    this.note(`${robots.length === T.n ? `All ${T.n} robots` : listNames(robots.map((r) => T.robots[r].id))} meet in the ${room}.`, { robots });
    const res = await Promise.all(robots.map((r) => this.run(r, `Go to the ${room}.`)));
    return this.done(`${res.filter((x) => /^Reached|already/i.test(x)).length}/${robots.length} robots are in the ${room}.`, ctx);
  }

  async doGoRoom(it, idle, ctx) {
    const room = it.room, c = this.roomCenter(room);
    let robots = this.pool(it, idle).filter((r) => idle.includes(r));
    if (!it.robots.length) robots = this.nearestTo(robots, c).slice(0, it.count || 1);
    if (!robots.length) return this.done('No idle robot can take this right now.', ctx);
    const d = this.pathCost(robots[0], c);
    this.note(robots.length > 1 ? `Sending ${listNames(robots.map((r) => this.T.robots[r].id))} to the ${room}.`
      : `Picked ${this.name(robots[0])} for the ${room}: ${it.robots.length ? 'as asked' : `${fmt(d)} m away, closest of ${this.pool(it, idle).length} idle`}.`, { r: robots[0], robots });
    const res = await Promise.all(robots.map((r) => this.run(r, `Go to the ${room}.`)));
    return this.done(res.length === 1 ? res[0] : `${res.filter((x) => /^Reached|already/i.test(x)).length}/${res.length} robots reached the ${room}.`, ctx);
  }

  async doReturn(it, idle, ctx) {
    const T = this.T;
    const robots = (it.robots.length ? it.robots : it.robotRoom ? idle.filter((r) => this.roomOf(r) === it.robotRoom) : idle).filter((r) => idle.includes(r))
      .filter((r) => Math.hypot(T.pose[r].x - T.robots[r].start.x, T.pose[r].y - T.robots[r].start.y) > 0.5);
    if (!robots.length) return this.done('Everyone asked is already at their start position.', ctx);
    this.note(`${robots.length === T.n ? `All ${T.n} robots` : listNames(robots.map((r) => T.robots[r].id))} head back to their start positions.`, { robots });
    const res = await Promise.all(robots.map((r) => this.run(r, 'Return to your start position.')));
    return this.done(`${res.filter((x) => /^Back|^Reached/i.test(x)).length}/${robots.length} robots are back at their start.`, ctx);
  }

  // -------- visit_all: assign instances to robots by real path (greedy makespan)
  async doVisitAll(it, idle, ctx) {
    const T = this.T;
    let groups = this.resolve(it.target, it.objRoom);
    const left = it.objRoom ? this.unexplored().filter((n) => n === it.objRoom) : this.unexplored();
    if (left.length) {
      this.note(`The team hasn't seen ${listNames(left)} yet; surveying ${left.length > 1 ? 'them' : 'it'} first so no ${it.target.text} is missed.`);
      await this.surveyRooms(left, idle); await this.syncMap();
      groups = this.resolve(it.target, it.objRoom);
    }
    if (!groups.length) return this.done(this.missText(it), ctx);
    this.approxNote(it, groups);
    const free = this.pool(it, this.idle()).filter((r) => this.idle().includes(r));
    const robots = it.count ? free.slice(0, it.count) : free;
    const queues = Object.fromEntries(robots.map((r) => [r, []])), pos = Object.fromEntries(robots.map((r) => [r, { ...T.pose[r] }])), acc = Object.fromEntries(robots.map((r) => [r, 0]));
    const todo = groups.slice(), orphans = [];
    while (todo.length) {
      let best = null;
      todo.forEach((g, gi) => { for (const r of robots) if (r in g.refs) { const d = this.between(pos[r], g), c = acc[r] + d; if (!best || c < best.c) best = { r, gi, c, d }; } });
      if (!best) { orphans.push(...todo); break; }
      const g = todo.splice(best.gi, 1)[0];
      queues[best.r].push(g); acc[best.r] = best.c; pos[best.r] = { x: g.x, y: g.y };
    }
    const used = robots.filter((r) => queues[r].length);
    if (!used.length) return this.done(`The ${plural(it.target.text, 2)} are only in maps of busy or unlinked robots; try again after a map exchange.`, ctx);
    const n = groups.length - orphans.length;
    this.note(`Splitting ${n} ${plural(it.target.text, n)} across ${used.length} robot${used.length > 1 ? 's' : ''} by path length: ${used.map((r) => `${T.robots[r].id} → ${queues[r].map((g) => g.refs[r]).join(', ')}`).join('; ')}.${orphans.length ? ` ${orphans.length} more ${orphans.length > 1 ? 'are' : 'is'} only in an unlinked robot's map.` : ''}`, { robots: used });
    let ok = 0;
    await Promise.all(used.map(async (r) => { for (const g of queues[r]) if (/^Reached/.test(await this.run(r, this.instr(g, r)))) ok++; }));
    return this.done(`Visited ${ok}/${groups.length} ${plural(it.target.text, groups.length)}${it.objRoom ? ` in the ${it.objRoom}` : ''}.`, ctx);
  }

  // -------- questions: answer from the maps, surveying first when a full count needs it
  async doReport(it, idle, ctx) {
    const T = this.T;
    if (!it.target) return this.doRoomContents(it, ctx);
    let groups = this.resolve(it.target, it.objRoom);
    const left = it.objRoom ? this.unexplored().filter((n) => n === it.objRoom) : this.unexplored();
    const free = this.pool(it, idle).filter((r) => idle.includes(r));
    if ((it.intent !== 'answer' || !groups.length) && left.length && free.length) {
      this.note(`The team hasn't seen ${listNames(left)} yet; surveying ${left.length > 1 ? `them with ${Math.min(free.length, left.length)} robots` : 'it'} first.`);
      await this.surveyRooms(left, left.length === 1 ? this.nearestTo(free, this.roomCenter(left[0])).slice(0, 1) : free, it.intent === 'answer' ? () => this.resolve(it.target, it.objRoom).some((g) => !g.approx) : () => false);
      await this.syncMap();
      groups = this.resolve(it.target, it.objRoom);
    }
    if (!groups.length) return this.done(this.missText(it), ctx);
    const approx = groups[0].approx ? ` (no ${it.target.text} seen; showing ${groups[0].cat}s of any colour)` : '';
    const src = this.allMerged() || !T.shared ? (T.shared ? 'the team map' : 'the robots\' own maps') : 'the robots\' maps (not all linked yet)';
    const unexp = this.unexplored(), tail = unexp.length ? ` Not explored yet: ${listNames(unexp)}.` : '';
    const at = (g) => `${g.refs[Object.keys(g.refs)[0]]} in the ${g.room}`;
    const where = it.objRoom ? ` in the ${it.objRoom}` : '';
    if (it.intent === 'count') {
      const byRoom = {}; for (const g of groups) byRoom[g.room] = (byRoom[g.room] || 0) + 1;
      return this.done(`${groups.length} ${plural(it.target.text, groups.length)}${where}${approx}: ${Object.entries(byRoom).map(([k, v]) => `${v} in the ${k}`).join(', ')}. Source: ${src}.${tail}`, ctx);
    }
    if (it.intent === 'answer' && groups.length === 1) {
      const g = groups[0];
      return this.done(`The ${g.label} (${at(g)}) is at (${fmt(g.x)}, ${fmt(g.y)}), seen by ${[...g.seenBy].join('+')}.${approx}`, ctx);
    }
    return this.done(`${groups.length} ${plural(it.target.text, groups.length)}${where}${approx} in ${src}: ${groups.map(at).join('; ')}.${tail}`, ctx);
  }
  doRoomContents(it, ctx) {
    const T = this.T, room = it.room;
    if (!room) return this.done(this.helpText(true), ctx);
    const seen = new Map();
    for (let r = 0; r < T.n; r++) for (const o of T.objectsFor(r)) if (this.roomNear(o) === room && !/door/.test(o.label)) {
      const k = [...seen.keys()].find((x) => x.label === o.label && Math.hypot(x.x - o.x, x.y - o.y) < 1); if (!k) seen.set(o, 1);
    }
    const counts = {}; for (const o of seen.keys()) counts[o.label] = (counts[o.label] || 0) + 1;
    const items = Object.entries(counts).map(([l, c]) => (c > 1 ? `${c} ${plural(l, c)}` : `${an(l)} ${l}`));
    if (!items.length) return this.done(T.robots.some((_, r) => T.sims[r].explored.has(room)) ? `The ${room} looks empty in the maps.` : `Nobody has explored the ${room} yet. Say "Explore the ${room}".`, ctx);
    return this.done(`In the ${room}: ${listNames(items)}.`, ctx);
  }

  // -------- running work on agents
  async run(r, instruction) {
    const agent = this.ui.agents[r], d0 = this.T.sims[r].distance;
    agent.busy = true;
    try {
      return await agent.handle(`[from Dispatcher] ${instruction}`, { depth: 0, from: 'dispatcher' });
    } catch (e) {
      return `Error: ${e.message}`;
    } finally {
      agent.busy = false;
      this.load[r] += this.T.sims[r].distance - d0;
      this.cache.clear();   // poses changed
    }
  }

  done(text, ctx) {
    const T = this.T;
    const took = Math.round(T.time - ctx.t0), drove = T.sims.reduce((a, s) => a + s.distance, 0) - ctx.d0;
    this.ui.log({ kind: 'result', text, meta: took || drove > 0.1 ? `${took} s · ${fmt(drove)} m driven` : '' });
    return text;
  }
}
