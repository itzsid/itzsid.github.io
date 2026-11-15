#!/usr/bin/env python3
"""Tables, figures and headline numbers for the paper from results/results.jsonl.

    python3 analyze.py            # writes tables/*.tex|html, figs/*.pdf|png, results/paper_numbers.json
"""
import collections
import json
import math
import os

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = os.path.dirname(os.path.abspath(__file__))
R = lambda *p: os.path.join(HERE, *p)

TASKS = ['fetch', 'inventory', 'rendezvous', 'dispatch', 'search']
TASK_NAME = {'fetch': 'Fetch', 'inventory': 'Inventory', 'rendezvous': 'Rendezvous', 'dispatch': 'Dispatch', 'search': 'Search'}
MAIN = ['alone', 'language', 'shared_noopt', 'shared_opt', 'oracle']
NAME = {'alone': 'Alone', 'language': 'Language', 'shared_noopt': 'Map (merge only)', 'shared_opt': 'Map + opt.', 'oracle': 'Oracle map',
        'shared_noverify': 'No checks, no meetings', 'shared_noenc': 'Checks, no meetings'}
SHORT = {'alone': 'Alone', 'language': 'Language', 'shared_noopt': 'Merge only', 'shared_opt': 'Map + opt.', 'oracle': 'Oracle'}
# colors: neutral baseline, then validated categorical slots (orange, aqua, blue); oracle = outline + hatch
COL = {'alone': '#9a9893', 'language': '#eb6834', 'shared_noopt': '#1baf7a', 'shared_opt': '#2a78d6', 'oracle': '#ffffff'}
EDGE = {'oracle': '#2b2b2b'}
INK, INK2, GRID = '#1b1b1b', '#55544f', '#e6e5e1'
SCENES = ['office', 'warehouse', 'home', 'hospital', 'retail', 'labs']
SCENE_NAME = {'office': 'Office', 'warehouse': 'Warehouse', 'home': 'Apartment', 'hospital': 'Hospital', 'retail': 'Retail', 'labs': 'Labs'}
RNG = np.random.default_rng(0)

for f in font_manager.findSystemFonts():
    if 'Inter' in os.path.basename(f):
        font_manager.fontManager.addfont(f)
plt.rcParams.update({
    'font.family': 'Inter', 'font.size': 7.5, 'axes.titlesize': 8, 'axes.labelsize': 7.5, 'xtick.labelsize': 7, 'ytick.labelsize': 7,
    'legend.fontsize': 7, 'axes.edgecolor': INK2, 'axes.labelcolor': INK, 'xtick.color': INK2, 'ytick.color': INK2, 'text.color': INK,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.linewidth': 0.6, 'xtick.major.width': 0.6, 'ytick.major.width': 0.6,
    'savefig.dpi': 300, 'pdf.fonttype': 42, 'ps.fonttype': 42,
})


def load():
    rows = []
    for line in open(R('results', 'results.jsonl')):
        if line.strip():
            r = json.loads(line)
            r.pop('log', None); r.pop('transcript', None)
            rows.append(r)
    # keep the last record per key (resumed runs)
    by = {}
    for r in rows:
        by[r['key']] = r
    return list(by.values())


def mean_ci(x, n_boot=2000):
    x = np.asarray([v for v in x if v is not None and not (isinstance(v, float) and math.isnan(v))], float)
    if not len(x):
        return (float('nan'),) * 3
    m = x.mean()
    if len(x) < 2:
        return m, m, m
    bs = RNG.choice(x, (n_boot, len(x))).mean(1)
    return m, np.percentile(bs, 2.5), np.percentile(bs, 97.5)


def ok(r):
    return not r.get('error')


def succ_of(r):
    """Success; inventory is judged per room (exact count in every room) in every condition."""
    if r['task'] == 'inventory' and r.get('inv_room_exact') is not None:
        return bool(r['inv_room_exact'])
    return bool(r.get('success'))


def episode_key(r):
    return (r['scene'], r['n'], r['seed'], r['task'])


def paired(rows, a, b, metric='time_s', task=None):
    """Paired episodes for conditions a and b: returns arrays (va, vb)."""
    A = {episode_key(r): r for r in rows if r['condition'] == a and (task is None or r['task'] == task) and ok(r)}
    B = {episode_key(r): r for r in rows if r['condition'] == b and (task is None or r['task'] == task) and ok(r)}
    ks = sorted(set(A) & set(B))
    va = np.array([A[k][metric] for k in ks], float)
    vb = np.array([B[k][metric] for k in ks], float)
    return va, vb


