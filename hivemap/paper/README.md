# Talk or Map? What Should Robot Teams Share?

Paper source, data, and scripts for the Hivemap study.

| File | What it is |
|---|---|
| `hivemap.tex`, `refs.bib` | LaTeX source (IEEEtran) and verified bibliography |
| `hivemap.pdf` | Compiled paper |
| `index.html`, `paper.css`, `paper.js` | Web version, generated from the LaTeX by `build_html.py` |
| `results/results.jsonl` | One record per episode (3,582 episodes) |
| `results/summary.md` | Per-task tables with bootstrap intervals (`scripts/summarize.py`) |
| `related_work.md` | Literature review behind Section 2 |

## Reproduce

```bash
node scripts/run.mjs --seeds 5 --workers 4      # all episodes -> results/results.jsonl (resumable, ~25 min on 4 cores)
python3 scripts/summarize.py                    # results/summary.md
python3 analyze.py                              # tables/*, figs/time_by_task.*, figs/scaling.*
node scripts/qual.mjs hospital 8 2 fetch alone,language,shared_opt > results/qual.json
python3 plot_qual.py results/qual.json qual     # figs/qual.*
pdflatex hivemap && bibtex hivemap && pdflatex hivemap && pdflatex hivemap
python3 build_html.py                           # index.html (add a path to also write a self-contained copy)
```

Episodes are deterministic for a given scene, team size, seed, task, and condition.
The experiment harness is `../js/experiments.js`; it runs the same simulator as the live demo.
