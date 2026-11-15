"""Aggregate Hivemap communication experiments.
python3 analyze.py [results_dir]  ->  summary.json, summary.md in results_dir
"""
import json, sys, os, math, collections
import numpy as np

D = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results')
rows = [json.loads(l) for l in open(os.path.join(D, 'results.jsonl')) if l.strip()]
COND = ['alone', 'language', 'shared_noopt', 'shared_opt', 'oracle', 'shared_noverify', 'shared_noenc']
CN = {'alone': 'Alone', 'language': 'Language', 'shared_noopt': 'Shared map (no opt)', 'shared_opt': 'Shared map + opt',
      'oracle': 'Oracle map', 'shared_noverify': 'No-verify merge', 'shared_noenc': 'Verified, no encounters'}
TASKS = ['fetch', 'inventory', 'rendezvous', 'dispatch', 'search']
RNG = np.random.default_rng(12345)
B = 2000

def num(v):
    if v is None: return np.nan
    if isinstance(v, bool): return float(v)
    return float(v)

def stats(xs):
    a = np.array([num(x) for x in xs], dtype=float); a = a[~np.isnan(a)]
    if not len(a): return None
    idx = RNG.integers(0, len(a), (B, len(a)))
    bm = a[idx].mean(1)
    return {'n': int(len(a)), 'mean': float(a.mean()), 'median': float(np.median(a)), 'std': float(a.std(ddof=1)) if len(a) > 1 else 0.0,
            'ci95': [float(np.percentile(bm, 2.5)), float(np.percentile(bm, 97.5))]}

METRICS = ['success', 'score', 'time_s', 'distance_m', 'bytes', 'bytes_text', 'tokens_approx', 'bytes_objects', 'bytes_dgs', 'messages', 'grounding_errors',
           'target_pos_err_m', 'ate_team', 'ate_local', 'merge_wrong_links', 'merge_wrong_frames', 'merge_joined', 'inv_room_exact', 'inv_room_over', 'inv_room_miss',
           'disp_duplicate', 'disp_wasted', 'disp_missed', 'room_misses', 'false_found', 'job_timeouts', 'stuck_legs', 'stuck_nav', 'stuck_explore']

def ep_key(r): return (r['scene'], r['n'], r['seed'], r['task'])

main = [r for r in rows if r.get('grid') == 'main']
by = collections.defaultdict(list)
for r in main: by[(r['task'], r['condition'])].append(r)
byn = collections.defaultdict(list)
for r in main: byn[(r['task'], r['condition'], r['n'])].append(r)

def agg(rs):
    out = {m: stats([r.get(m) for r in rs]) for m in METRICS}
    out['time_s_success_only'] = stats([r.get('time_s') for r in rs if r.get('success')])
    out['episodes'] = len(rs)
    return out

def speedup(rs_c, rs_a, metric='time_s'):
    """paired ratio of means mean(alone)/mean(cond) over matched episodes, bootstrap CI over episodes"""
    A = {ep_key(r): num(r.get(metric)) for r in rs_a}
    pairs = [(A[ep_key(r)], num(r.get(metric))) for r in rs_c if ep_key(r) in A]
    pairs = [p for p in pairs if not (math.isnan(p[0]) or math.isnan(p[1]))]
    if not pairs: return None
    a = np.array(pairs)
    def ratio(x): return x[:, 0].mean() / x[:, 1].mean() if x[:, 1].mean() > 0 else float('inf')
    idx = RNG.integers(0, len(a), (B, len(a)))
    bs = np.array([ratio(a[i]) for i in idx])
    r0 = ratio(a)
    fin = bs[np.isfinite(bs)]
    return {'ratio_of_means': None if not np.isfinite(r0) else float(r0), 'ci95': [float(np.percentile(fin, 2.5)), float(np.percentile(fin, 97.5))] if len(fin) > 0.95 * len(bs) else None,
            'paired_n': len(a), 'note': 'condition mean is 0 (no driving needed)' if not np.isfinite(r0) else None}

