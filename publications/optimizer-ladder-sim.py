#!/usr/bin/env python3
"""
Offline simulation behind the optimizer-ladder.html speedrun-ladder widgets, on a
deep MLP teacher->student (every parameter is a weight matrix — the natural
habitat for the matrix-aware optimizers).

We record TRAIN loss vs step for the optimizers, best learning rate by lowest
final loss. This is an optimization-SPEED comparison: SGD < momentum < adaptive
< matrix-aware, the ordering the chapters describe. (A small quadratic can't
show this — momentum is near-optimal on quadratics — so the network has to be
genuinely deep.) Adam and AdamW are indistinguishable on training speed, so the
page carries a single adaptive rung (AdamW); AdamW's real edge is generalization,
which a training-speed chart can't show.

One small network, not a benchmark — rankings are problem-dependent. Real
wall-clock records live in modded-nanogpt.

Run:    python3 optimizer-ladder-sim.py
Emits:  optimizer-ladder-data.json
"""
import json
import warnings
import numpy as np

warnings.filterwarnings('ignore', category=RuntimeWarning, message='.*matmul.*')

DIMS = [16, 64, 64, 64, 32, 8]      # 5 weight matrices => genuinely deep

def init_net(rng, scale):
    return [rng.standard_normal((DIMS[i + 1], DIMS[i])) * (scale / np.sqrt(DIMS[i]))
            for i in range(len(DIMS) - 1)]

def forward(params, X):
    h = X; acts = [h]
    for k, W in enumerate(params):
        z = h @ W.T
        h = np.tanh(z) if k < len(params) - 1 else z
        acts.append(h)
    return h, acts

def grads_on(params, Xb, Yb):
    pred, acts = forward(params, Xb)
    delta = (pred - Yb) / len(Xb)
    g = [None] * len(params)
    for k in range(len(params) - 1, -1, -1):
        g[k] = delta.T @ acts[k]
        if k > 0:
            delta = (delta @ params[k]) * (1 - acts[k] ** 2)
    return g

def mse(params, X, Y):
    pred, _ = forward(params, X)
    return 0.5 * np.mean(np.sum((pred - Y) ** 2, axis=1))

def ns5(G, steps=5):
    a, b, c = 3.4445, -4.7750, 2.0315
    X = G.astype(np.float64); tr = X.shape[0] > X.shape[1]
    if tr: X = X.T
    X = X / (np.linalg.norm(X) + 1e-7)
    for _ in range(steps):
        A = X @ X.T; X = a * X + (b * A + c * A @ A) @ X
    return X.T if tr else X

def inv_pth_root(M, p, eps=1e-6):
    w, V = np.linalg.eigh(M)
    return (V * (np.clip(w, eps, None) ** (-1.0 / p))) @ V.T

def downsample(v, T):
    idx = np.unique(np.geomspace(1, T, 70).astype(int) - 1)
    rel = np.clip(v / v[0] if False else v, 1e-9, None)  # caller passes already-relative
    return [[int(i), round(float(rel[i]), 7)] for i in idx]

# =========================================================================
# EXPERIMENT A — train-loss speedrun ladders (no weight decay)
# =========================================================================
def step_opt(kind, W, st, g, j, lr_t, t, wd, R0):
    b1, b2, eps, mu = 0.9, 0.999, 1e-8, 0.9
    s = st[j]
    if kind == 'sgd':
        W[j] -= lr_t * g
    elif kind == 'momentum':
        v = s.get('v', np.zeros_like(g)); v = mu * v + g; s['v'] = v; W[j] -= lr_t * v
    elif kind == 'adam':
        m = s.get('m', np.zeros_like(g)); v = s.get('v', np.zeros_like(g))
        m = b1 * m + (1 - b1) * g; v = b2 * v + (1 - b2) * g * g; s['m'], s['v'] = m, v
        W[j] -= lr_t * (m / (1 - b1 ** (t + 1))) / (np.sqrt(v / (1 - b2 ** (t + 1))) + eps)
    elif kind == 'adamw':
        m = s.get('m', np.zeros_like(g)); v = s.get('v', np.zeros_like(g))
        m = b1 * m + (1 - b1) * g; v = b2 * v + (1 - b2) * g * g; s['m'], s['v'] = m, v
        W[j] -= lr_t * (m / (1 - b1 ** (t + 1))) / (np.sqrt(v / (1 - b2 ** (t + 1))) + eps)
        W[j] -= lr_t * wd * W[j]
    elif kind == 'signsgd':
        W[j] -= lr_t * np.sign(g)
    elif kind == 'lion':
        m = s.get('m', np.zeros_like(g))
        W[j] -= lr_t * (np.sign(0.9 * m + 0.1 * g) + wd * W[j]); s['m'] = 0.99 * m + 0.01 * g   # wd=0 in the no-decay ladder, like AdamW
    elif kind == 'muon':
        u = s.get('u', np.zeros_like(g)); u = mu * u + g; s['u'] = u
        W[j] -= lr_t * ns5(u) * (max(g.shape) / min(g.shape)) ** 0.5
    elif kind == 'shampoo':
        m_, n_ = g.shape
        u = s.get('u', np.zeros_like(g)); u = mu * u + g; s['u'] = u   # momentum, as Shampoo is used in practice
        Lm = s.get('L', np.eye(m_) * 1e-6); Rm = s.get('R', np.eye(n_) * 1e-6)
        Lm = 0.95 * Lm + 0.05 * (g @ g.T); Rm = 0.95 * Rm + 0.05 * (g.T @ g); s['L'], s['R'] = Lm, Rm
        W[j] -= lr_t * (inv_pth_root(Lm, 4) @ u @ inv_pth_root(Rm, 4))   # precondition the smoothed gradient
    elif kind == 'muonh':
        u = s.get('u', np.zeros_like(g)); u = mu * u + g; s['u'] = u
        uhat = ns5(u); U = -lr_t * R0[j] * uhat / (np.linalg.norm(uhat) + 1e-12)
        Wt = W[j] + U; W[j] = R0[j] * Wt / (np.linalg.norm(Wt) + 1e-12)

