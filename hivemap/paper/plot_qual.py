#!/usr/bin/env python3
"""Qualitative figure: one episode under Alone / Language / Map + opt.

    node scripts/qual.mjs hospital 4 2 fetch alone,language,shared_opt > results/qual.json
    python3 plot_qual.py results/qual.json
"""
import json
import os
import re
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = os.path.dirname(os.path.abspath(__file__))
for f in font_manager.findSystemFonts():
    if 'Inter' in os.path.basename(f):
        font_manager.fontManager.addfont(f)
plt.rcParams.update({'font.family': 'Inter', 'font.size': 7, 'savefig.dpi': 300, 'pdf.fonttype': 42})
COL = {'alone': '#9a9893', 'language': '#eb6834', 'shared_noopt': '#1baf7a', 'shared_opt': '#2a78d6'}
NAME = {'alone': 'Alone', 'language': 'Language', 'shared_noopt': 'Map (merge only)', 'shared_opt': 'Map + opt.'}
INK, INK2 = '#1b1b1b', '#6b6a66'


def main(path, out='qual'):
    d = json.load(open(path))
    conds = list(d['runs'])
    W, H = d['w'], d['h']
    fig, axes = plt.subplots(1, len(conds), figsize=(7.1, 7.1 / len(conds) * H / W + 0.55))
    for ax, c in zip(axes, conds):
        run = d['runs'][c]
        for q in d['rooms']:
            ax.text((q['x0'] + q['x1']) / 2, (q['y0'] + q['y1']) / 2, q['name'].replace('Room ', '').replace('Nurse station', 'Nurse\nstation'), ha='center', va='center', fontsize=5, color='#b5b4ae', zorder=1)
        for w in d['walls']:
            ax.plot([w[0], w[2]], [w[1], w[3]], color='#4a4a47', linewidth=0.9, solid_capstyle='butt', zorder=2)
        ox = [o['x'] for o in d['objects'] if o['cat'] != 'door']
        oy = [o['y'] for o in d['objects'] if o['cat'] != 'door']
        ax.scatter(ox, oy, s=2.5, color='#c9c8c2', zorder=2, linewidths=0)
        for r, p in enumerate(run['paths']):
            if r == 0 or len(p) < 2:
                continue
            ax.plot([a[0] for a in p], [a[1] for a in p], color=COL[c], alpha=0.28, linewidth=0.6, zorder=3)
        p = run['paths'][0]
        ax.plot([a[0] for a in p], [a[1] for a in p], color=COL[c], linewidth=1.5, zorder=4, solid_capstyle='round')
        ax.scatter([p[0][0]], [p[0][1]], s=14, color='white', edgecolors=COL[c], linewidths=1.1, zorder=5)
        t = run['target']
        if t:
            ax.scatter([t['x']], [t['y']], s=55, marker='*', color='#f2b705', edgecolors=INK, linewidths=0.5, zorder=6)
        ax.set_xlim(-0.3, W + 0.3)
        ax.set_ylim(H + 0.3, -0.3)   # same orientation as the 3D view / floor plans in the demo
        ax.set_aspect('equal')
        ax.axis('off')
        status = '' if run['success'] else ' · failed'
        ax.set_title(f"{NAME[c]}  ·  {run['time_s']} s, {run['distance_m']:.0f} m{status}", fontsize=7.5, color=INK, pad=3, loc='left', fontweight='bold')
    fig.subplots_adjust(wspace=0.06, left=0.005, right=0.995, top=0.86, bottom=0.02)
    fig.savefig(os.path.join(HERE, 'figs', out + '.pdf'), bbox_inches='tight', pad_inches=0.02)
    fig.savefig(os.path.join(HERE, 'figs', out + '.png'), bbox_inches='tight', pad_inches=0.02)
    print('task:', d['runs'][conds[0]]['task_text'])
    for c in conds:
        print(c, d['runs'][c]['time_s'], d['runs'][c]['distance_m'], d['runs'][c]['success'], [l for l in d['runs'][c]['log'] if 'msg' in l][:4])


if __name__ == '__main__':
    main(*sys.argv[1:])
