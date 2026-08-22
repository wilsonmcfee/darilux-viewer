#!/usr/bin/env python3
"""
envelope — derive a walkable region for the viewer's walk mode, and emit it as a
paste-ready `region:` block for demos.ts plus a figure to judge it by.

    python envelope.py --xyz ./xyz.npy --sh0 ./sh0.npy

Why this exists separately from autoscene.py
--------------------------------------------
`autoscene.py` answers "does this room DESERVE walk mode?" and is tuned to be
conservative about it: a 0.50 m wall inset, a 0.50 m pad off tall gear, and a
final `binary_opening` with a 0.80 m disk that deletes any corridor narrower than
a comfortable one. On Bluedio that lands on 2.54 m2 with 2.49 m of walkable path,
which is the honest answer to its question — that room does not need walk mode.

This script answers the other question: "the room IS getting walk mode; what is
the best envelope for it?" Same occupancy grid, three different defaults:

  wall inset  0.30 m   the room plan boundary already sits at the FACE of the
                       perimeter gear, so the inset is a second standoff on top
                       of one that is already there
  island pad  0.32 m   for tall gear. The single most sensitive number: on
                       Bluedio, 0.40+ strands the region in one corner and makes
                       the whole console side unreachable
  no opening           the falloff already makes a thin passage unattractive.
                       Deleting it as well is what erases the loop

On Bluedio that is 8.23 m2 against 2.54 m2 — the difference between exploring a
room and shuffling in place.

Two things that are easy to get wrong
-------------------------------------
1. TRACE THE RING FROM A SMOOTHED FIELD. A ring traced off the raw 5 cm grid has
   a normal that snaps 90 degrees at every cell, and walk.ts applies the boundary
   falloff ALONG that normal — so sliding along a wall would stutter. The signed
   distance field is blurred and re-thresholded before tracing, and the resulting
   rounding is capped so it can never eat into an island's pad.

2. THE OUTPUT IS IN VIEWER WORLD UNITS, NOT RAW .SOG. main.ts rolls every splat
   180 degrees about Z, so raw (x, z) is world (-x, z). This script negates x on
   the way out; paste its output into demos.ts untouched.

Coordinate frames, all three of them
------------------------------------
    raw .sog     what the file contains; autoscene.py's scene.json is in these
    metres       raw * S, y flipped to floor-up. THE FIGURE'S AXES, and the frame
                 --edits shapes are written in
    world units  metres / S with x negated. What demos.ts and walk.ts consume

Hand edits
----------
Geometry cannot tell a drape from a doorway, so the derived envelope will
sometimes want correcting by eye. `--edits FILE.json` takes shapes in METRES, in
the same frame as the figure's axes, so a region can be read straight off an
annotated copy of the figure:

    {
      "islandPads": { "0": 0.32, "1": 0.20 },
      "exclude": [
        { "kind": "rect",   "min": [0.4, -2.0], "max": [1.2, -0.5], "note": "why" },
        { "kind": "circle", "centre": [-2.1, 0.8], "radius": 0.45 },
        { "kind": "poly",   "points": [[0,0], [1,0], [1,1]] }
      ],
      "include": [ ...same three shapes... ]
    }

  islandNames  rank -> label, for the figure only. Changes nothing else.
  exclude  carves floor OUT of the region. Unconditional — use it for anywhere a
           visitor should not stand that the geometry has no way to know about.
  include  forces floor IN, for where a pad or the wall inset was too greedy. It
           is intersected with the room's free space first, so it can relax a
           standoff but can never put a visitor inside solid geometry.

Run with --edits and no file to have a commented starter written for you.
"""
import argparse, json, math, os, sys

import numpy as np
from scipy import ndimage
from skimage import measure

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autoscene as A

CELL = A.CELL
S = A.S

# ---------------------------------------------------------------- defaults
WALL_INSET   = 0.30   # m from the room plan boundary (already the gear face)
PAD_TALL     = 0.32   # m off an island taller than autoscene's TALL_TOP
PAD_LOW      = 0.20   # m off a low one
SIGMA        = 1.4    # grid cells of blur on the signed distance field
ROUNDING_CAP = 0.05   # m the blur may relax a standoff by
MIN_ISLAND   = 0.06   # m2 before a hole counts as an island at all
RDP_EPS      = 0.045  # m of simplification on the traced ring
FALLOFF      = 0.25   # m, written into the emitted block
SPAWN_MARGIN = 0.30   # m, written into the emitted block