def lr_sched(lr, t, T, warmup=0.1, decay=0.2):
    """10% linear warmup, constant middle, cosine cooldown over the last 20%."""
    fr = t / T
    if fr < warmup:
        return lr * fr / warmup
    if fr < 1 - decay:
        return lr
    return lr * 0.5 * (1 + np.cos(np.pi * (fr - (1 - decay)) / decay))

def run_train_ladder():
    rng = np.random.default_rng(0)
    teacher = init_net(rng, 1.2)
    N, BATCH, T = 2048, 128, 4000
    X = rng.standard_normal((N, DIMS[0])); Y, _ = forward(teacher, X)
    W0 = init_net(rng, 1.0); R0 = [np.linalg.norm(w) for w in teacher]
    init_loss = mse(W0, X, Y)
    GRID = {'sgd': [3e-2, 1e-1, 3e-1, 1.0, 3.0], 'momentum': [1e-2, 3e-2, 1e-1, 3e-1, 1.0],
            'adam': [1e-3, 3e-3, 1e-2, 3e-2, 1e-1], 'adamw': [1e-3, 3e-3, 1e-2, 3e-2, 1e-1],
            'signsgd': [3e-4, 1e-3, 3e-3, 1e-2, 3e-2], 'lion': [1e-4, 3e-4, 1e-3, 3e-3, 1e-2],
            'muon': [1e-3, 3e-3, 1e-2, 3e-2, 1e-1], 'shampoo': [1e-3, 3e-3, 1e-2, 3e-2, 1e-1],
            'muonh': [3e-3, 1e-2, 3e-2, 1e-1, 3e-1]}
    order = ['sgd', 'momentum', 'adam', 'adamw', 'signsgd', 'lion', 'muon', 'shampoo', 'muonh']
    def trial(kind, lr):
        W = [w.copy() for w in W0]; st = [dict() for _ in W]; losses = []
        for t in range(T):
            lr_t = lr_sched(lr, t, T)
            grads = grads_on(W, *(lambda i: (X[i], Y[i]))(rng.integers(0, N, BATCH)))
            for j, g in enumerate(grads):
                step_opt(kind, W, st, g, j, lr_t, t, 0.0, R0)
            losses.append(mse(W, X, Y))
            if not all(np.isfinite(w).all() for w in W):
                losses += [losses[-1]] * (T - len(losses)); break
        return np.array(losses)
    runs = {}
    for kind in order:
        best = None
        for lr in GRID[kind]:
            v = trial(kind, lr); fin = float(np.min(v[-50:]))
            if best is None or fin < best[0]: best = (fin, lr, v)
        fin, lr, v = best
        runs[kind] = {'lr': lr, 'curve': downsample(v / init_loss, T), 'final_rel': round(fin / init_loss, 7)}
        print(f"[train] {kind:9s} lr={lr:<7} final_rel={fin/init_loss:.4g}")
    json.dump({'meta': {'T': T, 'dims': DIMS, 'metric': 'train_loss'}, 'order': order, 'runs': runs},
              open('optimizer-ladder-data.json', 'w'), indent=0)
    print("wrote optimizer-ladder-data.json")

if __name__ == '__main__':
    run_train_ladder()
