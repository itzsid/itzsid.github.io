import { SceneView } from './scene.js';
import { Team } from './engine.js';
import { SCENES, roomAt } from './scenes.js';
import { TASKS, priorExploration, makeTask, runTask, compare } from './tasks.js';
import { RobotAgent } from './agents.js';
import { Dispatcher } from './dispatcher.js';
import { LocalLLM, MODELS, webgpuAvailable } from './llm.js';

const $ = (s) => document.querySelector(s);
const view = new SceneView($('#stage'));
const llm = new LocalLLM();
const ui = { agents: [], llm, log: (e) => addLog(e) };
let team = null, speed = 6, seed = 7, sceneIdx = 0, taskKind = 'fetch';
let worldBusy = false, dirtyLinks = true, dispatcher = null, taskRunning = false, lastCmp = null;
const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- layout: keep the building centred in the area the dock leaves free
function applyInsets() {
  const mobile = window.innerWidth <= 860;
  view.setInsets(mobile ? { bottom: Math.round(window.innerHeight * 0.48), top: 50 } : { left: 408, top: 64 });
}
window.addEventListener('resize', applyInsets);

// ---------- drawers
const scrim = $('#scrim');
function openDrawer(id) { document.querySelectorAll('.drawer').forEach((d) => (d.hidden = d.id !== id)); scrim.hidden = false; }
function closeDrawers() { document.querySelectorAll('.drawer').forEach((d) => (d.hidden = true)); scrim.hidden = true; }
$('#open-settings').onclick = () => openDrawer('settings');
$('#open-compare').onclick = () => openDrawer('compare');
scrim.onclick = closeDrawers;
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeDrawers));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });

// ---------- settings
const SCENE_NOTES = { office: 'Lab, office, hall, kitchen, lounge', warehouse: 'Racks block the view; identical pallets', home: 'Five rooms, small objects', hospital: 'Ten look-alike patient rooms' };
function renderScenes() {
  $('#scenes').innerHTML = SCENES.map((s, i) => `<button class="card-opt ${i === sceneIdx ? 'on' : ''}" data-i="${i}"><b>${s.name}</b><small>${SCENE_NOTES[s.id] || ''}</small></button>`).join('');
  $('#scenes').querySelectorAll('button').forEach((b) => (b.onclick = () => { if (worldBusy) return; sceneIdx = +b.dataset.i; renderScenes(); buildWorld(); }));
}
renderScenes();
$('#nrob').oninput = () => { $('#nval').textContent = $('#nrob').value; };
$('#nrob').onchange = () => !worldBusy && buildWorld();
$('#prior').onchange = () => !worldBusy && buildWorld();
$('#b-apply').onclick = () => !worldBusy && buildWorld();
$('#b-seed').onclick = () => { if (worldBusy) return; seed = Math.floor(Math.random() * 1e6); buildWorld(); };
document.querySelectorAll('#speed button').forEach((b) => (b.onclick = () => { speed = +b.dataset.s; document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelectorAll('[data-layer]').forEach((c) => (c.onchange = () => view.setLayer(c.dataset.layer, c.checked)));

$('#model').innerHTML = MODELS.map((m, i) => `<option value="${i}">${m.name} · ${m.note.split(' · ')[0].replace('~', '')}</option>`).join('');
function renderModelNote() {
  const n = $('#model-note');
  if (!webgpuAvailable()) { n.textContent = 'This browser has no WebGPU, so robots use the built-in planner (same tools, simple rules). Recent Chrome, Edge or Safari can run the free model.'; $('#b-load').disabled = true; return; }
  n.textContent = llm.ready ? `Robots think with ${MODELS.find((m) => m.id === llm.modelId).name}, running on your GPU. Free and private.`
    : 'Robots use the built-in planner until you load a free open model. It runs on your GPU; the one-time download (1–4 GB) is cached.';
}
renderModelNote();
$('#b-load').onclick = async () => {
  const m = MODELS[+$('#model').value];
  $('#b-load').disabled = true; $('#prog').hidden = false;
  try {
    await llm.load(m.id, (r) => { $('#prog-bar').style.width = `${Math.round((r.progress || 0) * 100)}%`; $('#model-note').textContent = r.text || 'Loading…'; });
    $('#b-load').textContent = 'Loaded';
  } catch (e) { $('#model-note').textContent = `Could not load the model: ${e.message}`; $('#b-load').disabled = false; }
  $('#prog').hidden = true; if (llm.ready) { renderModelNote(); refreshStats(); }
};

// ---------- world
async function buildWorld({ shared = true, prior = $('#prior').checked } = {}) {
  const def = SCENES[sceneIdx], n = +$('#nrob').value;
  worldBusy = true;
  $('#world-status').innerHTML = `<span class="spin">Building the ${def.name.toLowerCase()}</span>`;
  $('#scene-pill').textContent = `${def.name} · ${n} robot${n > 1 ? 's' : ''}`;
  await new Promise((r) => setTimeout(r, 20));
  const T = new Team(def, n, seed, { shared });
  if (prior) await T.runHeadless(priorExploration);
  T.animated = true; team = T;
  T.on((ev) => {
    if (ev.type === 'navplan') view.setNavPath(ev.r, ev.points, T.robots[ev.r].color);
    if (ev.type === 'jobdone') { const r = ev.r; setTimeout(() => { if (!T.jobs[r] && T === team) view.setNavPath(r, null); }, 1500); }
    if (['merged', 'optimized', 'jobdone', 'job'].includes(ev.type)) { dirtyLinks = true; refreshStats(); renderRoster(); }
  });
  view.load(T);
  document.querySelectorAll('[data-layer]').forEach((c) => view.setLayer(c.dataset.layer, c.checked));
  applyInsets();
  ui.agents = T.robots.map((_, r) => new RobotAgent(T, r, ui));
  dispatcher = new Dispatcher(T, ui);
  $('#log').innerHTML = ''; renderSuggestions(); renderRoster(); refreshStats();
  const nObj = T.scene.objects.filter((o) => o.cat !== 'door' && o.cat !== 'rack').length;
  $('#world-status').textContent = `${def.rooms.length} rooms, ${nObj} objects. ${prior ? 'Each robot starts knowing only the rooms it explored; maps are merged when a task needs it.' : 'Robots start with empty maps.'}`;
  worldBusy = false; dirtyLinks = true;
  return T;
}

// ---------- dock
function renderRoster() {
  const T = team; if (!T) return;
  $('#roster').innerHTML = T.robots.map((rb, r) => {
    const job = T.jobs[r], p = T.pose[r];
    return `<span class="rob ${job ? 'busy' : ''}" title="${rb.name}: ${job ? job.label : 'idle'} in ${roomAt(T.scene, p.x, p.y)}"><i style="background:${rb.css}">${r + 1}</i>${job ? esc(job.label.replace(/ T\d+| R\d+\.\d+/, '')) : roomAt(T.scene, p.x, p.y)}</span>`;
  }).join('');
}
function refreshStats() {
  const T = team; if (!T) return;
  const ate = T.M ? T.teamAte() : T.pooledLocalAte();
  const dis = T.M ? (T.optimized ? T.solverStats.map_disagreement_after_m : T.M.disInit) : null;
  $('#stats').innerHTML = [
    `<span>maps merged <b>${T.M ? `${T.M.joined.length}/${T.n}` : `0/${T.n}`}</b></span>`,
    dis != null ? `<span>robots disagree by <b>${dis.toFixed(2)} m</b></span>` : '',
    ate != null ? `<span>map error <b>${ate.toFixed(2)} m</b></span>` : '',
    `<span>sent <b>${kb(T.bytes.objects + T.bytes.dgs)}</b></span>`,
    `<span>${llm.ready ? 'LLM agents' : 'planner agents'}</span>`,
  ].filter(Boolean).join('');
}
function renderSuggestions() {
  const T = team; if (!T) return;
  const pick = (k) => { try { return makeTask(T, k); } catch { return null; } };
  const f = pick('fetch'), inv = pick('inventory');
  const unexplored = T.scene.rooms.find((q) => !T.robots.some((_, i) => T.sims[i].explored.has(q.name)))?.name;
  const s = [f && `Send a robot to the ${f.query}`, inv && `Check every ${inv.cat}`, f && T.n > 1 && `Everyone meet at the ${f.query}`,
    inv && `Where are the ${inv.cat}s?`, unexplored && `Explore the ${unexplored}`].filter(Boolean).slice(0, 4);
  $('#chips').innerHTML = $('#log').children.length ? '' : s.map((c) => `<button type="button">${c}</button>`).join('');
  $('#chips').querySelectorAll('button').forEach((b) => (b.onclick = () => send(b.textContent)));
}

let typingEl = null;
function addLog(e) {
  const T = team, log = $('#log');
  const rb = e.r != null && e.r !== 'dispatcher' ? T.robots[e.r] : null;
  const dot = (r) => `<span class="dot" style="background:${T.robots[r].css}"></span>`;
  const put = (el) => { log.append(el); log.scrollTop = log.scrollHeight; return el; };
  const div = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return put(d); };
  if (e.kind !== 'thinking') { typingEl?.remove(); typingEl = null; }
  switch (e.kind) {
    case 'task': div('f-task', esc(e.text)); $('#chips').innerHTML = ''; break;
    case 'dispatch': div('f-disp', esc(e.text)); break;
    case 'result': div('f-result', `${esc(e.text)}${e.meta ? `<small>${e.meta}</small>` : ''}`); break;
    case 'thinking': typingEl?.remove(); typingEl = div('f-say typing', `${dot(e.r)}${rb.name} is thinking`); break;
    case 'user': if (e.from != null && e.from !== 'dispatcher') div('f-peer', `<b>${T.robots[e.from].name} → ${rb.name}:</b> ${esc(e.text.replace(/^\[from Robot \d+\]\s*/, ''))}`); break;
    case 'tool': {
      const d = document.createElement('details'); d.className = 'f-step'; d.dataset.pending = '1'; d.dataset.r = e.r; d.dataset.name = e.name;
      const args = e.input && Object.values(e.input).filter(Boolean).join(', ');
      d.innerHTML = `<summary>${dot(e.r)}${rb.id} ${e.name.replace(/_/g, ' ')}${args ? ` ${esc(args)}` : ''} <span class="res"></span></summary>`;
      put(d); break;
    }
    case 'tool-result': {
      const pend = [...log.querySelectorAll('details.f-step[data-pending]')].reverse().find((x) => x.dataset.r === String(e.r) && x.dataset.name === e.name);
      if (pend) { delete pend.dataset.pending; const o = e.output || {}; pend.querySelector('.res').textContent = o.error ? `⚠ ${o.error}` : summarize(e.name, o); pend.insertAdjacentHTML('beforeend', `<pre>${esc(JSON.stringify(o, null, 1))}</pre>`); }
      break;
    }
    case 'reply': if (e.depth) div('f-say', `${dot(e.r)}${esc(e.text)}`); break;
    case 'error': div('f-err', esc(e.text)); break;
    default: break;
  }
}
function summarize(name, o) {
  return { explore_room: `→ +${o.new_objects} objects`, exchange_maps: `→ ${o.robots_merged?.length} merged`, optimize_team_map: `→ ${o.map_disagreement_after_m} m`,
    search_map: `→ ${o.results?.length ?? 0} found`, navigate_to: `→ ${o.distance_to_real_object_m} m away`, ask_robot: '→ replied' }[name] || '';
}
async function send(text) {
  text = text.trim(); if (!text || !team || taskRunning || worldBusy) return;
  $('#q').value = ''; taskRunning = true; $('#ask .go').disabled = true;
  try { await dispatcher.handle(text); } catch (e) { addLog({ kind: 'error', text: e.message }); }
  finally { taskRunning = false; $('#ask .go').disabled = false; refreshStats(); renderRoster(); }
}
$('#ask').onsubmit = (e) => { e.preventDefault(); send($('#q').value); };

// ---------- compare
function renderTasks() {
  $('#task').innerHTML = TASKS.map((t) => `<button class="card-opt ${t.id === taskKind ? 'on' : ''}" data-k="${t.id}"><b>${t.name}</b><small>${t.blurb}</small></button>`).join('');
  $('#task').querySelectorAll('button').forEach((b) => (b.onclick = () => { taskKind = b.dataset.k; renderTasks(); }));
  $('#task-text').textContent = `${SCENES[sceneIdx].name}, ${$('#nrob').value} robots.`;
}
renderTasks();
$('#open-compare').addEventListener('click', renderTasks);
$('#b-compare').onclick = async () => {
  if (worldBusy) return;
  const btn = $('#b-compare'); btn.disabled = true; btn.innerHTML = '<span class="spin">Running both teams</span>';
  $('#cmp').innerHTML = ''; await new Promise((r) => setTimeout(r, 30));
  try {
    const def = SCENES[sceneIdx], n = +$('#nrob').value;
    const c = await compare(Team, def, n, seed, taskKind);
    lastCmp = { c, sceneIdx, n, seed }; renderCompare(c);
  } catch (e) { $('#cmp').innerHTML = `<p class="f-err">${esc(e.message)}</p>`; }
  btn.disabled = false; btn.textContent = 'Run both';
};
function renderCompare(c) {
  const S = c.results.shared, I = c.results.independent;
  const speedup = S.time_s > 0 ? I.time_s / S.time_s : Infinity;
  let verdict, meh = false;
  if (S.score > I.score) verdict = 'Only the team with the shared map finished the task.';
  else if (S.score >= I.score && I.time_s > S.time_s * 1.15) verdict = `Sharing the map made the team <b>${Number.isFinite(speedup) ? `${speedup.toFixed(1)}× faster` : 'instant'}</b>${I.distance_m > S.distance_m * 1.15 ? `, with <b>${(I.distance_m / Math.max(1, S.distance_m)).toFixed(1)}× less driving</b>` : ''}.`;
  else { verdict = 'Here sharing did not pay off: the robots already knew what they needed, and merging maps costs time.'; meh = true; }
  const side = (title, r, win, id) => `<div class="side ${win ? 'win' : ''}"><h4>${title}</h4><div class="big">${r.time_s} s</div>
    <div class="sub">${r.success ? 'done' : `${Math.round(r.score * 100)}% done`} · ${r.distance_m} m driven · ${kb(r.bytes)} sent</div><button class="btn" id="${id}">Watch</button></div>`;
  const sWin = S.score > I.score || (S.score >= I.score && S.time_s < I.time_s);
  $('#cmp').innerHTML = `<div class="cmp"><div class="q">${esc(c.task.text)}</div><div class="verdict ${meh ? 'meh' : ''}">${verdict}</div>
    <div class="versus">${side('Shared map', S, sWin, 'w-s')}${side('Each robot alone', I, !sWin, 'w-i')}</div>
    <div class="runlog">${[...S.logs.map((l) => `shared  ${l}`), ...I.logs.map((l) => `alone   ${l}`)].map(esc).join('\n')}</div></div>`;
  $('#w-s').onclick = () => watch(true); $('#w-i').onclick = () => watch(false);
}
async function watch(shared) {
  if (!lastCmp || worldBusy) return;
  closeDrawers();
  sceneIdx = lastCmp.sceneIdx; renderScenes(); $('#nrob').value = lastCmp.n; $('#nval').textContent = lastCmp.n; seed = lastCmp.seed;
  const T = await buildWorld({ shared, prior: true });
  const task = { ...lastCmp.c.task, target: lastCmp.c.task.target && T.scene.objects.find((o) => o.id === lastCmp.c.task.target.id) };
  addLog({ kind: 'task', text: `${task.text} (${shared ? 'shared map' : 'robots alone'})` });
  taskRunning = true; $('#ask .go').disabled = true;
  try {
    const res = await runTask(T, task, (m) => addLog({ kind: 'dispatch', text: m.replace(/^\[t=\d+s\]\s*/, '') }));
    addLog({ kind: 'result', text: res.success ? 'Task complete.' : `Task ${Math.round(res.score * 100)}% complete.`, meta: `${res.time_s} s · ${res.distance_m} m driven` });
  } finally { taskRunning = false; $('#ask .go').disabled = false; }
}

// ---------- render loop
let last = performance.now(), lastSlow = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const T = team;
  if (T) {
    if (T.busy()) T.tick(dt * speed);
    T.robots.forEach((_, r) => view.setRobotPose(r, T.pose[r]));
    if (now - lastSlow > 120) {
      lastSlow = now;
      T.robots.forEach((rb, r) => { const v = T.liveView(r); view.setTrail(r, v.poses, T.sims[r].gt, false); view.setLandmarks(r, v.lms, rb.color); });
      if (dirtyLinks || T.optJob) {
        dirtyLinks = false;
        const links = [];
        if (T.M) {
          const views = T.robots.map((_, r) => T.liveView(r));
          for (const L of T.M.links) { const a = views[L.ra].lms[L.objA], b = views[L.rb].lms[L.objB]; if (a && b) links.push({ a, b, kind: 'obj' }); }
          for (const e of T.M.encounters) { const a = views[e.ra].poses[e.ka], b = views[e.rb].poses[e.kb]; if (a && b) links.push({ a, b, kind: 'enc' }); }
        }
        view.setLinks(links.slice(0, 400));
        refreshStats();
      }
      if (T.busy()) renderRoster();
    }
  }
  view.render(now);
  requestAnimationFrame(frame);
}
applyInsets();
buildWorld().then(() => requestAnimationFrame(frame));
window.__ui = { get team() { return team; }, ui, send };