def disk(radius_m):
    rr = max(1, int(round(radius_m / CELL)))
    yy, xx = np.ogrid[-rr:rr + 1, -rr:rr + 1]
    return (xx * xx + yy * yy) <= rr * rr


def largest(mask):
    """Main connected component, plus the area of everything it left behind."""
    lab, n = ndimage.label(mask)
    if not n:
        return mask, []
    sizes = sorted(((np.count_nonzero(lab == i), i) for i in range(1, n + 1)), reverse=True)
    main = lab == sizes[0][1]
    return main, [s[0] * CELL ** 2 for s in sizes[1:] if s[0] * CELL ** 2 > 0.2]


def shape_mask(sc, shape):
    """Rasterise one --edits shape. Coordinates are METRES, figure frame."""
    ii, jj = np.meshgrid(np.arange(sc.shape[0]), np.arange(sc.shape[1]), indexing="ij")
    X, Z = sc.world_of(ii, jj)
    kind = shape.get("kind", "rect")
    if kind == "rect":
        (x0, z0), (x1, z1) = shape["min"], shape["max"]
        return (X >= min(x0, x1)) & (X <= max(x0, x1)) & (Z >= min(z0, z1)) & (Z <= max(z0, z1))
    if kind == "circle":
        cx, cz = shape["centre"]
        return (X - cx) ** 2 + (Z - cz) ** 2 <= float(shape["radius"]) ** 2
    if kind == "poly":
        pts = np.asarray(shape["points"], float)
        flat = measure.points_in_poly(np.stack([X.ravel(), Z.ravel()], 1), pts)
        return flat.reshape(X.shape)
    raise SystemExit(f"unknown edit shape kind: {kind!r} (rect | circle | poly)")


STARTER_EDITS = """{
  "_frame": "All coordinates are METRES in the figure's own axes (raw .sog XZ).",
  "_islandPads": "Keyed by the island rank printed by the script. Metres.",

  "islandNames": {},
  "islandPads": {},

  "exclude": [
  ],

  "include": [
  ]
}
"""


def find_islands(sc):
    """Islands, largest first — the same holes autoscene finds, unfiltered by its
    pinching rule (which is what suppresses them on a room like Bluedio, where
    both islands sit within a standoff of a wall)."""
    dist_edge = ndimage.distance_transform_edt(sc.outer) * CELL
    lab, k = ndimage.label(sc.holes, np.ones((3, 3)))
    out = []
    for i in range(1, k + 1):
        m = lab == i
        area = m.sum() * CELL ** 2
        if area < MIN_ISLAND:
            continue
        ii, jj = np.nonzero(m)
        X, Z = sc.world_of(ii, jj)
        out.append(dict(mask=m, area=area, top=float(sc.top[m].max()),
                        gap=float(dist_edge[m].min()),
                        centre=(float(X.mean()), float(Z.mean())),
                        size=(float(X.max() - X.min()), float(Z.max() - Z.min()))))
    out.sort(key=lambda d: -d["area"])
    return out


def rdp(p, eps):
    if len(p) < 3:
        return p
    a, b = p[0], p[-1]
    ab = b - a
    L = np.linalg.norm(ab)
    ap = p - a
    d = (np.abs(ab[0] * ap[:, 1] - ab[1] * ap[:, 0]) / L) if L > 1e-9 else np.linalg.norm(ap, axis=1)
    i = int(np.argmax(d))
    if d[i] <= eps:
        return np.array([a, b])
    return np.vstack([rdp(p[:i + 1], eps)[:-1], rdp(p[i:], eps)])


def _crosses(a, b, c, d):
    """Do open segments ab and cd properly cross?"""
    def o(p, q, r):
        v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
        return 0 if abs(v) < 1e-12 else (1 if v > 0 else 2)
    return o(a, b, c) != o(a, b, d) and o(c, d, a) != o(c, d, b)


