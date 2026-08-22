#!/usr/bin/env python3
"""Render what each proposed pose actually sees — the only real check on framing.
Point-splat rasteriser over the gaussian centres; no GPU, no viewer needed."""
import json, math
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

J = json.load(open("./scene.json"))
S, FLOOR = J["scale_m_per_unit"], J["floor_raw_y"]
X = np.load("./xyz.npy").astype(np.float32)
C = np.clip(0.5 + 0.28209479*np.load("./sh0.npy").astype(np.float32), 0, 1)
M = np.stack([X[:, 0]*S, (FLOOR - X[:, 1])*S, X[:, 2]*S], 1)
k = (np.abs(M[:, 0]) < 12) & (np.abs(M[:, 2]) < 12) & (M[:, 1] > -0.3) & (M[:, 1] < 3.2)
M, C = M[k], C[k]
print(f"{len(M):,} points")

W, H, VFOV = 384, 216, math.radians(42)
FY = (H/2) / math.tan(VFOV/2)
FX = FY

def to_m(p):
    return np.array([p[0]*S, (FLOOR - p[1])*S, p[2]*S])

def render(pos, tgt, gain=2.5, gamma=0.75):
    f = tgt - pos; f /= np.linalg.norm(f)
    r = np.cross(f, [0, 1, 0]); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    d = M - pos
    cam = np.stack([d @ r, d @ u, d @ f], 1)
    z = cam[:, 2]
    m = z > 0.12
    cam, col, z = cam[m], C[m], z[m]
    px = (W/2 + FX*cam[:, 0]/z).astype(np.int32)
    py = (H/2 - FY*cam[:, 1]/z).astype(np.int32)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    px, py, z, col = px[ok], py[ok], z[ok], col[ok]
    o = np.argsort(-z)                                    # far to near; near overwrite
    px, py, col, z = px[o], py[o], col[o], z[o]
    img = np.zeros((H, W, 3), np.float32)
    hit = np.zeros((H, W), bool)
    img[py, px] = col
    hit[py, px] = True
    # one dilation pass so sparse regions don't read as holes
    for _ in range(2):
        miss = ~hit
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src = np.roll(np.roll(img, dy, 0), dx, 1)
            sh = np.roll(np.roll(hit, dy, 0), dx, 1)
            take = miss & sh & ~hit
            img[take] = src[take]; hit |= take
    return np.clip(np.clip(img*gain, 0, 1)**gamma, 0, 1)

heroes = J["heroes"]
n = len(heroes) + 1
cols = 4
rows = math.ceil(n/cols)
fig, axes = plt.subplots(rows, cols, figsize=(4.2*cols, 2.55*rows), facecolor="#fcfcfb")
axes = np.atleast_1d(axes).ravel()

ip = J["initialPose"]
frames = [("opening shot", ip["position"], ip["target"])] + \
         [(f"hero {h['order']} · top {h['top_m']:.2f} m · standoff {h['standoff_m']:.2f} m",
           h["position"], h["target"]) for h in heroes]
for ax, (lab, p, t) in zip(axes, frames):
    ax.imshow(render(to_m(p), to_m(t)))
    ax.set_title(lab, fontsize=8.5, loc="left", color="#0b0b0b", pad=4)
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values(): sp.set_color("#e1e0d9")
for ax in axes[len(frames):]:
    ax.axis("off")
fig.suptitle("autoscene — what each proposed pose sees", fontsize=14, x=0.008, ha="left", y=0.995)
fig.tight_layout(rect=(0, 0, 1, 0.97))
fig.savefig("./previews.png", dpi=135, facecolor="#fcfcfb")
print("wrote previews.png")
