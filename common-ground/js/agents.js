// One agent per robot. Each agent keeps its own short memory, gets the team
// state (robots, rooms, the map it knows) in every turn, and decides which
// tools to use. The model is a free open LLM running in the browser (WebLLM);
// without WebGPU an offline rule-based planner drives the same tools.
import { roomAt } from './scenes.js';
import { embedText } from './embed.js';
import { fmt } from './engine.js';

const TOOL_TEXT = `Tools (choose exactly one "action" per reply):
- explore_room: drive a coverage loop of a room with 360-degree scans, adding objects to your map. Needs "room".
- exchange_maps: share object maps with all robots (about 1 KB per object); objects are matched across robots and verified, robots that saw each other are linked, and everyone gets the merged team map. Repeat after robots discover new things.
- optimize_team_map: distributed pose-graph optimization across robots; fixes drift so shared objects line up. Use after exchange_maps.
- search_map: find objects by words in the map you know. Needs "query" (e.g. "red toolbox").
- ask_robot: message another robot's agent and get its reply (it can also act). Needs "robot" (e.g. "R2") and "message".
- navigate_to: drive yourself to an object. Needs "object_id" exactly as listed (e.g. "T12" or "R1.7").
- reply: final answer to whoever asked you. Needs "message".`;

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['explore_room', 'exchange_maps', 'optimize_team_map', 'search_map', 'ask_robot', 'navigate_to', 'reply'] },
    room: { type: 'string' }, query: { type: 'string' }, robot: { type: 'string' }, message: { type: 'string' }, object_id: { type: 'string' },
  },
  required: ['thought', 'action'],
};

export class RobotAgent {
  constructor(team, r, ui) { this.T = team; this.r = r; this.ui = ui; this.history = []; this.busy = false; }
  get robot() { return this.T.robots[this.r]; }

  systemPrompt() {
    const T = this.T, me = this.robot;
    return `You are the onboard agent of ${me.name} (${me.id}), one of ${T.n} wheeled robots in a ${T.scene.name.toLowerCase()} (${T.scene.w} m x ${T.scene.h} m). Rooms: ${T.scene.rooms.map((q) => q.name).join(', ')}.
Every robot builds an object map with object-based SLAM. ${T.shared ? 'Robots can share maps (exchange_maps) to get one team map.' : 'Map sharing is DISABLED: you only know what you saw yourself.'}
Each turn has <team_state> with robots, rooms each robot explored, map status and the objects you know (id | label | position | room | seen by).
${TOOL_TEXT}
Think like a field robot that wants to finish fast: use what the team already knows before driving around. If you do not know something, check whether exchanging maps would give it to you before exploring. Explore only rooms nobody has explored. Optimize once after a merge when map disagreement is above 0.15 m, before navigating. Ask another robot only when the request depends on what it knows or it should act. Never repeat an identical action.
Messages starting with [from Robot X] come from another robot's agent: answer from your own knowledge, or act if asked. Messages starting with [from Dispatcher] are assignments from the team dispatcher: carry them out (an object id in the message can be used directly with navigate_to).
Reply ONLY with a JSON object {"thought": "...", "action": "...", ...arguments}. Final replies: 1-3 sentences with object ids and the measured outcome.`;
  }