def reduction_ci(va, vb, n_boot=4000):
    """Relative reduction of mean(vb) vs mean(va): 1 - mean(vb)/mean(va), paired bootstrap."""
    if not len(va) or va.mean() == 0:
        return (float('nan'),) * 3
    red = 1 - vb.mean() / va.mean()
    idx = RNG.integers(0, len(va), (n_boot, len(va)))
    bs = 1 - vb[idx].mean(1) / np.maximum(va[idx].mean(1), 1e-9)
    return red, np.percentile(bs, 2.5), np.percentile(bs, 97.5)


def fmt_bytes(b):
    if b is None or (isinstance(b, float) and math.isnan(b)):
        return '–'
    if b < 1000:
        return f'{b:.0f} B'
    if b < 1e6:
        return f'{b / 1e3:.1f} kB' if b < 1e4 else f'{b / 1e3:.0f} kB'
    return f'{b / 1e6:.1f} MB'


def tex_bytes(s):
    return s.replace(' ', '\\,')


# --------------------------------------------------------------------- tables
def main_table(rows, N):
    main = [r for r in rows if r['grid'] == 'main']
    stats = {}
    for c in MAIN:
        for t in TASKS:
            sel = [r for r in main if r['condition'] == c and r['task'] == t]
            if not sel:
                continue
            succ = mean_ci([1.0 if (ok(r) and succ_of(r)) else 0.0 for r in sel])
            score = mean_ci([(r.get('score') or 0.0) if ok(r) else 0.0 for r in sel])
            time = mean_ci([r['time_s'] for r in sel if ok(r) and r.get('time_s') is not None])
            stats[(c, t)] = {'n': len(sel), 'success': succ, 'score': score, 'time': time}
        sel = [r for r in main if r['condition'] == c and ok(r)]
        b = [r.get('bytes', 0) or 0 for r in sel]
        stats[(c, 'bytes')] = float(np.median(b)) if b else float('nan')
        stats[(c, 'bytes_mean')] = float(np.mean(b)) if b else float('nan')
        stats[(c, 'msgs')] = float(np.median([r.get('messages', 0) or 0 for r in sel])) if sel else float('nan')
        stats[(c, 'dist')] = mean_ci([r.get('distance_m') for r in sel])
    N['main'] = {f'{c}|{t}': {k: (list(v) if isinstance(v, tuple) else v) for k, v in d.items()} for (c, t), d in stats.items() if isinstance(d, dict)}
    N['bytes_median'] = {c: stats[(c, 'bytes')] for c in MAIN}
    N['bytes_mean'] = {c: stats[(c, 'bytes_mean')] for c in MAIN}
    N['msgs_median'] = {c: stats[(c, 'msgs')] for c in MAIN}
    N['distance_mean'] = {c: stats[(c, 'dist')][0] for c in MAIN}

    # which metric to show per task: success for single-goal tasks, score for graded ones
    metric = {t: 'success' for t in TASKS}
    mlabel = {'success': 'succ.', 'score': 'score'}
    mlabel_html = {'success': '%', 'score': 'score'}
    best = {}
    for t in TASKS:
        cands = [c for c in MAIN if c != 'oracle' and (c, t) in stats]
        if cands:
            best[(t, 'q')] = max(stats[(c, t)][metric[t]][0] for c in cands)
            best[(t, 'time')] = min(stats[(c, t)]['time'][0] for c in cands)

    # LaTeX
    L = []
    L.append('\\setlength{\\tabcolsep}{4pt}')
    L.append('\\begin{tabular}{l' + 'rr' * len(TASKS) + 'r}')
    L.append('\\toprule')
    L.append(' & ' + ' & '.join(f'\\multicolumn{{2}}{{c}}{{{TASK_NAME[t]}}}' for t in TASKS) + ' & Sent \\\\')
    L.append(''.join(f'\\cmidrule(lr){{{2 + 2 * i}-{3 + 2 * i}}}' for i in range(len(TASKS))) )
    L.append('Condition & ' + ' & '.join(f'{mlabel[metric[t]]} & time' for t in TASKS) + ' & per ep. \\\\')
    L.append('\\midrule')
    for c in MAIN:
        if c == 'oracle':
            L.append('\\midrule')
        cells = []
        for t in TASKS:
            s = stats.get((c, t))
            if not s:
                cells += ['–', '–']; continue
            q = s[metric[t]][0] * 100
            tm = s['time'][0]
            qs = f'{q:.0f}'
            ts = f'{tm:.0f}'
            if c != 'oracle' and abs(s[metric[t]][0] - best[(t, 'q')]) < 1e-9:
                qs = f'\\textbf{{{qs}}}'
            if c != 'oracle' and abs(tm - best[(t, 'time')]) < 1e-9:
                ts = f'\\textbf{{{ts}}}'
            cells += [qs, ts]
        cells += [tex_bytes(fmt_bytes(stats[(c, 'bytes_mean')]))]
        L.append(f'{NAME[c]} & ' + ' & '.join(cells) + ' \\\\')
    L.append('\\bottomrule')
    L.append('\\end{tabular}')
    open(R('tables', 'main.tex'), 'w').write('\n'.join(L) + '\n')

    # HTML
    H = ['<table class="booktabs">', '<thead><tr><th></th>' + ''.join(f'<th colspan="2" style="text-align:center">{TASK_NAME[t]}</th>' for t in TASKS) + '<th>sent</th></tr>',
         '<tr><th>Condition</th>' + ''.join(f'<th>{mlabel_html[metric[t]]}</th><th>s</th>' for t in TASKS) + '<th></th></tr></thead><tbody>']
    for c in MAIN:
        cells = []
        for t in TASKS:
            s = stats.get((c, t))
            if not s:
                cells += ['<td>–</td>', '<td>–</td>']; continue
            q, tm = s[metric[t]][0], s['time'][0]
            qc = ' class="best"' if c != 'oracle' and abs(q - best[(t, 'q')]) < 1e-9 else ''
            tc = ' class="best"' if c != 'oracle' and abs(tm - best[(t, 'time')]) < 1e-9 else ''
            cells += [f'<td{qc}>{q * 100:.0f}</td>', f'<td{tc}>{tm:.0f}</td>']
        cells += [f'<td>{fmt_bytes(stats[(c, "bytes_mean")])}</td>']
        cls = ' class="group"' if c == 'oracle' else ''
        H.append(f'<tr{cls}><td>{NAME[c]}</td>' + ''.join(cells) + '</tr>')
    H.append('</tbody></table>')
    open(R('tables', 'main.html'), 'w').write('\n'.join(H) + '\n')
    return stats


