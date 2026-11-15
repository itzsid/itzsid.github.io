# Hivemap communication experiments: summary

Episodes: 3582 (main: 3150, scaling: 252, ablation: 180). Main grid: 6 scenes × team sizes {2,4,8} × 5 tasks × 7 conditions × seeds 1–5. Means over all episodes (failures included, with the time they used). Brackets: 95% bootstrap CI of the mean (2000 resamples). Speed-up = mean time of ALONE / mean time of the condition over the same episodes (paired bootstrap CI).


## fetch

| condition | success | score | time (s) | speed-up vs alone | distance (m) | bytes | messages | grounding errors | target pos. err (m) |
|---|---|---|---|---|---|---|---|---|---|
| Alone | 82% | 0.82 | 207 [174, 245] | 1.0× | 77 | 0 B | 0 | 0.16 | 1.02 |
| Language | 76% | 0.76 | 89 [74, 107] | 2.3× [1.8, 3.0] | 37 | 258 B | 5 | 0.30 | 1.16 |
| Shared map (no opt) | 80% | 0.80 | 30 [28, 32] | 6.9× [5.8, 8.1] | 21 | 247 KiB | 23 | 0.10 | 0.77 |
| Shared map + opt | 96% | 0.96 | 30 [28, 32] | 6.9× [5.8, 8.3] | 21 | 322 KiB | 1272 | 0.01 | 0.26 |
| Oracle map | 98% | 0.98 | 30 [28, 33] | 6.9× [5.7, 8.1] | 21 | 247 KiB | 23 | 0.00 | 0.00 |
| No-verify merge | 64% | 0.64 | 103 [79, 130] | 2.0× [1.6, 2.7] | 75 | 358 KiB | 1754 | 0.33 | 1.65 |
| Verified, no encounters | 86% | 0.86 | 199 [163, 239] | 1.0× [0.9, 1.2] | 129 | 161 KiB | 279 | 0.12 | 0.76 |

## inventory

| condition | success | score | time (s) | speed-up vs alone | distance (m) | bytes | messages | grounding errors | target pos. err (m) | room-level exact |
|---|---|---|---|---|---|---|---|---|---|---|
| Alone | 94% | 0.99 | 380 [343, 420] | 1.0× | 135 | 0 B | 0 | 0.08 | – | 94% |
| Language | 96% | 0.99 | 0 [0, 0] | ∞ (no driving) | 0 | 309 B | 7 | 0.08 | – | 96% |
| Shared map (no opt) | 64% | 0.88 | 0 [0, 0] | ∞ (no driving) | 0 | 247 KiB | 23 | 0.71 | – | 70% |
| Shared map + opt | 89% | 0.97 | 0 [0, 0] | ∞ (no driving) | 0 | 322 KiB | 1272 | 0.22 | – | 90% |
| Oracle map | 98% | 1.00 | 0 [0, 0] | ∞ (no driving) | 0 | 247 KiB | 23 | 0.02 | – | 98% |
| No-verify merge | 36% | 0.45 | 19 [13, 24] | 20.4× [15.7, 28.2] | 39 | 358 KiB | 1754 | 1.54 | – | 44% |
| Verified, no encounters | 30% | 0.59 | 36 [31, 41] | 10.6× [9.3, 12.1] | 72 | 161 KiB | 279 | 1.47 | – | 30% |

## rendezvous

| condition | success | score | time (s) | speed-up vs alone | distance (m) | bytes | messages | grounding errors | target pos. err (m) |
|---|---|---|---|---|---|---|---|---|---|
| Alone | 68% | 0.90 | 408 [349, 468] | 1.0× | 419 | 0 B | 0 | 0.58 | 0.56 |
| Language | 64% | 0.88 | 138 [110, 173] | 2.9× [2.4, 3.7] | 130 | 1444 B | 29 | 0.97 | 0.68 |
| Shared map (no opt) | 84% | 0.93 | 47 [42, 52] | 8.7× [7.5, 9.9] | 75 | 247 KiB | 23 | 0.27 | 0.55 |
| Shared map + opt | 98% | 0.99 | 42 [38, 46] | 9.7× [8.5, 11.0] | 73 | 322 KiB | 1272 | 0.01 | 0.21 |
| Oracle map | 99% | 1.00 | 44 [39, 48] | 9.3× [8.2, 10.6] | 72 | 247 KiB | 23 | 0.00 | 0.00 |
| No-verify merge | 50% | 0.71 | 283 [220, 350] | 1.4× [1.2, 1.8] | 324 | 358 KiB | 1754 | 1.48 | 1.26 |
| Verified, no encounters | 70% | 0.92 | 434 [367, 502] | 0.9× [0.9, 1.0] | 509 | 161 KiB | 279 | 0.53 | 0.58 |