summary = {'n_rows': len(rows), 'grids': dict(collections.Counter(r.get('grid') for r in rows)), 'by_task_condition': {}, 'by_task_condition_n': {}, 'speedup_vs_alone': {}, 'speedup_vs_alone_by_n': {}}
for (t, c), rs in sorted(by.items()):
    summary['by_task_condition'][f'{t}|{c}'] = agg(rs)
    if c != 'alone':
        summary['speedup_vs_alone'][f'{t}|{c}'] = {m: speedup(rs, by[(t, 'alone')], m) for m in ['time_s', 'distance_m']}
for (t, c, n), rs in sorted(byn.items()):
    summary['by_task_condition_n'][f'{t}|{c}|{n}'] = agg(rs)
    if c != 'alone':
        summary['speedup_vs_alone_by_n'][f'{t}|{c}|{n}'] = {m: speedup(rs, byn[(t, 'alone', n)], m) for m in ['time_s', 'distance_m']}

# scaling sweep: office + hospital, fetch + rendezvous, seeds 1-3, n in {1,2,4,6,8,10}
sc = [r for r in rows if r['scene'] in ('office', 'hospital') and r['task'] in ('fetch', 'rendezvous') and r['seed'] <= 3 and r.get('grid') in ('main', 'scaling')]
scal = collections.defaultdict(list)
for r in sc: scal[(r['task'], r['condition'], r['n'])].append(r)
summary['scaling'] = {f'{t}|{c}|{n}': agg(rs) for (t, c, n), rs in sorted(scal.items())}

# language aggregation ablation (sum vs max)
abl = [r for r in rows if r.get('grid') == 'ablation']
ab = collections.defaultdict(list)
for r in abl: ab[r['task']].append(r)
summary['ablation_language_sum'] = {t: agg(rs) for t, rs in ab.items()}

# sanity
fp = collections.defaultdict(set); tt = collections.defaultdict(set)
for r in rows:
    if r.get('prior_fp'): fp[ep_key(r)].add(r['prior_fp']); tt[ep_key(r)].add(r.get('task_text'))
san = {'prior_fingerprint_mismatch': [list(k) for k, v in fp.items() if len(v) > 1], 'task_mismatch': [list(k) for k, v in tt.items() if len(v) > 1],
       'collisions': [r['key'] for r in rows if r.get('collision')], 'sim_time_limit_or_stuck': [r['key'] for r in rows if r.get('error') and ('time limit' in r['error'] or 'wall-clock' in r['error'])],
       'policy_errors': [(r['key'], (r.get('error') or '')[:300]) for r in rows if r.get('error') and 'time limit' not in r['error'] and 'wall-clock' not in r['error'] and not r['error'].startswith('crash')],
       'crashes': [(r['key'], (r.get('error') or '')[:300]) for r in rows if (r.get('error') or '').startswith('crash')],
       'episodes_with_job_timeouts': sum(1 for r in rows if (r.get('job_timeouts') or 0) > 0),
       'job_timeouts_by_condition': dict(collections.Counter(r['condition'] for r in rows if (r.get('job_timeouts') or 0) > 0)),
       'min_sep_m_overall': min([r['min_sep_m'] for r in rows if r.get('min_sep_m') is not None], default=None),
       'wall_s_total': sum(r.get('wall_s') or 0 for r in rows)}
summary['sanity'] = san
json.dump(summary, open(os.path.join(D, 'summary.json'), 'w'), indent=1)

# ---------------- markdown
S = summary['by_task_condition']
def m(t, c, k, f='{:.0f}', ci=False):
    s = S.get(f'{t}|{c}', {}).get(k)
    if not s: return '–'
    v = f.format(s['mean'])
    return f"{v} [{f.format(s['ci95'][0])}, {f.format(s['ci95'][1])}]" if ci else v
def pct(t, c, k='success', d=S):
    s = d.get(f'{t}|{c}', {}).get(k)
    return '–' if not s else f"{100 * s['mean']:.0f}%"
def kb(t, c, k='bytes'):
    s = S.get(f'{t}|{c}', {}).get(k)
    if not s: return '–'
    v = s['mean']
    return f'{v / 1024:.0f} KiB' if v >= 10240 else f'{v:.0f} B'