def verify_table(rows, N):
    """Merge quality and task success by team size for the three merge variants."""
    conds = ['shared_opt', 'shared_noenc', 'shared_noverify']
    main = [r for r in rows if r['grid'] == 'main']
    out = {}
    for c in conds:
        for n in (2, 4, 8):
            sel = [r for r in main if r['condition'] == c and r['n'] == n and ok(r)]
            wrong = [1.0 if ((r.get('merge_wrong_links') or 0) + (r.get('merge_wrong_frames') or 0)) > 0 else 0.0 for r in sel]
            err = [r['target_pos_err_m'] for r in sel if r['task'] in ('fetch', 'rendezvous') and r.get('target_pos_err_m') is not None]
            out[(c, n)] = {'episodes': len(sel), 'wrong_merge_eps': float(np.mean(wrong)),
                           'wrong_links_per_ep': float(np.mean([r.get('merge_wrong_links') or 0 for r in sel])),
                           'joined': float(np.mean([(r.get('merge_joined') or 0) / r['n'] for r in sel])),
                           'success': float(np.mean([1.0 if succ_of(r) else 0.0 for r in sel])),
                           'time': float(np.mean([r['time_s'] for r in sel if r['task'] != 'inventory'])),
                           'err_median_m': float(np.median(err)) if err else float('nan')}
    N['verify'] = {f'{c}|{n}': v for (c, n), v in out.items()}
    L = ['\\setlength{\\tabcolsep}{3pt}', '\\begin{tabular}{lrrrrrrrrr}', '\\toprule',
         ' & \\multicolumn{3}{c}{Wrong merge (\\%)} & \\multicolumn{3}{c}{Robots joined (\\%)} & \\multicolumn{3}{c}{Success (\\%)} \\\\',
         '\\cmidrule(lr){2-4}\\cmidrule(lr){5-7}\\cmidrule(lr){8-10}',
         'Team size & 2 & 4 & 8 & 2 & 4 & 8 & 2 & 4 & 8 \\\\', '\\midrule']
    H = ['<table class="booktabs">', '<thead><tr><th></th><th colspan="3" style="text-align:center">Episodes with a wrong merge (%)</th><th colspan="3" style="text-align:center">Robots joined (%)</th><th colspan="3" style="text-align:center">Task success (%)</th></tr>',
         '<tr><th>Team size</th>' + '<th>2</th><th>4</th><th>8</th>' * 3 + '</tr></thead><tbody>']
    vname = {'shared_opt': 'Checks + meetings', 'shared_noenc': 'Checks only', 'shared_noverify': 'Neither'}
    for c in conds:
        cells = [f"{out[(c, n)][k] * 100:.0f}" for k in ('wrong_merge_eps', 'joined', 'success') for n in (2, 4, 8)]
        L.append(f'{vname[c]} & ' + ' & '.join(cells) + ' \\\\')
        H.append(f'<tr><td>{vname[c]}</td>' + ''.join(f'<td>{x}</td>' for x in cells) + '</tr>')
    L += ['\\bottomrule', '\\end{tabular}']
    H.append('</tbody></table>')
    open(R('tables', 'verify.tex'), 'w').write('\n'.join(L) + '\n')
    open(R('tables', 'verify.html'), 'w').write('\n'.join(H) + '\n')