  teamState() {
    const T = this.T, r = this.r;
    const me = T.pose[r];
    const robots = T.robots.map((rb, i) => {
      const p = T.pose[i], job = T.jobs[i];
      return `- ${rb.id}${i === r ? ' (you)' : ''}: in ${roomAt(T.scene, p.x, p.y)} (${fmt(p.x)}, ${fmt(p.y)}), ${job ? job.label : 'idle'}; explored: ${[...T.sims[i].explored].join(', ') || 'nothing yet'}`;
    }).join('\n');
    let objs = T.objectsFor(r).map((o) => ({ ...o, d: Math.hypot(o.x - me.x, o.y - me.y) })).sort((a, b) => a.d - b.d);
    const total = objs.length; objs = objs.slice(0, 45);
    const mapLine = T.shared
      ? (T.M ? `team map: ${T.M.joined.length}/${T.n} robots merged${T.mergedFresh() ? '' : ' (new observations since last exchange)'}, disagreement ${(T.optimized ? T.solverStats.map_disagreement_after_m : T.M.disInit).toFixed(2)} m${T.optimized ? ', optimized' : ', not optimized'}` : 'team map: not merged yet (call exchange_maps)')
      : 'map sharing disabled';
    return `<team_state>
${mapLine}
robots:
${robots}
objects you know (${total}${total > objs.length ? `, nearest ${objs.length} shown` : ''}):
${objs.map((o) => `${o.id} | ${o.label} | (${fmt(o.x)}, ${fmt(o.y)}) | ${o.room} | ${o.seen_by.join('+')}`).join('\n') || '(none)'}
</team_state>`;
  }

  async runTool(name, input, depth) {
    const T = this.T, r = this.r;
    try {
      if (name === 'explore_room') {
        const room = T.scene.rooms.find((q) => q.name.toLowerCase() === String(input.room || '').toLowerCase())?.name;
        if (!room) return { error: `Unknown room. Rooms: ${T.scene.rooms.map((q) => q.name).join(', ')}` };
        return await T.exploreRoom(r, room);
      }
      if (name === 'exchange_maps') return T.exchange();
      if (name === 'optimize_team_map') return await T.optimize(true);
      if (name === 'search_map') {
        const res = T.search(r, input.query || '');
        return { query: input.query, results: res.map((o) => ({ id: o.id, label: o.label, position: [+fmt(o.x), +fmt(o.y)], room: o.room, seen_by: o.seen_by, similarity: o.similarity })) };
      }
      if (name === 'ask_robot') {
        const t = T.robotIndex(input.robot);
        if (t < 0) return { error: `Unknown robot ${input.robot}. Robots: ${T.robots.map((q) => q.id).join(', ')}` };
        if (t === r) return { error: 'That is you.' };
        if (depth >= 1) return { error: 'Robots can only relay one level deep in this demo.' };
        const other = this.ui.agents[t];
        if (other.busy) return { error: `${T.robots[t].name} is busy with another request.` };
        other.busy = true;
        try { return { reply: await other.handle(`[from ${this.robot.name}] ${input.message}`, { depth: depth + 1, from: r }) }; } finally { other.busy = false; }
      }
      if (name === 'navigate_to') {
        const o = T.objectsFor(r).find((q) => q.id === input.object_id);
        if (!o) return { error: `Unknown object id ${input.object_id}. Use ids from the team state or search_map.` };
        return await T.goTo(r, { x: o.x, y: o.y, gt: o._gt }, `${o.label} ${o.id}`);
      }
      return { error: `Unknown tool ${name}` };
    } catch (e) { return { error: e.message }; }
  }

  async handle(text, { depth = 0, from = null } = {}) {
    this.ui.log({ kind: 'user', r: this.r, text, from, depth });
    try {
      const reply = this.ui.llm.ready ? await this.llmTurn(text, depth) : await this.offlineTurn(text, depth, from);
      this.ui.log({ kind: 'reply', r: this.r, text: reply, depth });
      return reply;
    } catch (e) {
      const msg = `Error: ${e.message}`; this.ui.log({ kind: 'error', r: this.r, text: msg, depth }); return msg;
    }
  }

  async call(name, input, depth, thought) {
    this.ui.log({ kind: 'tool', r: this.r, name, input, depth, thought });
    const out = await this.runTool(name, input, depth);
    this.ui.log({ kind: 'tool-result', r: this.r, name, output: out, depth });
    return out;
  }

