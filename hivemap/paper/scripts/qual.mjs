// Record one episode under several conditions for the qualitative figure.
//   node qual.mjs hospital 4 2 fetch alone,language,shared_opt > out.json
// Output: floor plan (walls, rooms, objects), the task, and each robot's
// ground-truth path during the task for every condition.
import { runOne } from '../../js/experiments.js';
import { Team } from '../../js/engine.js';

const [scene, n, seed, task, conds] = process.argv.slice(2);
const out = { scene, n: +n, seed: +seed, task, runs: {} };
// patch Team so the episode's team object is reachable after runOne returns
const origRun = Team.prototype.runHeadless;
let lastTeam = null, marks = null;
Team.prototype.runHeadless = async function (fn, ...rest) {
  lastTeam = this;
  if (marks === null) { marks = 'prior'; return origRun.call(this, fn, ...rest); }
  // second call = the task: remember where each robot's path starts
  this._taskStart = this.sims.map((s) => s.gt.length);
  return origRun.call(this, fn, ...rest);
};
for (const c of conds.split(',')) {
  marks = null; lastTeam = null;
  const rec = await runOne(scene, +n, +seed, task, c);
  const T = lastTeam;
  if (!out.walls) {
    out.walls = T.scene.walls; out.rooms = T.scene.rooms; out.w = T.scene.w; out.h = T.scene.h;
    out.objects = T.scene.objects.filter((o) => !o.hidden).map((o) => ({ id: o.id, cat: o.cat, color: o.color, x: o.x, y: o.y }));
  }
  const paths = T.sims.map((s, r) => s.gt.slice(Math.max(0, (T._taskStart?.[r] ?? 1) - 1)).map((p) => [+p.x.toFixed(2), +p.y.toFixed(2)]));
  const target = T.scene.objects.find((o) => o.id === rec.target_id) || null;
  out.runs[c] = { success: rec.success, time_s: rec.time_s, distance_m: rec.distance_m, bytes: rec.bytes, task_text: rec.task_text,
    target: target ? { x: target.x, y: target.y, cat: target.cat, color: target.color, id: target.id } : null, paths, log: rec.log };
}
process.stdout.write(JSON.stringify(out));
