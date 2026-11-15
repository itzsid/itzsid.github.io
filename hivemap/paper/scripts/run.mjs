// Batch runner for the Hivemap communication experiments.
//   node run.mjs [--seeds 5] [--workers 4] [--only main,scaling,ablation] [--out DIR]
// Runs jobs in parallel worker processes (child_process.fork), appends one JSON
// line per episode to DIR/results.jsonl (resumable: finished jobs are skipped)
// and writes DIR/results.csv (flat summary, no logs) at the end.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const EXP = new URL('../../js/experiments.js', import.meta.url).href;

if (process.argv.includes('--worker')) {
  const { runOne } = await import(EXP);
  process.on('message', async (job) => {
    let rec;
    try { rec = await runOne(job.scene, job.n, job.seed, job.task, job.condition, { agg: job.agg || 'max' }); }
    catch (e) { rec = { scene: job.scene, n: job.n, seed: job.seed, task: job.task, condition: job.condition, success: false, score: 0, timeout: false, error: `crash: ${e.stack || e}` }; }
    process.send({ key: job.key, rec: { ...rec, grid: job.grid } });
  });
} else {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
  const SEEDS = +arg('--seeds', 5), WORKERS = +arg('--workers', 4), ONLY = arg('--only', 'main,scaling,ablation').split(',');
  const OUT = arg('--out', fileURLToPath(new URL('../results', import.meta.url)));
  const WALL_LIMIT = 900e3;   // ms per episode before the worker is killed and the job recorded as stuck
  fs.mkdirSync(OUT, { recursive: true });
  const FILE = path.join(OUT, 'results.jsonl');
  const SCENES = ['office', 'warehouse', 'home', 'hospital', 'retail', 'labs'];
  const TASKS = ['fetch', 'inventory', 'rendezvous', 'dispatch', 'search'];
  const CONDS = ['alone', 'language', 'shared_noopt', 'shared_opt', 'oracle', 'shared_noverify', 'shared_noenc'];
  const jobs = [];
  const add = (grid, scene, n, seed, task, condition, agg = null) => jobs.push({ grid, scene, n, seed, task, condition, agg, key: [grid, scene, n, seed, task, condition, agg || ''].join('|') });
  if (ONLY.includes('main')) for (const n of [8, 4, 2]) for (const scene of SCENES) for (const task of TASKS) for (let seed = 1; seed <= SEEDS; seed++) for (const c of CONDS) add('main', scene, n, seed, task, c);
  // scaling sweep: team sizes not in the main grid (2, 4, 8 are taken from the main grid, seeds 1-3)
  if (ONLY.includes('scaling')) for (const n of [10, 6, 1]) for (const scene of ['office', 'hospital']) for (const task of ['fetch', 'rendezvous']) for (let seed = 1; seed <= 3; seed++) for (const c of CONDS) add('scaling', scene, n, seed, task, c);
  // ablation: language aggregation rule "sum" (naive) instead of per-room "max"
  if (ONLY.includes('ablation')) for (const n of [8, 4, 2]) for (const scene of SCENES) for (const task of ['inventory', 'dispatch']) for (let seed = 1; seed <= SEEDS; seed++) add('ablation', scene, n, seed, task, 'language', 'sum');
  const done = new Set();
  if (fs.existsSync(FILE)) for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); done.add(r.key); } catch {} }
  const todo = jobs.filter((j) => !done.has(j.key));
  console.log(`${jobs.length} jobs, ${done.size} already done, ${todo.length} to run on ${WORKERS} workers`);
  const out = fs.createWriteStream(FILE, { flags: 'a' });
  const t0 = Date.now(); let finished = 0, next = 0;
  await new Promise((resolveAll) => {
    let active = 0;
    const spawn = () => {
      const w = fork(HERE, ['--worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      let cur = null, timer = null;
      const give = () => {
        if (next >= todo.length) { w.kill(); active--; if (!active) resolveAll(); return; }
        cur = todo[next++];
        timer = setTimeout(() => {   // stuck episode: record it and replace the worker
          out.write(JSON.stringify({ key: cur.key, grid: cur.grid, scene: cur.scene, n: cur.n, seed: cur.seed, task: cur.task, condition: cur.condition, agg: cur.agg, success: false, score: 0, timeout: true, error: 'wall-clock limit (stuck)' }) + '\n');
          finished++; w.removeAllListeners('message'); w.kill('SIGKILL'); active--; spawn();
        }, WALL_LIMIT);
        w.send(cur);
      };
      w.on('message', ({ key, rec }) => {
        clearTimeout(timer);
        out.write(JSON.stringify({ key, ...rec }) + '\n');
        finished++;
        if (finished % 25 === 0 || finished === todo.length) {
          const el = (Date.now() - t0) / 1000;
          console.log(`${finished}/${todo.length}  ${el.toFixed(0)} s elapsed, ETA ${((el / finished) * (todo.length - finished)).toFixed(0)} s`);
        }
        give();
      });
      active++; give();
    };
    for (let i = 0; i < Math.min(WORKERS, todo.length); i++) spawn();
    if (!todo.length) resolveAll();
  });
  await new Promise((r) => out.end(r));
  // flat CSV of every episode (no logs / nested fields)
  const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !['log', 'key'].includes(k) && (r[k] === null || typeof r[k] !== 'object'))))];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.writeFileSync(path.join(OUT, 'results.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${rows.length} rows in ${FILE}`);
}