def is_simple(ring):
    """True if no two non-adjacent edges of the closed ring cross.

    This is not a nicety. walk.ts decides inside/outside with an even-odd ray
    test, so a self-intersecting ring makes the SDF change SIGN in the wrong
    place — the visitor is told they are outside the region while standing in
    the middle of it, and the constraint shoves them somewhere arbitrary.
    """
    n = len(ring)
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if _crosses(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]):
                return False
    return True


def simplify(contour, eps):
    """Douglas-Peucker, backed off until the ring is simple.

    A narrow slot in the region — a 0.15 m un-walkable finger between two pads,
    say — has two nearly-coincident walls, and RDP is perfectly happy to shave
    them past each other. So the eps is halved until the result survives
    is_simple(), and the raw contour is shipped if it never does. A ring with a
    few too many vertices costs nothing; a ring that crosses itself is a bug the
    visitor walks into.
    """
    simp = rdp(contour, eps)
    for _ in range(8):
        if len(simp) >= 4 and is_simple(simp[:-1]):
            return simp, eps, True
        eps *= 0.5
        simp = rdp(contour, eps)
    return contour, eps, False


def signed_area(ring):
    t = 0.0
    for i in range(len(ring)):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % len(ring)]
        t += x1 * z2 - x2 * z1
    return t / 2


def compose_probe(sc, islands, pads, cfg):
    """The region as it would be with NO hand edits — used only to tell whether
    an exclude actually removed anything."""
    m = ndimage.binary_erosion(sc.outer, disk(max(cfg.wall, 0.05)))
    for n, isl in enumerate(islands):
        m &= ~ndimage.binary_dilation(isl["mask"], disk(max(pads[n], 0.05)))
    return m & sc.interior