# --------------------------------------------------------------------- figures
def save(fig, name):
    fig.savefig(R('figs', name + '.pdf'), bbox_inches='tight', pad_inches=0.02)
    fig.savefig(R('figs', name + '.png'), bbox_inches='tight', pad_inches=0.02, dpi=300)
    plt.close(fig)


def bar(ax, x, h, lo, hi, c, w):
    ax.bar(x, h, width=w, color=COL[c], edgecolor=EDGE.get(c, 'white'), linewidth=0.7 if c in EDGE else 0.6,
           hatch='//////' if c == 'oracle' else None, zorder=2)
    ax.errorbar(x, h, yerr=[[h - lo], [hi - h]], fmt='none', ecolor=INK2, elinewidth=0.7, capsize=1.6, capthick=0.7, zorder=3)


def fig_time(rows, N):
    """Completion time per task and condition (mean, 95% CI)."""
    main = [r for r in rows if r['grid'] == 'main']
    tasks = [t for t in TASKS if t != 'inventory']   # inventory is answered from memory when sharing (time 0)
    fig, axes = plt.subplots(1, len(tasks), figsize=(7.1, 1.75), sharey=False)
    w = 0.16
    for ax, t in zip(axes, tasks):
        for i, c in enumerate(MAIN):
            m, lo, hi = mean_ci([r['time_s'] for r in main if r['condition'] == c and r['task'] == t and ok(r)])
            bar(ax, i * (w + 0.02), m, lo, hi, c, w)
        ax.set_title(TASK_NAME[t], pad=3)
        ax.set_xticks([])
        ax.yaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
        ax.set_axisbelow(True)
        ax.spines['bottom'].set_color(INK2)
    axes[0].set_ylabel('completion time (s)')
    handles = [plt.Rectangle((0, 0), 1, 1, facecolor=COL[c], edgecolor=EDGE.get(c, COL[c]), hatch='//////' if c == 'oracle' else None, linewidth=0.7) for c in MAIN]
    fig.legend(handles, [SHORT[c] for c in MAIN], loc='lower center', ncol=len(MAIN), frameon=False, bbox_to_anchor=(0.5, -0.08), handlelength=1.2, columnspacing=1.4)
    fig.subplots_adjust(wspace=0.38, bottom=0.12)
    save(fig, 'time_by_task')


def fig_scaling(rows, N):
    """Rendezvous vs team size (office + hospital, seeds 1-3: 6 episodes per point)."""
    sel = [r for r in rows if r['task'] in ('fetch', 'rendezvous') and r['scene'] in ('office', 'hospital') and ok(r)
           and (r['grid'] == 'scaling' or (r['grid'] == 'main' and r['seed'] <= 3))]
    ns = sorted({r['n'] for r in sel})
    conds = ['alone', 'language', 'shared_noopt', 'shared_opt']
    fig, axes = plt.subplots(1, 2, figsize=(3.45, 1.55))
    marker = {'alone': 'o', 'language': 's', 'shared_noopt': '^', 'shared_opt': 'D'}
    style = {'shared_noopt': (0, (3, 1.5))}
    res = {}
    for ax, (metric, ylab) in zip(axes, (('time_s', 'time (s)'), ('success', 'all robots arrive (%)'))):
        for c in conds:
            xs, ys = [], []
            for n in ns:
                v = [(r[metric] if metric == 'time_s' else 100.0 * bool(r['success'])) for r in sel if r['task'] == 'rendezvous' and r['condition'] == c and r['n'] == n]
                if v:
                    xs.append(n); ys.append(float(np.mean(v)))
            res[f'rendezvous|{metric}|{c}'] = dict(zip(map(str, xs), ys))
            ax.plot(xs, ys, color=COL[c], linewidth=1.5, linestyle=style.get(c, '-'), marker=marker[c], markersize=3.4, markeredgecolor='white', markeredgewidth=0.5, zorder=3 if c != 'shared_noopt' else 4)
        for c in conds:   # fetch numbers for the text
            res[f'fetch|time_s|{c}'] = {str(n): float(np.mean([r['time_s'] for r in sel if r['task'] == 'fetch' and r['condition'] == c and r['n'] == n] or [float('nan')])) for n in ns}
        ax.set_xticks(ns)
        ax.set_xlabel('robots', labelpad=1)
        ax.set_ylabel(ylab, labelpad=2)
        ax.yaxis.grid(True, color=GRID, linewidth=0.6, zorder=0)
        ax.set_axisbelow(True)
        ax.set_ylim(bottom=0, top=105 if metric == 'success' else None)
    fig.suptitle('Rendezvous, by team size', fontsize=8, y=1.02)
    handles = [plt.Line2D([0], [0], color=COL[c], marker=marker[c], markersize=3.4, markeredgecolor='white', linewidth=1.5, linestyle=style.get(c, '-')) for c in conds]
    fig.legend(handles, [SHORT[c] for c in conds], loc='lower center', ncol=4, frameon=False, bbox_to_anchor=(0.5, -0.2), handlelength=1.8, columnspacing=0.9)
    fig.subplots_adjust(wspace=0.42, bottom=0.27)
    N['scaling'] = res
    save(fig, 'scaling')