def sp(t, c, k='time_s'):
    x = summary['speedup_vs_alone'].get(f'{t}|{c}', {}).get(k)
    if c == 'alone': return '1.0×'
    if not x: return '–'
    if x['ratio_of_means'] is None: return '∞ (no driving)'
    return f"{x['ratio_of_means']:.1f}×" + (f" [{x['ci95'][0]:.1f}, {x['ci95'][1]:.1f}]" if x['ci95'] else '')

L = []
L.append('# Hivemap communication experiments: summary\n')
L.append(f"Episodes: {len(rows)} ({', '.join(f'{k}: {v}' for k, v in summary['grids'].items())}). Main grid: 6 scenes × team sizes {{2,4,8}} × 5 tasks × 7 conditions × seeds 1–5. "
         "Means over all episodes (failures included, with the time they used). Brackets: 95% bootstrap CI of the mean (2000 resamples). "
         "Speed-up = mean time of ALONE / mean time of the condition over the same episodes (paired bootstrap CI).\n")
for t in TASKS:
    L.append(f'\n## {t}\n')
    extra = ' | room-level exact' if t == 'inventory' else ''
    L.append('| condition | success | score | time (s) | speed-up vs alone | distance (m) | bytes | messages | grounding errors | target pos. err (m)' + extra + ' |')
    L.append('|---|---|---|---|---|---|---|---|---|---' + ('|---' if extra else '') + '|')
    for c in COND:
        if f'{t}|{c}' not in S: continue
        row = f"| {CN[c]} | {pct(t, c)} | {m(t, c, 'score', '{:.2f}')} | {m(t, c, 'time_s', ci=True)} | {sp(t, c)} | {m(t, c, 'distance_m')} | {kb(t, c)} | {m(t, c, 'messages')} | {m(t, c, 'grounding_errors', '{:.2f}')} | {m(t, c, 'target_pos_err_m', '{:.2f}')}"
        if extra: row += f" | {pct(t, c, 'inv_room_exact')}"
        L.append(row + ' |')

# success by team size
SN = summary['by_task_condition_n']
L.append('\n## Success rate and mean time by team size (main grid)\n')
L.append('| task | condition | n=2 success | n=2 time | n=4 success | n=4 time | n=8 success | n=8 time |')
L.append('|---|---|---|---|---|---|---|---|')
for t in TASKS:
    for c in COND:
        cells = []
        for n in (2, 4, 8):
            s = SN.get(f'{t}|{c}|{n}')
            cells += ['–', '–'] if not s else [f"{100 * s['success']['mean']:.0f}%", f"{s['time_s']['mean']:.0f}"]
        L.append(f'| {t} | {CN[c]} | ' + ' | '.join(cells) + ' |')

# scaling
L.append('\n## Scaling sweep (office + hospital, seeds 1–3): success % / mean time (s)\n')
L.append('| task | condition | ' + ' | '.join(f'n={n}' for n in (1, 2, 4, 6, 8, 10)) + ' |')
L.append('|---|---|' + '---|' * 6)
for t in ('fetch', 'rendezvous'):
    for c in COND:
        cells = []
        for n in (1, 2, 4, 6, 8, 10):
            s = summary['scaling'].get(f'{t}|{c}|{n}')
            cells.append('–' if not s else f"{100 * s['success']['mean']:.0f}% / {s['time_s']['mean']:.0f}")
        L.append(f'| {t} | {CN[c]} | ' + ' | '.join(cells) + ' |')

# bytes per channel
L.append('\n## Bytes per channel (main grid, mean per episode, all tasks)\n')
L.append('| condition | language text | ≈ tokens (bytes/4) | object descriptors | distributed optimization | total | messages |')
L.append('|---|---|---|---|---|---|---|')
allc = collections.defaultdict(list)
for r in main: allc[r['condition']].append(r)
def mean(rs, k):
    v = [num(r.get(k)) for r in rs]; v = [x for x in v if not math.isnan(x)]
    return sum(v) / len(v) if v else float('nan')