## dispatch

| condition | success | score | time (s) | speed-up vs alone | distance (m) | bytes | messages | grounding errors | target pos. err (m) |
|---|---|---|---|---|---|---|---|---|---|
| Alone | 94% | 0.98 | 47 [42, 52] | 1.0× | 45 | 0 B | 0 | 0.11 | 0.16 |
| Language | 93% | 0.98 | 44 [39, 49] | 1.1× [1.0, 1.1] | 40 | 518 B | 9 | 0.06 | 0.14 |
| Shared map (no opt) | 66% | 0.86 | 29 [26, 33] | 1.6× [1.5, 1.8] | 29 | 247 KiB | 23 | 0.46 | 0.53 |
| Shared map + opt | 84% | 0.95 | 29 [26, 33] | 1.6× [1.5, 1.8] | 29 | 322 KiB | 1272 | 0.17 | 0.26 |
| Oracle map | 92% | 0.98 | 30 [26, 33] | 1.6× [1.5, 1.7] | 29 | 247 KiB | 23 | 0.07 | 0.00 |
| No-verify merge | 34% | 0.45 | 50 [44, 56] | 0.9× [0.8, 1.1] | 69 | 358 KiB | 1754 | 3.54 | 2.51 |
| Verified, no encounters | 29% | 0.58 | 64 [58, 69] | 0.7× [0.6, 0.8] | 96 | 161 KiB | 279 | 3.53 | 0.22 |

## search

| condition | success | score | time (s) | speed-up vs alone | distance (m) | bytes | messages | grounding errors | target pos. err (m) |
|---|---|---|---|---|---|---|---|---|---|
| Alone | 96% | 0.96 | 364 [315, 412] | 1.0× | 121 | 0 B | 0 | 0.03 | 0.70 |
| Language | 98% | 0.98 | 169 [134, 209] | 2.2× [1.7, 2.7] | 101 | 686 B | 10 | 0.02 | 0.32 |
| Shared map (no opt) | 86% | 0.86 | 126 [99, 157] | 2.9× [2.2, 3.8] | 89 | 522 KiB | 47 | 0.12 | 0.63 |
| Shared map + opt | 96% | 0.96 | 126 [99, 157] | 2.9× [2.2, 3.7] | 89 | 691 KiB | 2643 | 0.03 | 0.31 |
| Oracle map | 100% | 1.00 | 127 [101, 157] | 2.9× [2.2, 3.7] | 90 | 522 KiB | 47 | 0.00 | 0.00 |
| No-verify merge | 56% | 0.56 | 151 [123, 184] | 2.4× [2.0, 3.0] | 133 | 817 KiB | 3923 | 0.47 | 2.52 |
| Verified, no encounters | 53% | 0.53 | 178 [149, 211] | 2.0× [1.7, 2.5] | 175 | 416 KiB | 835 | 0.46 | 1.09 |

## Success rate and mean time by team size (main grid)

| task | condition | n=2 success | n=2 time | n=4 success | n=4 time | n=8 success | n=8 time |
|---|---|---|---|---|---|---|---|
| fetch | Alone | 80% | 126 | 83% | 207 | 83% | 288 |
| fetch | Language | 80% | 72 | 77% | 78 | 70% | 118 |
| fetch | Shared map (no opt) | 87% | 24 | 70% | 30 | 83% | 36 |
| fetch | Shared map + opt | 93% | 24 | 97% | 31 | 97% | 36 |
| fetch | Oracle map | 100% | 23 | 97% | 31 | 97% | 36 |
| fetch | No-verify merge | 97% | 42 | 47% | 113 | 50% | 154 |
| fetch | Verified, no encounters | 93% | 57 | 93% | 206 | 70% | 335 |
| inventory | Alone | 97% | 261 | 93% | 411 | 93% | 469 |
| inventory | Language | 93% | 0 | 97% | 0 | 97% | 0 |
| inventory | Shared map (no opt) | 80% | 0 | 60% | 0 | 53% | 0 |
| inventory | Shared map + opt | 90% | 0 | 87% | 0 | 90% | 0 |
| inventory | Oracle map | 97% | 0 | 100% | 0 | 97% | 0 |
| inventory | No-verify merge | 67% | 2 | 17% | 15 | 23% | 39 |
| inventory | Verified, no encounters | 57% | 8 | 10% | 40 | 23% | 60 |
| rendezvous | Alone | 83% | 123 | 70% | 467 | 50% | 633 |
| rendezvous | Language | 83% | 71 | 63% | 142 | 47% | 203 |
| rendezvous | Shared map (no opt) | 87% | 27 | 90% | 44 | 77% | 69 |
| rendezvous | Shared map + opt | 97% | 27 | 97% | 40 | 100% | 59 |
| rendezvous | Oracle map | 100% | 27 | 100% | 40 | 97% | 64 |
| rendezvous | No-verify merge | 83% | 120 | 33% | 249 | 33% | 480 |
| rendezvous | Verified, no encounters | 93% | 60 | 63% | 533 | 53% | 708 |
| dispatch | Alone | 97% | 62 | 97% | 40 | 90% | 39 |
| dispatch | Language | 93% | 59 | 97% | 38 | 90% | 34 |
| dispatch | Shared map (no opt) | 77% | 44 | 67% | 24 | 53% | 19 |
| dispatch | Shared map + opt | 87% | 43 | 83% | 24 | 83% | 20 |
| dispatch | Oracle map | 93% | 44 | 97% | 23 | 87% | 22 |
| dispatch | No-verify merge | 67% | 44 | 17% | 39 | 20% | 67 |
| dispatch | Verified, no encounters | 60% | 46 | 7% | 61 | 20% | 84 |
| search | Alone | 97% | 353 | 93% | 402 | 97% | 336 |
| search | Language | 100% | 184 | 100% | 185 | 93% | 137 |
| search | Shared map (no opt) | 93% | 167 | 83% | 131 | 80% | 81 |
| search | Shared map + opt | 97% | 167 | 100% | 131 | 90% | 81 |
| search | Oracle map | 100% | 168 | 100% | 132 | 100% | 81 |
| search | No-verify merge | 83% | 174 | 40% | 144 | 43% | 135 |
| search | Verified, no encounters | 90% | 190 | 37% | 185 | 33% | 159 |