  // ---------- LLM agent loop (free in-browser model, schema-constrained JSON)
  async llmTurn(text, depth) {
    const llm = this.ui.llm;
    this.history = this.history.slice(-4);
    const msgs = [{ role: 'system', content: this.systemPrompt() }, ...this.history, { role: 'user', content: `${this.teamState()}\n\nRequest: ${text}` }];
    const seen = new Set();
    for (let step = 0; step < 10; step++) {
      this.ui.log({ kind: 'thinking', r: this.r, depth });
      const act = await llm.json(msgs, ACTION_SCHEMA);
      this.ui.log({ kind: 'thinking-done', r: this.r, depth });
      msgs.push({ role: 'assistant', content: JSON.stringify(act) });
      if (!act.action || act.action === 'reply') {
        const reply = (act.message || act.thought || '(no reply)').trim();
        this.history.push({ role: 'user', content: `Request: ${text}` }, { role: 'assistant', content: reply });
        return reply;
      }
      const input = { explore_room: { room: act.room }, search_map: { query: act.query || act.message || text }, ask_robot: { robot: act.robot, message: act.message || text }, navigate_to: { object_id: act.object_id } }[act.action] || {};
      const sig = act.action + JSON.stringify(input);
      const out = seen.has(sig) ? { error: 'You already did exactly this. Use that result or reply.' } : (seen.add(sig), await this.call(act.action, input, depth, act.thought));
      const refresh = ['explore_room', 'exchange_maps', 'optimize_team_map', 'navigate_to'].includes(act.action) && !out.error;
      msgs.push({ role: 'user', content: `Result of ${act.action}: ${JSON.stringify(out).slice(0, 1400)}${refresh ? `\n\nUpdated ${this.teamState()}` : ''}\nNext action?` });
    }
    return 'I stopped after 10 steps without finishing.';
  }

