#!/usr/bin/env python3
"""Diagnostic plan: what autoscene actually decided."""
import json
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap

G = np.load("./grids.npz")
J = json.load(open("./scene.json"))
S, FLOOR = J["scale_m_per_unit"], J["floor_raw_y"]
cell, x0, z0 = float(G["cell"]), float(G["x0"]), float(G["z0"])
solid, outer, walk, sal, top = (G[k] for k in ("solid", "outer", "walk", "sal", "top"))
nx, nz = solid.shape
ext = [x0, x0 + nx*cell, z0, z0 + nz*cell]

SURF, INK, INK2, MUTED = "#fcfcfb", "#0b0b0b", "#52514e", "#898781"
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
SEQ = LinearSegmentedColormap.from_list("s", ["#fcfcfb", "#cde2fb", "#86b6ef", "#3987e5", "#0d366b"])

fig, ax = plt.subplots(1, 3, figsize=(19, 7), facecolor=SURF)

def base(a, t, sub=""):
    a.set_aspect("equal"); a.set_facecolor(SURF)
    a.set_title(t, fontsize=11.5, loc="left", color=INK, pad=8)
    if sub: a.text(0, 1.02, sub, transform=a.transAxes, fontsize=9, color=MUTED)
    a.set_xlabel("x (m)", fontsize=9, color=INK2); a.set_ylabel("z (m)", fontsize=9, color=INK2)
    a.tick_params(colors=MUTED, labelsize=8)

base(ax[0], "Occupancy & room", "grey = solid at 0.30–1.70 m · blue = room plan area")
ax[0].imshow(np.where(outer, 0.35, 0).T, origin="lower", extent=ext, cmap=SEQ, vmin=0, vmax=1)
ax[0].imshow(np.where(solid, 1.0, np.nan).T, origin="lower", extent=ext,
             cmap=LinearSegmentedColormap.from_list("g", ["#52514e", "#52514e"]), alpha=0.85)

base(ax[1], "Walk envelope", f"{J['walkable_m2']} m² of {J['room_m2']} m² · 0.50 m wall inset")
ax[1].imshow(np.where(outer, 0.25, 0).T, origin="lower", extent=ext, cmap=SEQ, vmin=0, vmax=1)
ov = np.zeros(walk.shape + (4,)); ov[walk] = (0.106, 0.686, 0.478, 0.75)
ax[1].imshow(np.transpose(ov, (1, 0, 2)), origin="lower", extent=ext)

base(ax[2], "Saliency & hero points", "brighter = denser, more colourful, taller gear")
ax[2].imshow(sal.T, origin="lower", extent=ext, cmap=SEQ,
             vmin=0, vmax=np.percentile(sal[sal > 0], 99) if (sal > 0).any() else 1)
for h in J["heroes"]:
    px, pz = h["position"][0]*S, h["position"][2]*S
    tx, tz = h["target"][0]*S, h["target"][2]*S
    ax[2].annotate("", xy=(tx, tz), xytext=(px, pz),
                   arrowprops=dict(arrowstyle="-|>", color=ORANGE, lw=1.6, shrinkA=3, shrinkB=2))
    ax[2].plot([px], [pz], "o", ms=6, mfc=SURF, mec=ORANGE, mew=1.6)
    ax[2].annotate(str(h["order"]), (px, pz), fontsize=8.5, color=ORANGE,
                   ha="center", va="center", fontweight="bold")
ip = J["initialPose"]
ax[2].plot([ip["position"][0]*S], [ip["position"][2]*S], "*", ms=17, color=AQUA,
           mec=SURF, mew=0.8, zorder=5)
ax[2].annotate("opening shot", (ip["position"][0]*S, ip["position"][2]*S),
               xytext=(8, -13), textcoords="offset points", fontsize=8.5, color="#0f7a55")

for a in ax:
    for sp in a.spines.values(): sp.set_color("#e1e0d9")
fig.suptitle("autoscene — Bluedio", fontsize=15, x=0.012, ha="left", y=0.97, color=INK)
fig.tight_layout(rect=(0, 0, 1, 0.94))
fig.savefig("./plan.png", dpi=140, facecolor=SURF)
print("wrote plan.png")