def build(sc, islands, cfg, edits):
    """The envelope, as a boolean grid. Returns (region, hard, diagnostics)."""
    inc = np.zeros(sc.shape, bool)
    exc = np.zeros(sc.shape, bool)
    for s in edits.get("include", []):
        inc |= shape_mask(sc, s)
    for s in edits.get("exclude", []):
        exc |= shape_mask(sc, s)
    # An `include` may relax a standoff but never put a body inside geometry.
    inc &= sc.interior

    pads = {}
    for n, isl in enumerate(islands):
        override = edits.get("islandPads", {}).get(str(n))
        pads[n] = float(override) if override is not None \
            else (cfg.pad_tall if isl["top"] > A.TALL_TOP else cfg.pad_low)

    def compose(relax):
        m = ndimage.binary_erosion(sc.outer, disk(max(cfg.wall - relax, 0.05)))
        for n, isl in enumerate(islands):
            m &= ~ndimage.binary_dilation(isl["mask"], disk(max(pads[n] - relax, 0.05)))
        return (m | inc) & ~exc & sc.interior

    hard, stranded_hard = largest(compose(0.0))

    # Smooth the 5 cm stair-steps out of the SIGNED distance field, then
    # re-threshold. See the header — the falloff acts along the boundary normal,
    # and a grid-traced normal is a sawtooth.
    sd = ndimage.distance_transform_edt(hard) - ndimage.distance_transform_edt(~hard)
    region = ndimage.gaussian_filter(sd.astype(float), cfg.sigma) > 0
    # Rounding may not eat more than ROUNDING_CAP into any standoff.
    region &= compose(cfg.rounding_cap)
    region, stranded = largest(region)
    return region, hard, pads, sorted(set(stranded_hard + stranded), reverse=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xyz", default="./xyz.npy")
    ap.add_argument("--sh0", default="./sh0.npy")
    ap.add_argument("--wall", type=float, default=WALL_INSET, help="m inset from the room plan")
    ap.add_argument("--pad-tall", type=float, default=PAD_TALL, help="m off a tall island")
    ap.add_argument("--pad-low", type=float, default=PAD_LOW, help="m off a low island")
    ap.add_argument("--sigma", type=float, default=SIGMA, help="cells of blur before tracing")
    ap.add_argument("--rounding-cap", type=float, default=ROUNDING_CAP,
                    help="m the blur may relax a standoff by")
    ap.add_argument("--eps", type=float, default=RDP_EPS, help="m of ring simplification")
    ap.add_argument("--falloff", type=float, default=FALLOFF, help="m, emitted into the block")
    ap.add_argument("--spawn-margin", type=float, default=SPAWN_MARGIN, help="m, emitted")
    ap.add_argument("--edits", help="JSON of hand corrections; written as a starter if missing")
    ap.add_argument("--out-ts", default="./envelope.ts.txt")
    ap.add_argument("--out-png", default="./envelope.png")
    ap.add_argument("--no-figure", action="store_true")
    cfg = ap.parse_args()

    edits = {}
    if cfg.edits:
        if os.path.exists(cfg.edits):
            edits = json.load(open(cfg.edits, encoding="utf8"))
            print(f"edits          {cfg.edits}: "
                  f"{len(edits.get('include', []))} include, "
                  f"{len(edits.get('exclude', []))} exclude, "
                  f"{len(edits.get('islandPads', {}))} pad override(s)")
        else:
            open(cfg.edits, "w", encoding="utf8").write(STARTER_EDITS)
            print(f"wrote a starter edits file to {cfg.edits} — fill it in and re-run")

    sc = A.Scene(cfg.xyz, cfg.sh0)
    islands = find_islands(sc)
    print(f"room plan      {sc.room_area:.2f} m2")
    print(f"islands        {len(islands)}")
    for n, isl in enumerate(islands):
        print(f"  [{n}] {isl['area']:5.2f} m2  {isl['size'][0]:.2f} x {isl['size'][1]:.2f} m  "
              f"top {isl['top']:.2f} m  centre ({isl['centre'][0]:+.2f}, {isl['centre'][1]:+.2f}) m  "
              f"gap-to-wall {isl['gap']:.2f} m")

    region, hard, pads, stranded = build(sc, islands, cfg, edits)
    area = region.sum() * CELL ** 2
    print(f"\npads used      " + ", ".join(f"[{n}] {p:.2f} m" for n, p in pads.items()))
    print(f"walkable       {area:.2f} m2 ({area * 10.7639:.0f} sq ft), "
          f"{100 * area / sc.room_area:.0f}% of the plan")
    if stranded:
        print(f"  ! STRANDED   {len(stranded)} pocket(s) dropped: "
              + ", ".join(f"{s:.2f} m2" for s in stranded)
              + "  <- loosen a pad, or the visitor simply cannot reach them")

    # Did every hand edit actually land? An include that is not CONNECTED to the
    # main region is dropped by largest() and would otherwise vanish in silence —
    # which is the single most confusing thing this script could do to someone
    # marking up the figure.
    for i, s in enumerate(edits.get("include", [])):
        m = shape_mask(sc, s)
        free = m & sc.interior
        if not free.any():
            print(f"  ! include[{i}] is entirely inside solid geometry — nothing to add. "
                  f"An include may relax a standoff, never put a body inside a wall.")
            continue
        got = (free & region).sum() / free.sum()
        if got < 0.02:
            print(f"  ! include[{i}] had NO effect. Almost certainly not connected to the "
                  f"main region — extend it until it touches walkable floor.")
        elif got < 0.85:
            print(f"  ~ include[{i}] only {100 * got:.0f}% applied "
                  f"(the rest is solid geometry, or unreachable).")
    if edits.get("exclude"):
        unedited = largest(compose_probe(sc, islands, pads, cfg))[0]
        for i, s in enumerate(edits["exclude"]):
            if not (shape_mask(sc, s) & unedited).any():
                print(f"  ~ exclude[{i}] removed nothing — it was already outside the region.")

    # Encroachment: prove the smoothing did not eat into a standoff.
    worst = 0.0
    for n, isl in enumerate(islands):
        over = region & ndimage.binary_dilation(isl["mask"], disk(pads[n]))
        if over.any():
            e = float((ndimage.distance_transform_edt(
                ndimage.binary_dilation(isl["mask"], disk(pads[n]))) * CELL)[region].max())
            worst = max(worst, e)
            print(f"  island [{n}] standoff relaxed by up to {e:.3f} m")
    if not worst:
        print("encroachment   0.000 m into every island standoff")

    # ---- trace ------------------------------------------------------------
    rings = []
    for c in measure.find_contours(np.pad(region.astype(float), 1), 0.5):
        c = c - 1.0
        xy = np.stack([sc.x0 + (c[:, 0] + 0.5) * CELL, sc.z0 + (c[:, 1] + 0.5) * CELL], 1)
        simp, used, ok = simplify(xy, cfg.eps)
        if not ok:
            print(f"  ! a ring could not be simplified without self-intersecting; "
                  f"shipping the raw {len(xy)}-point contour")
        elif used < cfg.eps:
            print(f"  ~ eps backed off {cfg.eps:.3f} -> {used:.4f} m on one ring "
                  f"to keep it simple (a narrow slot in the region)")
        if len(simp) >= 4:
            rings.append(simp)
    rings.sort(key=lambda r: -abs(np.trapezoid(r[:, 1], r[:, 0])))
    if not rings:
        raise SystemExit("no ring traced — the region is empty")

    def to_world(r):
        # metres -> world units, x negated by main.ts's 180-degree Z roll.
        return [[round(-float(x) / S, 3), round(float(z) / S, 3)] for x, z in r[:-1]]

    def wind(r, ccw):
        return r if (signed_area(r) > 0) == ccw else r[::-1]

    outer = wind(to_world(rings[0]), True)
    inners = [wind(to_world(r), False) for r in rings[1:]]
    # Re-check in WORLD space, which is what actually ships. The x negation is a
    # mirror, so it cannot create a crossing — but this is cheap, and the cost of
    # being wrong is a region the viewer silently misjudges.
    for nm, r in [("outer", outer)] + [(f"inner {i}", r) for i, r in enumerate(inners)]:
        if not is_simple(np.asarray(r, float)):
            raise SystemExit(f"REFUSING TO WRITE: the {nm} ring self-intersects in world space")
    print(f"\nring           outer {len(outer)} verts CCW"
          + (f", {len(inners)} inner: {[len(r) for r in inners]}" if inners else ", no inner rings"))

    fmt = lambda r, ind: "\n".join(ind + "[" + ", ".join(f"{v:.3f}" for v in p) + "]," for p in r)
    ts = (f"      region: {{\n"
          f"        falloff: {cfg.falloff},\n"
          f"        spawnMargin: {cfg.spawn_margin},\n"
          f"        outer: [\n{fmt(outer, '          ')}\n        ],\n")
    if inners:
        ts += "        innerRings: [\n" + "".join(
            "          [\n" + fmt(r, "            ") + "\n          ],\n" for r in inners) + "        ],\n"
    ts += "      },\n"
    open(cfg.out_ts, "w", encoding="utf8", newline="\n").write(ts)
    print(f"wrote          {cfg.out_ts}  (paste into the demo's `walk` block)")

    if not cfg.no_figure:
        figure(sc, islands, region, area, outer, inners, cfg, edits)
        print(f"wrote          {cfg.out_png}")


def figure(sc, islands, region, area, outer, inners, cfg, edits):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch, Polygon as MPoly
    from matplotlib.ticker import MultipleLocator

    dist = ndimage.distance_transform_edt(region) * CELL
    ext = [sc.x0, sc.x0 + sc.shape[0] * CELL, sc.z0, sc.z0 + sc.shape[1] * CELL]

    def show(ax, m, colour, alpha=1.0):
        img = np.zeros(m.shape + (4,))
        img[m] = list(colour) + [alpha]
        ax.imshow(np.transpose(img, (1, 0, 2)), origin="lower", extent=ext)

    fig, ax = plt.subplots(figsize=(12, 9.5))
    show(ax, sc.outer, [0.83, 0.88, 0.94])
    for isl in islands:
        show(ax, isl["mask"], [0.30, 0.28, 0.33])
    show(ax, region & (dist < cfg.falloff), [0.99, 0.81, 0.36], 0.95)
    show(ax, region & (dist >= cfg.falloff), [0.15, 0.65, 0.45], 0.95)

    for ring in [outer] + list(inners):
        poly = np.array([[-p[0] * S, p[1] * S] for p in ring])
        ax.add_patch(MPoly(poly, closed=True, fill=False, ec="#111", lw=2.0, zorder=8))
        ax.plot(poly[:, 0], poly[:, 1], "o", ms=3.0, color="#111", zorder=9)
    names = edits.get("islandNames", {})
    for n, isl in enumerate(islands):
        label = names.get(str(n))
        head = f"[{n}] {label}" if label else f"[{n}]"
        ax.annotate(f"{head}\n{isl['top']:.2f} m", isl["centre"], color="w",
                    ha="center", va="center", fontsize=10, weight="bold", zorder=11)

    ii, jj = np.nonzero(sc.outer)
    X, Z = sc.world_of(ii, jj)
    ax.set_xlim(X.min() - 0.7, X.max() + 0.7)
    ax.set_ylim(Z.min() - 0.7, Z.max() + 0.7)
    ax.set_aspect("equal")
    # A half-metre grid, because this figure is the thing you annotate to write
    # an --edits file, and every shape in that file is in these coordinates.
    ax.xaxis.set_major_locator(MultipleLocator(1.0))
    ax.yaxis.set_major_locator(MultipleLocator(1.0))
    ax.xaxis.set_minor_locator(MultipleLocator(0.5))
    ax.yaxis.set_minor_locator(MultipleLocator(0.5))
    ax.grid(which="major", alpha=0.35, lw=0.7)
    ax.grid(which="minor", alpha=0.16, lw=0.5)
    # Stating the negation on the plot, because this figure is the thing that
    # gets marked up, and "left" here is "right" in the viewer. --edits shapes
    # are in THESE coordinates; the export negates x on the way to demos.ts.
    ax.set_xlabel("x (m), figure frame — NEGATED vs viewer world x.   --edits shapes use these coordinates")
    ax.set_ylabel("z (m)")
    loops = f" · {len(inners)} inner ring(s)" if inners else ""
    ax.set_title(
        f"walk envelope — wall {cfg.wall} / pads "
        + "/".join(f"{p:.2f}" for p in [cfg.pad_tall, cfg.pad_low])
        + f" / sigma {cfg.sigma}\n{area:.2f} m2 · {area * 10.7639:.0f} sq ft · "
          f"{len(outer)}-vertex ring{loops}",
        fontsize=12.5, loc="left")
    handles = [
        Patch(color="#26a673", label="full speed in every direction"),
        Patch(color="#fdcf5c", label=f"falloff band ({cfg.falloff} m) — only INWARD motion decays"),
        Patch(fc="none", ec="#111", lw=2.0, label="exported boundary polygon"),
        Patch(color="#4d4854", label="islands (numbered; pad by rank in --edits)"),
        Patch(color="#d4e0f0", label="room plan — perimeter gear already excluded"),
    ]
    if edits.get("include") or edits.get("exclude"):
        handles.append(Patch(fc="none", ec="#1560c0", lw=1.6, ls="--", label="include (hand edit)"))
        handles.append(Patch(fc="none", ec="#b0202a", lw=1.6, ls="--", label="exclude (hand edit)"))
        for s, colour in [(edits.get("include", []), "#1560c0"), (edits.get("exclude", []), "#b0202a")]:
            for shape in s:
                if shape.get("kind", "rect") == "rect":
                    (x0, z0), (x1, z1) = shape["min"], shape["max"]
                    ax.add_patch(plt.Rectangle((min(x0, x1), min(z0, z1)), abs(x1 - x0), abs(z1 - z0),
                                               fill=False, ec=colour, lw=1.6, ls="--", zorder=12))
                elif shape["kind"] == "circle":
                    ax.add_patch(plt.Circle(shape["centre"], shape["radius"], fill=False,
                                            ec=colour, lw=1.6, ls="--", zorder=12))
                else:
                    ax.add_patch(MPoly(np.asarray(shape["points"], float), closed=True, fill=False,
                                       ec=colour, lw=1.6, ls="--", zorder=12))
    ax.legend(handles=handles, loc="lower left", fontsize=9, framealpha=0.96)
    fig.tight_layout()
    fig.savefig(cfg.out_png, dpi=115, facecolor="white")


if __name__ == "__main__":
    main()