## Scaling sweep (office + hospital, seeds 1–3): success % / mean time (s)

| task | condition | n=1 | n=2 | n=4 | n=6 | n=8 | n=10 |
|---|---|---|---|---|---|---|---|
| fetch | Alone | 100% / 30 | 67% / 175 | 83% / 216 | 100% / 370 | 67% / 445 | 100% / 282 |
| fetch | Language | 100% / 30 | 67% / 83 | 83% / 52 | 67% / 134 | 83% / 80 | 100% / 79 |
| fetch | Shared map (no opt) | 100% / 30 | 100% / 28 | 83% / 30 | 83% / 32 | 83% / 30 | 83% / 38 |
| fetch | Shared map + opt | 100% / 30 | 100% / 28 | 83% / 31 | 83% / 31 | 83% / 30 | 100% / 38 |
| fetch | Oracle map | 100% / 30 | 100% / 28 | 83% / 31 | 100% / 32 | 100% / 31 | 100% / 40 |
| fetch | No-verify merge | 100% / 30 | 100% / 28 | 33% / 34 | 50% / 242 | 33% / 106 | 50% / 131 |
| fetch | Verified, no encounters | 100% / 30 | 83% / 36 | 83% / 190 | 83% / 416 | 50% / 581 | 100% / 413 |
| rendezvous | Alone | 100% / 32 | 83% / 158 | 83% / 358 | 83% / 503 | 50% / 597 | 33% / 686 |
| rendezvous | Language | 100% / 32 | 83% / 65 | 83% / 78 | 67% / 191 | 50% / 264 | 33% / 526 |
| rendezvous | Shared map (no opt) | 100% / 32 | 100% / 33 | 100% / 50 | 83% / 64 | 83% / 61 | 50% / 124 |
| rendezvous | Shared map + opt | 100% / 32 | 100% / 31 | 100% / 46 | 83% / 60 | 100% / 59 | 83% / 113 |
| rendezvous | Oracle map | 100% / 32 | 100% / 31 | 100% / 45 | 100% / 51 | 100% / 66 | 100% / 109 |
| rendezvous | No-verify merge | 100% / 32 | 100% / 31 | 33% / 46 | 0% / 531 | 17% / 424 | 17% / 570 |
| rendezvous | Verified, no encounters | 100% / 32 | 83% / 38 | 50% / 523 | 33% / 663 | 83% / 751 | 50% / 842 |

## Bytes per channel (main grid, mean per episode, all tasks)

| condition | language text | ≈ tokens (bytes/4) | object descriptors | distributed optimization | total | messages |
|---|---|---|---|---|---|---|
| Alone | 0 B | 0 | 0 KiB | 0 KiB | 0.0 KiB | 0 |
| Language | 643 B | 161 | 0 KiB | 0 KiB | 0.6 KiB | 12 |
| Shared map (no opt) | 0 B | 0 | 302 KiB | 0 KiB | 302.3 KiB | 28 |
| Shared map + opt | 0 B | 0 | 302 KiB | 93 KiB | 395.6 KiB | 1546 |
| Oracle map | 0 B | 0 | 302 KiB | 0 KiB | 302.3 KiB | 28 |
| No-verify merge | 0 B | 0 | 356 KiB | 94 KiB | 450.1 KiB | 2187 |
| Verified, no encounters | 0 B | 0 | 196 KiB | 16 KiB | 212.2 KiB | 391 |

