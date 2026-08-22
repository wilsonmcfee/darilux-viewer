#!/usr/bin/env python3
"""Decode SOG v2 (PlayCanvas / LichtFeld Studio) means into an XYZ point cloud."""
import json, sys
import numpy as np
from PIL import Image

# Defaults to the viewer's own committed Bluedio bundle, which is ALREADY an
# unpacked SOG directory — so the pipeline runs with no unzip step and no setup.
# Pass another directory to decode a different scene:
#     python decode_sog.py ../public/splat/common-room
D = sys.argv[1] if len(sys.argv) > 1 else "../public/splat/bluedio"
meta = json.load(open(f"{D}/meta.json"))
n = meta["count"]
mins = np.array(meta["means"]["mins"], dtype=np.float64)
maxs = np.array(meta["means"]["maxs"], dtype=np.float64)

lo = np.asarray(Image.open(f"{D}/means_l.webp").convert("RGBA"), dtype=np.uint16)
hi = np.asarray(Image.open(f"{D}/means_u.webp").convert("RGBA"), dtype=np.uint16)
print("texture shape:", lo.shape, "count:", n, file=sys.stderr)

# 16-bit value per channel: low byte from means_l, high byte from means_u
v = (lo[..., :3].astype(np.uint32) | (hi[..., :3].astype(np.uint32) << 8))
v = v.reshape(-1, 3)[:n].astype(np.float64) / 65535.0

# lerp into log-space bounds, then invert the signed-log transform
logv = mins + v * (maxs - mins)
xyz = np.sign(logv) * (np.exp(np.abs(logv)) - 1.0)

np.save("./xyz.npy", xyz.astype(np.float32))

# also grab sh0 base color (DC term) for later saliency work
sh0_img = np.asarray(Image.open(f"{D}/sh0.webp").convert("RGBA"))
cb = np.array(meta["sh0"]["codebook"], dtype=np.float32)
sh0 = cb[sh0_img.reshape(-1, 4)[:n, :3]]
np.save("./sh0.npy", sh0.astype(np.float32))

print(f"decoded {len(xyz):,} points")
print("raw bbox min:", np.round(xyz.min(0), 3), " max:", np.round(xyz.max(0), 3))
for p in (0.1, 1, 5, 50, 95, 99, 99.9):
    print(f"  p{p:<5} {np.round(np.percentile(xyz, p, axis=0), 3)}")
core = np.all(np.abs(xyz) < 20, axis=1)
print(f"points within |20| of origin: {core.sum():,} ({100*core.mean():.1f}%)")