for c in COND:
    rs = allc.get(c)
    if not rs: continue
    L.append(f"| {CN[c]} | {mean(rs, 'bytes_text'):.0f} B | {mean(rs, 'tokens_approx'):.0f} | {mean(rs, 'bytes_objects') / 1024:.0f} KiB | {mean(rs, 'bytes_dgs') / 1024:.0f} KiB | {mean(rs, 'bytes') / 1024:.1f} KiB | {mean(rs, 'messages'):.0f} |")

# merge quality
L.append('\n## Map-merge quality (main grid, at the last exchange of each episode)\n')
L.append('| condition | robots joined / n | wrong object links | wrong robot frames (>1.5 m) | episodes with ≥1 wrong merge | success (all tasks) | team ATE (m) |')
L.append('|---|---|---|---|---|---|---|')
for c in ['shared_noopt', 'shared_opt', 'oracle', 'shared_noenc', 'shared_noverify']:
    rs = allc.get(c)
    if not rs: continue
    jn = np.mean([r['merge_joined'] / r['n'] for r in rs if r.get('merge_joined') is not None])
    wrong = np.mean([1.0 if (r.get('merge_wrong_links') or 0) + (r.get('merge_wrong_frames') or 0) > 0 else 0.0 for r in rs])
    L.append(f"| {CN[c]} | {100 * jn:.0f}% | {mean(rs, 'merge_wrong_links'):.2f} | {mean(rs, 'merge_wrong_frames'):.2f} | {100 * wrong:.0f}% | {100 * mean(rs, 'success'):.0f}% | {mean(rs, 'ate_team'):.2f} |")

# ablation
if ab:
    L.append('\n## Language aggregation ablation (per-room max vs naive sum of teammates\' counts)\n')
    L.append('| task | rule | success | score | time (s) | grounding errors | over-count (rooms) | under-count (rooms) |')
    L.append('|---|---|---|---|---|---|---|---|')
    for t in ('inventory', 'dispatch'):
        a1 = S.get(f'{t}|language'); a2 = summary['ablation_language_sum'].get(t)
        for name, s in (('max (default)', a1), ('sum', a2)):
            if not s: continue
            g = lambda k, f='{:.2f}': '–' if not s.get(k) else f.format(s[k]['mean'])
            L.append(f"| {t} | {name} | {100 * s['success']['mean']:.0f}% | {g('score')} | {g('time_s', '{:.0f}')} | {g('grounding_errors')} | {g('inv_room_over')} | {g('inv_room_miss')} |")

# per-scene success (all tasks pooled)
L.append('\n## Success rate by scene (main grid, all tasks pooled)\n')
SCN = ['office', 'warehouse', 'home', 'hospital', 'retail', 'labs']
L.append('| condition | ' + ' | '.join(SCN) + ' |')
L.append('|---|' + '---|' * len(SCN))
pers = collections.defaultdict(list)
for r in main: pers[(r['condition'], r['scene'])].append(r)
summary['success_by_scene'] = {}
for c in COND:
    cells = []
    for scn in SCN:
        rs = pers.get((c, scn), [])
        v = mean(rs, 'success') if rs else float('nan'); summary['success_by_scene'][f'{c}|{scn}'] = v
        cells.append('–' if math.isnan(v) else f'{100 * v:.0f}%')
    L.append(f'| {CN[c]} | ' + ' | '.join(cells) + ' |')