## Map-merge quality (main grid, at the last exchange of each episode)

| condition | robots joined / n | wrong object links | wrong robot frames (>1.5 m) | episodes with ≥1 wrong merge | success (all tasks) | team ATE (m) |
|---|---|---|---|---|---|---|
| Shared map (no opt) | 100% | 0.02 | 0.00 | 2% | 76% | 0.57 |
| Shared map + opt | 100% | 0.02 | 0.00 | 2% | 92% | 0.27 |
| Oracle map | 100% | 0.00 | 0.00 | 0% | 97% | 0.00 |
| Verified, no encounters | 48% | 0.07 | 0.05 | 7% | 54% | 0.31 |
| No-verify merge | 85% | 2.75 | 1.30 | 54% | 48% | 2.78 |

## Language aggregation ablation (per-room max vs naive sum of teammates' counts)

| task | rule | success | score | time (s) | grounding errors | over-count (rooms) | under-count (rooms) |
|---|---|---|---|---|---|---|---|
| inventory | max (default) | 96% | 0.99 | 0 | 0.08 | 0.03 | 0.04 |
| inventory | sum | 68% | 0.99 | 0 | 0.43 | 0.39 | 0.04 |
| dispatch | max (default) | 93% | 0.98 | 44 | 0.06 | – | – |
| dispatch | sum | 90% | 0.97 | 86 | 0.37 | – | – |

## Success rate by scene (main grid, all tasks pooled)

| condition | office | warehouse | home | hospital | retail | labs |
|---|---|---|---|---|---|---|
| Alone | 91% | 89% | 84% | 76% | 96% | 85% |
| Language | 92% | 88% | 77% | 73% | 93% | 88% |
| Shared map (no opt) | 89% | 71% | 80% | 72% | 59% | 85% |
| Shared map + opt | 97% | 87% | 95% | 84% | 100% | 92% |
| Oracle map | 100% | 97% | 95% | 96% | 100% | 96% |
| No-verify merge | 48% | 44% | 60% | 53% | 35% | 48% |
| Verified, no encounters | 65% | 51% | 41% | 49% | 49% | 65% |

## Effect of distributed optimization on target position error (paired shared_noopt vs shared_opt episodes)

| task | paired episodes | mean err no-opt (m) | mean err opt (m) | opt worse by > 0.2 m | opt better by > 0.2 m | success no-opt | success opt |
|---|---|---|---|---|---|---|---|
| fetch | 90 | 0.77 | 0.26 | 8% | 47% | 80% | 96% |
| rendezvous | 90 | 0.55 | 0.21 | 8% | 34% | 84% | 98% |
| dispatch | 90 | 0.53 | 0.26 | 0% | 48% | 66% | 84% |
| search | 90 | 0.63 | 0.31 | 2% | 47% | 86% | 96% |

## Stuck robots: % of episodes with >= 1 stuck leg (job timeout, nav leg ending > 3.5 m from goal, or coverage that never entered its room)

| condition | fetch | inventory | rendezvous | dispatch | search | success excl. stuck episodes (all tasks) | success of stuck episodes |
|---|---|---|---|---|---|---|---|
| Alone | 0% | 0% | 2% | 0% | 0% | 87% (n=448) | 50% (n=2) |
| Language | 4% | 0% | 2% | 0% | 0% | 86% (n=444) | 33% (n=6) |
| Shared map (no opt) | 0% | 0% | 2% | 0% | 0% | 76% (n=448) | 50% (n=2) |
| Shared map + opt | 0% | 0% | 0% | 0% | 0% | 92% (n=450) | – |
| Oracle map | 0% | 0% | 0% | 0% | 0% | 97% (n=450) | – |
| No-verify merge | 2% | 0% | 3% | 1% | 0% | 49% (n=444) | 0% (n=6) |
| Verified, no encounters | 6% | 0% | 2% | 0% | 1% | 54% (n=442) | 12% (n=8) |

## Sanity

- prior fingerprint identical across conditions for every (scene, n, seed, task): yes
- task identical across conditions: yes
- robot collisions (centre distance < 0.5 m while moving): 0; smallest separation seen: 0.551 m
- episodes hitting the 3600 s sim limit or the wall-clock stuck guard: 0 []
- policy exceptions (counted as failures; e.g. goTo 'No path found.' from the existing planner): 0 []
- harness crashes: 0
- episodes where some motion job hit its per-job timeout (robot stuck, job abandoned): 7 {'shared_noverify': 3, 'shared_noopt': 3, 'oracle': 1}
- total CPU time in episodes: 101 min