  // ---------- Offline planner: rule-based use of the same tools
  async offlineTurn(text, depth, from) {
    const T = this.T, r = this.r, t = text.toLowerCase().replace(/^\[from (robot \d+|dispatcher)\]\s*/, '');
    const idMatch = text.match(/\b(T\d+|R\d+\.\d+)\b/);
    if (idMatch && /\b(go|drive|navigate|visit)\b/.test(t)) {
      const nav = await this.call('navigate_to', { object_id: idMatch[1] }, depth);
      if (nav.error) return nav.error;
      return `Reached ${idMatch[1]} after ${nav.driven_m} m (${nav.distance_to_real_object_m} m from the object).`;
    }
    const call = (n, i = {}) => this.call(n, i, depth);
    const q = embedText(t);
    const roomIn = T.scene.rooms.find((x) => t.includes(x.name.toLowerCase()))?.name;
    const robotIn = (t.match(/\brobot\s*(\d+)|\br(\d+)\b/) || []).slice(1).find(Boolean);
    const ensureTeamMap = async () => {
      if (!T.shared) return;
      if (!T.M || !T.mergedFresh()) await call('exchange_maps');
      if (T.M && !T.optimized && T.M.disInit > 0.15) await call('optimize_team_map');
    };
    const findKnown = () => (q ? T.search(r, `${q.col || ''} ${q.cat || ''}`) .filter((o) => { const e = embedText(o.label); return e && (!q.cat || e.cat === q.cat) && (!q.col || e.col === q.col); }) : []);
    const exploreFor = async (found) => {
      while (!found()) {
        const todo = T.scene.rooms.map((x) => x.name).filter((n) => !T.robots.some((_, i) => (T.shared || i === r) && T.sims[i].explored.has(n)));
        if (!todo.length) return false;
        const p = T.pose[r]; const c = (n) => { const x = T.scene.rooms.find((y) => y.name === n); return Math.hypot((x.x0 + x.x1) / 2 - p.x, (x.y0 + x.y1) / 2 - p.y); };
        todo.sort((a, b) => c(a) - c(b));
        await call('explore_room', { room: todo[0] }); if (T.shared) await call('exchange_maps');
      }
      return true;
    };
    // a question from another robot: answer from my own observations
    if (from != null && from !== 'dispatcher' && !/\b(go|drive|come|navigate|meet|explore)\b/.test(t)) {
      const mine = findKnown().filter((o) => o.seen_by.includes(this.robot.id));
      if (roomIn && !q) { const os = T.objectsFor(r).filter((o) => o.room === roomIn && o.seen_by.includes(this.robot.id)); return os.length ? `In the ${roomIn} I saw: ${os.slice(0, 8).map((o) => o.label).join(', ')}.` : `I have not seen the ${roomIn}.`; }
      if (!mine.length) return `I have not seen ${q ? `a ${q.col ? q.col + ' ' : ''}${q.cat || 'object'}` : 'that'}.`;
      return `Yes: ${mine.slice(0, 3).map((o) => `${o.label} ${o.id} in the ${o.room}`).join('; ')}.`;
    }
    if (/^explore|explore (the )?/.test(t) && roomIn) { const o = await call('explore_room', { room: roomIn }); return o.error || `Explored the ${roomIn}: ${o.new_objects} new objects (${o.objects_in_my_map} in my map).`; }
    if (/\b(merge|exchange|share)\b/.test(t) && !q) { const o = await call('exchange_maps'); return o.error || `Merged ${o.robots_merged.length}/${T.n} robots: ${o.verified_matches} object matches, ${o.robot_encounters_used} encounters.`; }
    if (/optimi[sz]/.test(t) && !q) { if (!T.M) await call('exchange_maps'); const o = await call('optimize_team_map'); return o.error || `Optimized: disagreement ${o.map_disagreement_before_m} -> ${o.map_disagreement_after_m} m.`; }
    if (/\bask\b/.test(t) && robotIn) {
      const msg = text.replace(/.*?\bask\s+(robot\s*\d+|r\d+)\s*/i, '');
      const o = await call('ask_robot', { robot: `R${robotIn}`, message: msg || 'What have you seen?' });
      return o.error || `${T.robots[robotIn - 1].name} says: ${o.reply}`;
    }
    if (!q) return `Offline planner: try "go to the red toolbox", "list every chair", "everyone meet at the sofa", "explore the ${T.scene.rooms[0].name}" or "ask Robot 2 what it saw". Load the free model for open-ended requests.`;
    if (/\b(list|every|all|how many|inventory|count)\b/.test(t) && !/\bmeet\b/.test(t)) {
      await ensureTeamMap();
      const list = findKnown();
      const seenRooms = new Set(T.robots.flatMap((_, i) => (T.shared || i === r ? [...T.sims[i].explored] : [])));
      const missing = T.scene.rooms.map((x) => x.name).filter((n) => !seenRooms.has(n));
      return `I know ${list.length} × ${q.cat || q.col}: ${list.slice(0, 10).map((o) => `${o.id} (${o.room})`).join(', ') || 'none'}.${missing.length ? ` Not yet explored by the team: ${missing.join(', ')}.` : ''}`;
    }
    const goOthers = /\b(meet|everyone|all robots|team)\b/.test(t) && depth === 0;
    await ensureTeamMap();
    if (!findKnown().length) await exploreFor(() => findKnown().length > 0);
    const target = findKnown()[0];
    if (!target) return `I could not find ${q.col ? 'a ' + q.col + ' ' : 'a '}${q.cat || 'match'}.`;
    if (!/\b(go|drive|navigate|bring|fetch|take|move|head|meet|come)\b/.test(t)) return `${target.label} ${target.id} is in the ${target.room} at (${fmt(target.x)}, ${fmt(target.y)}), seen by ${target.seen_by.join('+')}.`;
    const mine = call('navigate_to', { object_id: target.id });
    const others = goOthers ? T.robots.map((_, k) => (k === r ? null : this.runTool('ask_robot', { robot: T.robots[k].id, message: `Please go to the ${target.label} in the ${target.room}.` }, depth))).filter(Boolean) : [];
    const [nav] = await Promise.all([mine, ...others]);
    if (nav.error) return nav.error;
    return `${goOthers ? `Asked the team to meet me. ` : ''}Drove ${nav.driven_m} m to ${target.label} ${target.id} in the ${target.room}; I'm ${nav.distance_to_real_object_m} m from the real object.`;
  }
}
