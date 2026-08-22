#!/usr/bin/env python3
"""Derive hero-point ANCHORS from authored poses by ray-marching the point cloud.

The in-browser path (?author + __logAnchor()) is the primary one and lets you
judge each dot by eye. This is the bulk alternative: given the poses you already
authored, it finds where each view ray first meets real geometry and emits an
anchor sitting on that surface, ready to paste into demos.ts.

Why an anchor is needed at all: __logPose() reports `target` as a look-at point a
fixed ~0.6 m ahead of the camera, which is empty air. A dot pinned there is
correct in world space but slides across the object as the camera dollies.

Input  poses.json, WORLD coordinates as they appear in demos.ts:
         [{"id": "juno-6",
           "position": [5.035, 1.887, 3.418],
           "target":   [5.114, 0.984, 5.004]}, ...]

Usage  python anchors.py poses.json            # needs xyz.npy from decode_sog.py
       python anchors.py poses.json --radius 0.08 --min-pts 10

Output one `anchor: [x, y, z],` line per hero in WORLD coordinates, plus a table
of hit distances so an outlier is obvious. A hit much further out than the others
usually means that pose's frame centre passes over its subject rather than onto
it — worth re-authoring rather than pasting.
"""
import argparse
import json
import sys

import numpy as np
from scipy.spatial import cKDTree

# Must match the contract in autoscene.py.
S = 1.0 / 3.0     # .sog units -> metres
FLOOR_RAW = 4.20  # .sog y of the floor plane

# main.ts rolls every splat entity 180 deg about Z, so a raw point (x, y, z) is
# at (-x, -y, z) in the viewer's world space. These two convert across that roll
# AND the metric rescale in one step.
def world_to_m(p):
    """demos.ts world coords -> internal metres, Y-up, floor at 0."""
    return np.array([-p[0] * S, (FLOOR_RAW + p[1]) * S, p[2] * S])


def m_to_world(q):
    """internal metres -> demos.ts world coords."""
    return np.array([-q[0] / S, q[1] / S - FLOOR_RAW, q[2] / S])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("poses", help="JSON list of {id, position, target} in world coords")
    ap.add_argument("--xyz", default="./xyz.npy", help="decode_sog.py output")
    ap.add_argument("--radius", type=float, default=0.08,
                    help="sample radius when testing for a surface (m)")
    ap.add_argument("--min-pts", type=int, default=10,
                    help="gaussians within radius that count as a surface")
    ap.add_argument("--step", type=float, default=0.01, help="march step (m)")
    ap.add_argument("--max-dist", type=float, default=6.0, help="give up after (m)")
    a = ap.parse_args()

    poses = json.load(open(a.poses))

    X = np.load(a.xyz).astype(np.float64)
    M = np.stack([X[:, 0] * S, (FLOOR_RAW - X[:, 1]) * S, X[:, 2] * S], 1)
    # Same clip as the rest of the pipeline: drop far floaters and anything
    # below the floor or above the ceiling, so they cannot trigger a false hit.
    M = M[(np.abs(M[:, 0]) < 12) & (np.abs(M[:, 2]) < 12)
          & (M[:, 1] > -0.25) & (M[:, 1] < 4.0)]
    tree = cKDTree(M)
    print(f"{len(M):,} gaussians in the search set\n", file=sys.stderr)

    print(f"{'id':26s} {'hit@m':>6} {'height':>7} {'pts':>5}")
    lines, misses = [], []
    for h in poses:
        P = world_to_m(h["position"])
        T = world_to_m(h["target"])
        d = T - P
        n = np.linalg.norm(d)
        if n < 1e-9:
            misses.append(h["id"])
            continue
        d /= n

        hit = None
        for s in np.arange(0.12, a.max_dist, a.step):
            q = P + d * s
            k = len(tree.query_ball_point(q, a.radius))
            if k >= a.min_pts:
                hit = (s, q, k)
                break

        if hit is None:
            print(f"{h['id']:26s} {'MISS':>6}")
            misses.append(h["id"])
            continue

        s, q, k = hit
        w = m_to_world(q)
        print(f"{h['id']:26s} {s:6.2f} {q[1]:7.2f} {k:5d}")
        lines.append((h["id"], f"        anchor: [{w[0]:.3f}, {w[1]:.3f}, {w[2]:.3f}],"))

    print("\n// paste into the matching hero in demos.ts")
    for hid, line in lines:
        print(f"{line:<52s} // {hid}")

    if misses:
        print(f"\n!! no surface found for: {', '.join(misses)}", file=sys.stderr)
        print("   Either the pose aims at empty space, or --min-pts is too high "
              "for a sparse region. Author these by hand with __logAnchor().",
              file=sys.stderr)


if __name__ == "__main__":
    main()