# effect of distributed optimization on the navigated target estimate (paired episodes)
L.append('\n## Effect of distributed optimization on target position error (paired shared_noopt vs shared_opt episodes)\n')
L.append('| task | paired episodes | mean err no-opt (m) | mean err opt (m) | opt worse by > 0.2 m | opt better by > 0.2 m | success no-opt | success opt |')
L.append('|---|---|---|---|---|---|---|---|')
summary['opt_effect'] = {}
for t in TASKS:
    A = {ep_key(r): r for r in main if r['task'] == t and r['condition'] == 'shared_noopt'}
    P = [(A[ep_key(r)], r) for r in main if r['task'] == t and r['condition'] == 'shared_opt' and ep_key(r) in A]
    E = [(a['target_pos_err_m'], b['target_pos_err_m']) for a, b in P if a.get('target_pos_err_m') is not None and b.get('target_pos_err_m') is not None]
    if not E: continue
    ea, eb = np.array(E).T
    d = {'paired': len(E), 'err_noopt': float(ea.mean()), 'err_opt': float(eb.mean()), 'opt_worse_0.2': float(np.mean(eb > ea + 0.2)), 'opt_better_0.2': float(np.mean(eb < ea - 0.2)),
         'succ_noopt': float(np.mean([a['success'] for a, _ in P])), 'succ_opt': float(np.mean([b['success'] for _, b in P]))}
    summary['opt_effect'][t] = d
    L.append(f"| {t} | {d['paired']} | {d['err_noopt']:.2f} | {d['err_opt']:.2f} | {100 * d['opt_worse_0.2']:.0f}% | {100 * d['opt_better_0.2']:.0f}% | {100 * d['succ_noopt']:.0f}% | {100 * d['succ_opt']:.0f}% |")
json.dump(summary, open(os.path.join(D, 'summary.json'), 'w'), indent=1)

# stuck robots (engine-level: blocked by parked teammates, legs abandoned) per condition x task
L.append('\n## Stuck robots: % of episodes with >= 1 stuck leg (job timeout, nav leg ending > 3.5 m from goal, or coverage that never entered its room)\n')
L.append('| condition | ' + ' | '.join(TASKS) + ' | success excl. stuck episodes (all tasks) | success of stuck episodes |')
L.append('|---|' + '---|' * (len(TASKS) + 2))
summary['stuck'] = {}
for c in COND:
    cells = []
    for t in TASKS:
        rs = by.get((t, c), [])
        v = np.mean([1.0 if (r.get('stuck_legs') or 0) > 0 else 0.0 for r in rs]) if rs else float('nan')
        summary['stuck'][f'{t}|{c}'] = float(v); cells.append(f'{100 * v:.0f}%')
    rs = allc.get(c, []); ok = [r for r in rs if not (r.get('stuck_legs') or 0)]; bad = [r for r in rs if (r.get('stuck_legs') or 0)]
    L.append(f"| {CN[c]} | " + ' | '.join(cells) + f" | {100 * mean(ok, 'success'):.0f}% (n={len(ok)}) | " + (f"{100 * mean(bad, 'success'):.0f}% (n={len(bad)})" if bad else '–') + ' |')
json.dump(summary, open(os.path.join(D, 'summary.json'), 'w'), indent=1)

L.append('\n## Sanity\n')
L.append(f"- prior fingerprint identical across conditions for every (scene, n, seed, task): {'yes' if not san['prior_fingerprint_mismatch'] else 'NO: ' + str(san['prior_fingerprint_mismatch'][:5])}")
L.append(f"- task identical across conditions: {'yes' if not san['task_mismatch'] else 'NO'}")
L.append(f"- robot collisions (centre distance < 0.5 m while moving): {len(san['collisions'])}; smallest separation seen: {san['min_sep_m_overall']} m")
L.append(f"- episodes hitting the 3600 s sim limit or the wall-clock stuck guard: {len(san['sim_time_limit_or_stuck'])} {san['sim_time_limit_or_stuck'][:10]}")
L.append(f"- policy exceptions (counted as failures; e.g. goTo 'No path found.' from the existing planner): {len(san['policy_errors'])} {[k for k, _ in san['policy_errors']][:12]}")
L.append(f"- harness crashes: {len(san['crashes'])}")
L.append(f"- episodes where some motion job hit its per-job timeout (robot stuck, job abandoned): {san['episodes_with_job_timeouts']} {san['job_timeouts_by_condition']}")
L.append(f"- total CPU time in episodes: {san['wall_s_total'] / 60:.0f} min")
open(os.path.join(D, 'summary.md'), 'w').write('\n'.join(L) + '\n')
print('\n'.join(L))
