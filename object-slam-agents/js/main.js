import { SceneView } from './scene.js';
import { Team } from './engine.js';
import { SCENES } from './scenes.js';
import { TASKS, priorExploration, makeTask, runTask, compare } from './tasks.js';
import { RobotAgent } from './agents.js';
import { LocalLLM, MODELS, webgpuAvailable } from './llm.js';
import { BYTES } from './team.js';

const $ = (s) => document.querySelector(s);
const view = new SceneView($('#stage'));
const llm = new LocalLLM();
const ui = { agents: [], llm, log: (e) => addLog(e) };
let team = null, speed = 6, talkTo = 0, seed = 7, worldBusy = false, dirtyLinks = true;

// ---------- world setup
$('#scene').innerHTML = SCENES.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
$('#task').innerHTML = TASKS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
$('#nrob').oninput = () => { $('#nval').textContent = $('#nrob').value; };
const setWorldStatus = (t) => { $('#world-status').innerHTML = t; };

async function buildWorld({ shared = true, prior = $('#prior').checked } = {}) {
  const def = SCENES[+$('#scene').value], n = +$('#nrob').value;
  worldBusy = true;
  setWorldStatus(`<span class="spin">Building ${def.name.toLowerCase()} with ${n} robot${n > 1 ? 's' : ''}</span>`);
  await new Promise((r) => setTimeout(r, 20));
  const T = new Team(def, n, seed, { shared });
  if (prior) await T.runHeadless(priorExploration);
  T.animated = true;
  team = T;
  T.on((ev) => {
    if (ev.type === 'navplan') view.setNavPath(ev.r, ev.points, T.robots[ev.r].color);
    if (ev.type === 'jobdone') { const r = ev.r; setTimeout(() => { if (!T.jobs[r] && T === team) view.setNavPath(r, null); }, 1500); }
    if (['merged', 'optimized', 'jobdone'].includes(ev.type)) { dirtyLinks = true; refreshMapKpis(); }
  });
  view.load(T);
  ui.agents = T.robots.map((_, r) => new RobotAgent(T, r, ui));
  $('#talk').innerHTML = T.robots.map((rb, i) => `<option value="${i}">${rb.name}</option>`).join('');
  talkTo = 0; renderChips(); refreshMapKpis(); $('#log').innerHTML = ''; showEmptyLog();
  const objs = T.robots.reduce((a, _, r) => a + Object.keys(T.local(r).lms).length, 0);
  setWorldStatus(`${def.name}: ${def.rooms.length} rooms, ${T.scene.objects.filter((o) => o.cat !== 'door').length} objects, ${n} robot${n > 1 ? 's' : ''}. ${prior ? `After their shift the robots know ${objs} object sightings, but each only in its own map.` : 'Robots start with empty maps.'}`);
  worldBusy = false; dirtyLinks = true;
  return T;
}
$('#b-apply').onclick = () => !worldBusy && buildWorld();
$('#b-seed').onclick = () => { if (worldBusy) return; seed = Math.floor(Math.random() * 1e6); buildWorld(); };
$('#scene').onchange = () => !worldBusy && buildWorld();
$('#nrob').onchange = () => !worldBusy && buildWorld();
document.querySelectorAll('#speed button').forEach((b) => (b.onclick = () => { speed = +b.dataset.s; document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelectorAll('[data-layer]').forEach((c) => (c.onchange = () => view.setLayer(c.dataset.layer, c.checked)));

// ---------- experiment
const taskBlurb = () => { $('#task-text').textContent = TASKS.find((t) => t.id === $('#task').value).blurb; };
$('#task').onchange = taskBlurb; taskBlurb();
const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`);
let lastCmp = null;
$('#b-compare').onclick = async () => {
  if (worldBusy) return;
  const btn = $('#b-compare'); btn.disabled = true; btn.classList.add('spin'); btn.textContent = 'Running both teams';
  $('#cmp').innerHTML = '';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const def = SCENES[+$('#scene').value], n = +$('#nrob').value, kind = $('#task').value;
    const c = await compare(Team, def, n, seed, kind);
    lastCmp = { c, def, n, kind, seed };
    renderCompare(c);
  } catch (e) { $('#cmp').innerHTML = `<div class="msg err">${e.message}</div>`; }
  btn.disabled = false; btn.classList.remove('spin'); btn.textContent = 'Run comparison';
};
function renderCompare(c) {
  const S = c.results.shared, I = c.results.independent;
  const rows = [
    ['Task done', S.success ? '✓' : `✗ (${Math.round(S.score * 100)}%)`, I.success ? '✓' : `✗ (${Math.round(I.score * 100)}%)`, (S.score > I.score) - (S.score < I.score)],
    ['Time to finish', `${S.time_s} s`, `${I.time_s} s`, Math.sign(I.time_s - S.time_s)],
    ['Distance driven (all)', `${S.distance_m} m`, `${I.distance_m} m`, Math.sign(I.distance_m - S.distance_m)],
    ['Data sent', kb(S.bytes), kb(I.bytes), 0],
  ];
  const speedup = S.time_s > 0 ? I.time_s / S.time_s : Infinity;
  const head = S.score >= I.score && I.time_s > S.time_s * 1.15
    ? `<div class="headline">With the shared map the team finished <b>${Number.isFinite(speedup) ? speedup.toFixed(1) + '× faster' : 'immediately'}</b>${I.distance_m > S.distance_m ? ` and drove <b>${(I.distance_m / Math.max(1, S.distance_m)).toFixed(1)}× less</b>` : ''}.</div>`
    : S.score > I.score ? `<div class="headline">Only the shared-map team completed the task.</div>`
      : `<div class="headline meh">Here sharing did not pay off: the robots already knew what they needed, and merging maps costs time and data.</div>`;
  const cell = (v, w, side) => `<td class="${w === side ? 'win' : ''}">${v}</td>`;
  $('#cmp').innerHTML = `<div class="cmp"><p class="task-text"><b>${c.task.text}</b></p>${head}
    <table><thead><tr><th></th><th>Shared map</th><th>Each alone</th></tr></thead><tbody>
    ${rows.map(([n, a, b, w]) => `<tr><td>${n}</td>${cell(a, w, 1)}${cell(b, w, -1)}</tr>`).join('')}
    </tbody></table>
    <div class="watch"><button class="btn" id="w-s">Watch shared team</button><button class="btn" id="w-i">Watch robots alone</button></div>
    <div class="runlog" id="runlog">${S.logs.map((l) => `shared  ${l}`).join('\n')}\n${I.logs.map((l) => `alone   ${l}`).join('\n')}</div></div>`;
  $('#w-s').onclick = () => watch(true); $('#w-i').onclick = () => watch(false);
}
async function watch(shared) {
  if (!lastCmp || worldBusy) return;
  $('#scene').value = SCENES.indexOf(lastCmp.def); $('#nrob').value = lastCmp.n; $('#nval').textContent = lastCmp.n; $('#task').value = lastCmp.kind; seed = lastCmp.seed;
  const T = await buildWorld({ shared, prior: true });
  const task = { ...lastCmp.c.task, target: lastCmp.c.task.target && T.scene.objects.find((o) => o.id === lastCmp.c.task.target.id) };
  const lines = [];
  const rl = () => { const el = $('#runlog'); if (el) { el.textContent = `${shared ? 'shared' : 'alone'} (live)\n` + lines.join('\n'); el.scrollTop = el.scrollHeight; } };
  setWorldStatus(`Watching: <b>${shared ? 'shared map' : 'robots alone'}</b> — ${task.text}`);
  const res = await runTask(T, task, (m) => { lines.push(m); rl(); });
  lines.push(`done: ${res.success ? 'success' : 'incomplete'} in ${res.time_s} s, ${res.distance_m} m driven`); rl();
}

// ---------- map KPIs
function refreshMapKpis() {
  const T = team; if (!T) return;
  $('#k-merged').textContent = T.shared ? (T.M ? `${T.M.joined.length}/${T.n}` : `0/${T.n}`) : 'off';
  $('#k-dis').textContent = T.M ? `${(T.optimized ? T.solverStats.map_disagreement_after_m : T.M.disInit).toFixed(2)} m` : '–';
  const ate = T.M ? T.teamAte() : T.pooledLocalAte();
  $('#k-ate').textContent = ate != null ? `${ate.toFixed(2)} m` : '–';
  const kfs = T.sims.reduce((a, s) => a + s.gt.length, 0);
  $('#bw').innerHTML = `<div>Sent so far: <b>${kb(T.bytes.objects + T.bytes.dgs)}</b> (objects ${kb(T.bytes.objects)}, optimization ${kb(T.bytes.dgs)})</div>
    <div>Sharing all keyframe images instead: <b class="big">${kb(kfs * BYTES.keyframeImage * Math.max(1, T.n - 1))}</b></div>`;
}

// ---------- model
$('#model').innerHTML = MODELS.map((m, i) => `<option value="${i}">${m.name} (${m.note.split(' · ')[0].replace('~', '')})</option>`).join('');
function renderModelNote() {
  const n = $('#model-note');
  if (!webgpuAvailable()) { n.innerHTML = 'This browser has no WebGPU, so robots use the built-in <b>offline planner</b> (same tools, simple rules). Try recent Chrome/Edge or Safari 26 for the free LLM.'; $('#b-load').disabled = true; return; }
  n.innerHTML = llm.ready ? `Agents run <b>${MODELS.find((m) => m.id === llm.modelId).name}</b> on your GPU. Free, private, nothing leaves your browser.`
    : 'Agents use the <b>offline planner</b> until you load a free open model. It runs on your GPU; the download (~1–4 GB) happens once and is cached.';
}
renderModelNote();
$('#b-load').onclick = async () => {
  const m = MODELS[+$('#model').value];
  $('#b-load').disabled = true; $('#prog').hidden = false;
  try {
    await llm.load(m.id, (r) => { $('#prog-bar').style.width = `${Math.round((r.progress || 0) * 100)}%`; $('#model-note').textContent = r.text || 'Loading…'; });
    $('#b-load').textContent = 'Loaded';
  } catch (e) { $('#model-note').textContent = `Could not load the model: ${e.message}`; $('#b-load').disabled = false; }
  $('#prog').hidden = true; if (llm.ready) renderModelNote();
};

// ---------- chat
$('#talk').onchange = () => { talkTo = +$('#talk').value; renderChips(); };
function renderChips() {
  const T = team; if (!T) return;
  const pick = (k) => { try { return makeTask(T, k); } catch { return null; } };
  const f = pick('fetch'), inv = pick('inventory');
  const other = T.n > 1 ? T.robots[(talkTo + 1) % T.n] : null;
  const unexplored = T.scene.rooms.find((q) => !T.robots.some((_, i) => T.sims[i].explored.has(q.name)))?.name || T.scene.rooms[0].name;
  const chips = [f && `Go to the ${f.query}`, inv && `List every ${inv.cat}`, f && T.n > 1 && `Everyone meet at the ${f.query}`, `Explore the ${unexplored}`,
    other && `Ask ${other.name} what it saw in the ${T.scene.rooms[(talkTo + 1) % T.scene.rooms.length].name}`].filter(Boolean);
  $('#chips').innerHTML = chips.map((c) => `<button type="button">${c}</button>`).join('');
  $('#chips').querySelectorAll('button').forEach((b) => (b.onclick = () => send(b.textContent)));
  $('#q').placeholder = `Message ${T.robots[talkTo].name}…`;
}
function showEmptyLog() { $('#log').innerHTML = '<div class="empty">Each robot has its own agent. Give one a task: it decides whether to merge maps, optimize, ask other robots, explore or drive.</div>'; }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let typingEl = null;
function addLog(e) {
  const T = team, log = $('#log'); log.querySelector('.empty')?.remove();
  const rb = T.robots[e.r], d = e.depth ? ' d1' : '';
  const who = (r) => `<span class="who" style="color:${T.robots[r].css}">${T.robots[r].name}</span>`;
  if (e.kind === 'thinking') { typingEl?.remove(); typingEl = document.createElement('div'); typingEl.className = `typing${d}`; typingEl.textContent = `${rb.name} is thinking`; log.append(typingEl); }
  else if (e.kind === 'thinking-done') { typingEl?.remove(); typingEl = null; }
  else if (e.kind === 'tool-result') {
    const pend = [...log.querySelectorAll('details.tool[data-pending]')].reverse().find((x) => x.dataset.r === String(e.r) && x.dataset.name === e.name);
    if (pend) { delete pend.dataset.pending; const o = e.output || {}; pend.querySelector('.res').textContent = o.error ? `⚠ ${o.error}` : summarize(e.name, o); pend.insertAdjacentHTML('beforeend', `<pre>${esc(JSON.stringify(o, null, 1))}</pre>`); }
  } else {
    typingEl?.remove(); typingEl = null;
    const el = document.createElement(e.kind === 'tool' ? 'details' : 'div');
    if (e.kind === 'user') {
      if (e.from != null) { el.className = `msg peer${d}`; el.innerHTML = `<span class="who" style="color:${T.robots[e.from].css}">${T.robots[e.from].name} → ${rb.name}</span><br>${esc(e.text.replace(/^\[from Robot \d+\]\s*/, ''))}`; }
      else { el.className = 'msg user'; el.innerHTML = `<span class="who">You → ${rb.name}</span><br>${esc(e.text)}`; }
    } else if (e.kind === 'reply') { el.className = `msg reply${d}`; el.innerHTML = `${who(e.r)}<br>${esc(e.text)}`; }
    else if (e.kind === 'error') { el.className = `msg err${d}`; el.textContent = e.text; }
    else if (e.kind === 'tool') {
      el.className = `tool${d}`; el.dataset.pending = '1'; el.dataset.r = e.r; el.dataset.name = e.name;
      const args = Object.keys(e.input || {}).length ? JSON.stringify(e.input) : '';
      el.innerHTML = `<summary><span class="tname" style="color:${rb.css}">${rb.id} · ${e.name}</span>(${esc(args)}) <span class="res">…</span>${e.thought ? `<br><i style="color:var(--mute)">${esc(e.thought)}</i>` : ''}</summary>`;
    }
    log.append(el);
  }
  log.scrollTop = log.scrollHeight;
}
function summarize(name, o) {
  if (name === 'explore_room') return `→ +${o.new_objects} objects (${o.took_s}s)`;
  if (name === 'exchange_maps') return `→ ${o.robots_merged?.length} robots merged, ${o.verified_matches} matches`;
  if (name === 'optimize_team_map') return `→ disagreement ${o.map_disagreement_before_m} → ${o.map_disagreement_after_m} m`;
  if (name === 'search_map') return `→ ${o.results?.length ?? 0} result(s)${o.results?.[0] ? `, top ${o.results[0].id} ${o.results[0].label}` : ''}`;
  if (name === 'navigate_to') return `→ arrived, ${o.distance_to_real_object_m} m from object`;
  if (name === 'ask_robot') return '→ replied';
  return '→ done';
}
async function send(text) {
  text = text.trim(); if (!text || !team) return;
  const agent = ui.agents[talkTo]; if (agent.busy) return;
  $('#q').value = ''; agent.busy = true;
  try { await agent.handle(text); } finally { agent.busy = false; refreshMapKpis(); }
}
$('#ask').onsubmit = (e) => { e.preventDefault(); send($('#q').value); };

// ---------- render loop
let last = performance.now(), lastSlow = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const T = team;
  if (T) {
    if (T.busy()) T.tick(dt * speed);
    T.robots.forEach((rb, r) => view.setRobotPose(r, T.pose[r]));
    if (now - lastSlow > 120) {
      lastSlow = now;
      T.robots.forEach((rb, r) => {
        const v = T.liveView(r);
        view.setTrail(r, v.poses, T.sims[r].gt, false);
        view.setLandmarks(r, v.lms, rb.color);
      });
      if (dirtyLinks || T.optJob) {
        dirtyLinks = false;
        const links = [];
        if (T.M) {
          const views = T.robots.map((_, r) => T.liveView(r));
          for (const L of T.M.links) { const a = views[L.ra].lms[L.objA], b = views[L.rb].lms[L.objB]; if (a && b) links.push({ a, b, kind: 'obj' }); }
          for (const e of T.M.encounters) { const a = views[e.ra].poses[e.ka], b = views[e.rb].poses[e.kb]; if (a && b) links.push({ a, b, kind: 'enc' }); }
        }
        view.setLinks(links.slice(0, 400));
        if (T.optJob) refreshMapKpis();
      }
    }
  }
  view.render(now);
  requestAnimationFrame(frame);
}
buildWorld().then(() => requestAnimationFrame(frame));
window.__ui = { get team() { return team; }, ui };