def fig_scenes(rows, N):
    """Per-scene fetch+rendezvous time, Language vs Map + opt (paired), as relative reduction."""
    main = [r for r in rows if r['grid'] == 'main']
    out = {}
    for s in SCENES:
        sub = [r for r in main if r['scene'] == s]
        for a, b in (('alone', 'language'), ('language', 'shared_opt'), ('alone', 'shared_opt')):
            va, vb = paired(sub, a, b)
            out[f'{s}|{a}>{b}'] = list(reduction_ci(va, vb))
    N['scene_reduction'] = out


def headline(rows, N):
    main = [r for r in rows if r['grid'] == 'main']
    H = {}
    for a, b in (('alone', 'language'), ('language', 'shared_opt'), ('alone', 'shared_opt'), ('shared_noopt', 'shared_opt'), ('shared_opt', 'oracle'), ('language', 'shared_noopt')):
        for t in TASKS + [None]:
            if t == 'inventory':
                continue
            va, vb = paired(main, a, b, task=t)
            H[f'time|{a}>{b}|{t or "all"}'] = list(reduction_ci(va, vb)) + [int(len(va))]
            va, vb = paired(main, a, b, metric='distance_m', task=t)
            H[f'dist|{a}>{b}|{t or "all"}'] = list(reduction_ci(va, vb)) + [int(len(va))]
    # aggregation ablation (inventory/dispatch): sum vs max
    abl = [r for r in rows if r['grid'] == 'ablation' and ok(r)]
    base = {episode_key(r): r for r in main if r['condition'] == 'language' and r['task'] in ('inventory', 'dispatch') and ok(r)}
    for t in ('inventory', 'dispatch'):
        pairs = [(base[episode_key(r)], r) for r in abl if r['task'] == t and episode_key(r) in base]
        if pairs:
            H[f'agg|{t}'] = {'max_score': float(np.mean([p[0]['score'] for p in pairs])), 'sum_score': float(np.mean([p[1]['score'] for p in pairs])),
                             'max_time': float(np.mean([p[0]['time_s'] for p in pairs])), 'sum_time': float(np.mean([p[1]['time_s'] for p in pairs])), 'n': len(pairs)}
    # language grounding failures
    lang = [r for r in main if r['condition'] == 'language' and ok(r)]
    H['lang_room_misses_per_ep'] = float(np.mean([r.get('room_misses') or 0 for r in lang])) if lang else None
    H['lang_fallback_rate'] = float(np.mean([1.0 if (r.get('fallback_explore') or 0) > 0 else 0.0 for r in lang])) if lang else None
    H['episodes_total'] = len(rows)
    H['episodes_main'] = len(main)
    H['errors'] = sum(1 for r in rows if not ok(r))
    N['headline'] = H


def main():
    rows = load()
    os.makedirs(R('tables'), exist_ok=True)
    N = {}
    main_table(rows, N)
    verify_table(rows, N)
    fig_time(rows, N)
    fig_scaling(rows, N)
    fig_scenes(rows, N)
    headline(rows, N)
    json.dump(N, open(R('results', 'paper_numbers.json'), 'w'), indent=1, default=float)
    c = collections.Counter((r['grid'], r['condition']) for r in rows)
    print(len(rows), 'episodes;', dict(c))


if __name__ == '__main__':
    main()
