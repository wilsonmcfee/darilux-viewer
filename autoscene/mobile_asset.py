#!/usr/bin/env python3
"""mobile_asset.py — build the reduced gaussian set for the phone build.

WHY THIS EXISTS, AND WHY IT IS NOT JUST A splat-transform FLAG
--------------------------------------------------------------
The shipped Bluedio bundle is 2,534,528 gaussians. On a phone that falls back
to WebGL2 — an older device, or any in-app browser wrapping WKWebView — the
depth sort runs on the CPU and is LINEAR in that count. Measured on a fast
desktop it costs 20 ms per sort; a phone CPU is several times slower on this
particular workload, because the hot part is a fully random 10 MB scatter that
misses every cache level. When a sort takes longer than a frame the depth order
is stale by the time it lands, and the picture does not merely run slow — it
swims. No resolution or fill setting touches that. Only the count does.

The two costs are ORTHOGONAL, which is the thing most likely to be got wrong:

  - Removing SMALL splats buys sort time, GPU memory, download and the SH bake.
    It buys almost no fill, because small splats cover few pixels.
  - Removing BIG FAINT splats buys fill, and almost no count. Measured on this
    scene, 4.8% of the gaussians — the near-transparent haze — carry 32% of all
    projected screen area.

Doing only one leaves half the win, so this script does both, in an order where
each step feeds the next.

WHAT IT CANNOT BE REPLACED BY
-----------------------------
Two of the three cuts are not expressible in splat-transform's CLI:

  1. The fog cut needs "drop (faint AND large)", i.e. keep the complement of an
     AND. Chained `-V` filters AND together, so they cannot express it.
  2. `-V scale_0` tests only the FIRST scale axis. The quantity that matters is
     the MAX axis — a splat that is a thin sliver on axis 0 and enormous on
     axis 2 is a fog splat, and the CLI would keep it.

Significance selection also needs the reachable-camera set, which only this
repo knows. So: this script does the geometry, writes a plain .ply, and
splat-transform does the encode. See RUNNING.md for the full invocation.

SIGNIFICANCE SELECTION IS OFF BY DEFAULT, AND THAT IS A MEASURED RESULT
-----------------------------------------------------------------------
`--target N` implements the obvious idea, and the idea does not work. Recording
it here so nobody spends another afternoon rediscovering it.

The idea: this viewer does not offer free flight. A visitor gets a fixed-height
walk inside a ~9.8 m2 polygon plus ten authored hero poses, so the reachable
camera set is small and known ahead of time (`reachable.mjs` enumerates it as
239 walk stations plus 10 hero stations). Each splat can therefore be scored at
its worst case — the station it comes closest to:

    score = opacity * (max_scale / nearest_distance) ** 2

which is proportional to the alpha-weighted screen area it could ever occupy.
Keep the top N. On paper this beats LightGaussian/RadSplat-style pruning, which
has to score against training views rather than the actual view distribution.

What happens: at N = 1,000,000 (39.5% of the cloud) the scene develops dark
blotches across the ceiling, the floor and the rug, and it is obvious in an A/B
against the full asset. The metric is not the problem — the DELETION is. Flat
surfaces reconstruct as a mat of many small gaussians, and removing half of them
leaves holes that show whatever darker material sits behind. The published
pruning ratios of 0.6+ all FINE-TUNE the remaining gaussians afterwards, which
grows them back over the gaps. Without that retraining step, deletion at this
rate cannot look right no matter how good the ranking is.

What to use instead: `splat-transform --decimate-adaptive`, which MERGES
neighbouring gaussians rather than deleting them, so the survivors inherit the
extent of what they replace and the surface stays sealed. At 1.6M it is visually
indistinguishable from the full asset at the opening pose. See RUNNING.md.

So the two stages this script still owns are the two splat-transform genuinely
cannot express — the box crop's far tail and the fog cut — and the decimation is
handed off. `--target` is kept because the reachable-camera machinery is correct
and may be the right tool for something else (picking what to put in a low LOD
level, for instance, where holes at distance matter far less).

Run with `uv`, like the rest of this directory — see RUNNING.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

# ---------------------------------------------------------------------------
# The source PLY layout. Verified against the file's own header rather than
# assumed: 62 float32 properties per vertex, the standard 3DGS ordering.
#   0..2   x y z          3..5   nx ny nz      6..8    f_dc_0..2
#   9..53  f_rest_0..44   54     opacity       55..57  scale_0..2
#   58..61 rot_0..3
# ---------------------------------------------------------------------------
N_PROPS = 62
I_XYZ = slice(0, 3)
I_OPACITY = 54
I_SCALE = slice(55, 58)


def read_ply_header(path: Path) -> tuple[int, int, int]:
    """Return (vertex_count, n_props, data_offset). Fails loudly on surprises.

    Deliberately strict. A silently mis-parsed header would produce a plausible
    but wrong point cloud, and the failure would only show up as a subtly
    corrupted scene after a 20-minute encode.
    """
    with path.open("rb") as f:
        raw = f.read(65536)
    end = raw.find(b"end_header\n")
    if end < 0:
        raise SystemExit(f"{path}: no end_header found in the first 64 KB")
    header = raw[:end].decode("ascii", errors="replace")
    offset = end + len(b"end_header\n")

    if "binary_little_endian" not in header:
        raise SystemExit(f"{path}: not a binary_little_endian PLY — this reader only does that")

    count = None
    props: list[str] = []
    for line in header.splitlines():
        if line.startswith("element vertex "):
            count = int(line.split()[2])
        elif line.startswith("element ") and count is not None:
            break  # a second element; everything after belongs to it
        elif line.startswith("property "):
            parts = line.split()
            if parts[1] != "float":
                raise SystemExit(f"{path}: non-float property {line!r} — unsupported")
            props.append(parts[2])

    if count is None:
        raise SystemExit(f"{path}: no 'element vertex' line")

    expect = ["x", "y", "z"]
    if props[:3] != expect:
        raise SystemExit(f"{path}: expected first properties {expect}, found {props[:3]}")
    if props[I_OPACITY] != "opacity":
        raise SystemExit(
            f"{path}: expected property {I_OPACITY} to be 'opacity', found {props[I_OPACITY]!r}. "
            "The layout constants at the top of this file do not match this file."
        )
    if props[55:58] != ["scale_0", "scale_1", "scale_2"]:
        raise SystemExit(f"{path}: expected scale_0..2 at 55..57, found {props[55:58]}")

    # Cross-check against the file size, which catches a truncated download.
    expected_bytes = offset + count * len(props) * 4
    actual = path.stat().st_size
    if actual != expected_bytes:
        raise SystemExit(
            f"{path}: size {actual} != header-implied {expected_bytes} "
            f"({count} verts x {len(props)} props). Truncated or extra elements."
        )
    return count, len(props), offset


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="source .ply (the full-quality training output)")
    ap.add_argument("out", type=Path, help="filtered .ply to write")
    ap.add_argument(
        "--reachable",
        type=Path,
        default=Path(__file__).with_name("reachable.json"),
        help="camera stations from reachable.mjs (RAW coords)",
    )
    ap.add_argument(
        "--target", type=int, default=0,
        help="significance-select down to this many (0 = OFF, the default — "
             "use splat-transform --decimate-adaptive instead; see the note in __doc__)",
    )
    # The fog rule. Both conditions must hold for a splat to be deleted, which
    # is exactly the shape splat-transform's CLI cannot express.
    ap.add_argument("--fog-opacity", type=float, default=0.08,
                    help="delete splats FAINTER than this (sigmoid opacity) ...")
    ap.add_argument("--fog-scale", type=float, default=0.2,
                    help="... AND LARGER than this (max axis, world units)")
    # The crop, and it is deliberately MUCH looser than it first looks like it
    # should be. Measured on this scene:
    #
    #   half-box   removed   what it takes with it
    #   +-12        145,346  the view through the windows. Do not.
    #   +-16        108,510  most of it. Still visibly darkens the right window.
    #   +-45         13,966  only the genuine floaters
    #
    # A tight box is tempting because the room is ~17 raw units across and
    # anything past that "must" be junk. It is not: the windows look out onto
    # real reconstructed foliage sitting 12-40 units away, and cropping at +-16
    # turned the right-hand window black in an A/B against the full asset.
    #
    # What the crop is actually for is the far tail — 384 gaussians past r=100
    # with a median max-axis scale of 6.9 units, nearly 200x the 0.036 median
    # inside the room. Those cost real fill AND, because the resource AABB is
    # derived from the extremes, they stretch the depth sort's quantisation
    # range over ~+-570 units for a room that occupies ~30. Cropping at +-45
    # takes the AABB down by more than 12x, which sharpens the sort key for
    # every splat in the scene, and costs 0.55% of the count.
    ap.add_argument("--box", type=float, nargs=6, default=[-45, -45, -45, 45, 45, 45],
                    metavar=("X0", "Y0", "Z0", "X1", "Y1", "Z1"),
                    help="keep only splats inside this RAW-coordinate box")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what each stage would remove, write nothing")
    args = ap.parse_args()

    count, n_props, offset = read_ply_header(args.source)
    if n_props != N_PROPS:
        print(f"note: {n_props} properties, not the usual {N_PROPS} — "
              f"opacity/scale indices are checked above, so continuing", file=sys.stderr)

    print(f"[mobile] {args.source.name}: {count:,} gaussians, {n_props} props", file=sys.stderr)

    # Memory-map rather than read: the source is 600 MB+ and only five of its
    # 62 columns are needed to decide what to keep.
    data = np.memmap(args.source, dtype=np.float32, mode="r", offset=offset,
                     shape=(count, n_props))

    xyz = np.array(data[:, I_XYZ], dtype=np.float32)
    # PLY stores these pre-activation, exactly as the optimiser held them.
    opacity = 1.0 / (1.0 + np.exp(-np.asarray(data[:, I_OPACITY], dtype=np.float32)))
    smax = np.exp(np.asarray(data[:, I_SCALE], dtype=np.float32)).max(axis=1)

    keep = np.ones(count, dtype=bool)

    # ---- Stage 0: NaN / non-finite -----------------------------------------
    # Always first. A single NaN centre poisons the KD-tree query below.
    finite = np.isfinite(xyz).all(axis=1) & np.isfinite(opacity) & np.isfinite(smax)
    n_nan = int((~finite).sum())
    keep &= finite
    print(f"[mobile] non-finite      : -{n_nan:,}", file=sys.stderr)

    # ---- Stage 1: box crop --------------------------------------------------
    # The cloud extends far past the room — capture floaters at up to ~190 m
    # around a 5.7 x 4 m live room. They are few but enormous on screen, and
    # they also inflate the resource AABB, which costs the depth sort key
    # precision across the whole scene.
    x0, y0, z0, x1, y1, z1 = args.box
    inbox = (
        (xyz[:, 0] >= x0) & (xyz[:, 0] <= x1)
        & (xyz[:, 1] >= y0) & (xyz[:, 1] <= y1)
        & (xyz[:, 2] >= z0) & (xyz[:, 2] <= z1)
    )
    n_box = int((keep & ~inbox).sum())
    keep &= inbox
    print(f"[mobile] outside box     : -{n_box:,}", file=sys.stderr)

    # ---- Stage 2: the fog cut ----------------------------------------------
    # Big AND faint. Individually invisible, collectively the single largest
    # block of fragment work in the scene.
    fog = (opacity <= args.fog_opacity) & (smax >= args.fog_scale)
    n_fog = int((keep & fog).sum())
    keep &= ~fog
    print(f"[mobile] fog (faint+big) : -{n_fog:,}", file=sys.stderr)

    survivors = int(keep.sum())
    print(f"[mobile] after cuts      : {survivors:,}", file=sys.stderr)

    # ---- Stage 3: significance selection ------------------------------------
    if args.target and survivors > args.target:
        reach = json.loads(args.reachable.read_text())
        stations = np.array(
            reach["walk_stations"] + reach["hero_stations"], dtype=np.float32
        )
        print(
            f"[mobile] scoring against {len(stations)} reachable camera stations "
            f"({len(reach['walk_stations'])} walk + {len(reach['hero_stations'])} hero)",
            file=sys.stderr,
        )

        idx = np.flatnonzero(keep)
        # Nearest reachable camera per surviving splat. A KD-tree over a few
        # hundred stations makes this a couple of seconds rather than the
        # 2.5M x 249 dense product it would otherwise be.
        tree = cKDTree(stations)
        dist, _ = tree.query(xyz[idx], k=1, workers=-1)
        # Floor the distance so a splat sitting essentially on top of a station
        # cannot score infinity and drag the whole ranking with it. 0.05 raw
        # units is ~1.7 cm at this scene's 3 units/m — well inside any camera.
        dist = np.maximum(dist.astype(np.float32), 0.05)

        # Alpha-weighted screen area at closest approach.
        score = opacity[idx] * (smax[idx] / dist) ** 2

        # argpartition, not argsort: we need the top N, not a full ordering of
        # two and a half million floats.
        cut = survivors - args.target
        drop_local = np.argpartition(score, cut)[:cut]
        keep[idx[drop_local]] = False
        print(f"[mobile] significance    : -{cut:,}", file=sys.stderr)

    final = int(keep.sum())
    pct = 100.0 * final / count
    print(f"[mobile] KEEPING         : {final:,} ({pct:.1f}% of {count:,})", file=sys.stderr)

    if args.dry_run:
        print("[mobile] --dry-run, nothing written", file=sys.stderr)
        return

    # ---- Write ---------------------------------------------------------------
    # Same header, new count, rows copied in chunks so peak memory stays bounded
    # regardless of how many survive.
    with args.source.open("rb") as f:
        header = f.read(offset).decode("ascii")
    header = header.replace(f"element vertex {count}", f"element vertex {final}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    idx = np.flatnonzero(keep)
    with args.out.open("wb") as f:
        f.write(header.encode("ascii"))
        CHUNK = 200_000
        for i in range(0, len(idx), CHUNK):
            np.asarray(data[idx[i : i + CHUNK]], dtype=np.float32).tofile(f)

    mb = args.out.stat().st_size / 1e6
    print(f"[mobile] wrote {args.out} ({mb:.0f} MB)", file=sys.stderr)
    print(
        "[mobile] next: encode it with splat-transform — see autoscene/RUNNING.md",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
