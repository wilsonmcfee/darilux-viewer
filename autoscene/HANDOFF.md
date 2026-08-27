# autoscene — Bluedio dry run handoff

Pick-up notes for a Claude Code session continuing this work. Everything below
was derived offline from `Bluedio_optimized.sog` alone — no viewer, no GPU, no
manual annotation. Read the coordinate contract before touching a number.

---

## What this is

A Python pipeline that reads a `.sog` and emits `scene.json`: a walk envelope,
ranked hero points with proposed camera poses, an opening shot, and a fly-in
tour order — all already expressed in the viewer's own coordinates so they can
be pasted into `demos.ts` untouched.

Built as the dry run for Will's friend's studio ("Bluedio"), a dense live room.
The point of the exercise was to find out how much of hero-point placement and
fly-in authoring can be automated rather than clicked.

## The coordinate contract — read this first

The `.sog` is **Y-down (up = −Y)**. Will set the orientation in LichtFeld
Studio before export, and it is correct: the raw Y axis is 5.7× sharper as a
vertical axis than the COLMAP gravity vector, which means the scene was
levelled, not left in solver coordinates. Do not re-level it.

| Quantity | Value | How it was found |
|---|---|---|
| Floor plane | `y = +4.20` | one sharp density plane, 103k gaussians in a 4 cm band; mass collapses above it (68k in 4.3–5.0, 17k in 5.0–7.0) |
| Eye height / nav plane | `y = 0` | set by Will in LichtFeld |
| Ceiling | `y = −4.50` | highest coherent band, 8.70 u above the floor |
| **Scale** | **1 unit = 1/3 m exactly** | Will pinned `y = 0` at 1.40 m; 1.40 / 4.20 = 0.3333 |
| Room height | 2.90 m | 8.70 u × 1/3 |

Conversions used everywhere in the pipeline:

```
x_m = x * S                 x = x_m / S
y_m = (FLOOR_RAW - y) * S   y = FLOOR_RAW - y_m / S      S = 1/3, FLOOR_RAW = 4.20
z_m = z * S                 z = z_m / S
```

Internally the pipeline works in metres, Y-up, floor at 0. **Everything written
to `scene.json` is converted back to raw `.sog` coordinates on the way out.**

If the 1.40 m anchor ever turns out to be wrong, nothing needs re-deriving —
`S` is a single multiplier and every metric threshold scales with it.

## The room

| | |
|---|---|
| Gaussians | 2,534,528 |
| Room plan area | **27.09 m² (292 sq ft)** |
| Ceiling | 2.90 m |
| Walkable after standoffs | **2.54 m² (27 sq ft) — 9% of the floor** |

It is a **live room, not a control room**: drum kit, keyboards on stands,
red drapes, cymbal stands. Two large body-height islands sit in the middle of
the plan (2.00 m² and 5.15 m²) and split it.

### Walk mode does not earn its place here

This is the headline finding and it reverses an earlier read of the same room.
`RESTYLE_HANDOFF.md` sets the rule: a room whose walkable floor collapses to a
few steps should ship as an authored hero sequence with no walk mode. Bluedio
collapses. The sensitivity sweep, so the call is auditable rather than a
threshold accident:

| pad_tall | pad_low | wall inset | corridor floor | walkable | % of room |
|---|---|---|---|---|---|
| 0.50 | 0.18 | 0.50 | 0.80 | 2.54 m² (27 sq ft) | 9% |
| 0.40 | 0.15 | 0.45 | 0.75 | 3.05 m² (33 sq ft) | 11% |
| 0.35 | 0.15 | 0.40 | 0.70 | 3.88 m² (42 sq ft) | 14% |
| 0.30 | 0.12 | 0.35 | 0.65 | 5.96 m² (64 sq ft) | 22% |
| 0.25 | 0.10 | 0.30 | 0.60 | 6.69 m² (72 sq ft) | 25% |
| 0.20 | 0.10 | 0.25 | 0.55 | 6.85 m² (74 sq ft) | 25% |

Even at settings that abandon the optical-standoff rationale entirely (0.20 m
from tall gear, a 0.55 m corridor), it tops out around 74 sq ft and stops
improving — the islands, not the parameters, are the binding constraint.

**So: `walk.ts` should still be built** — the constraint module is the reusable
asset and the pipeline emits the polygon it needs — **but Bluedio should ship
hero-only.** Validate `walk.ts` against a room that has floor to give.

> **REVERSED, 2026-08-21.** Bluedio ships WITH walk mode, and is now the
> prototype for the universal viewer template. Two things changed the call.
> First, the table above measures *area*, which counts a wide dead end the same
> as a route; the honest measure is the longest walkable path, and at these
> settings that is **2.49 m** — the finding holds, and is worse than 27 sq ft
> sounds. Second, the 0.80 m corridor `binary_opening` is doing most of the
> damage: it exists to delete slivers, but the boundary falloff already makes a
> thin passage unattractive without removing it. Drop the opening, take the wall
> inset to 0.30 m and the tall-gear pad to 0.32 m, and the same room gives
> **8.23 m2 with 7.42 m of continuous path**. See `envelope.py`, which is that
> parameter set as a repeatable tool.

## What `scene.json` contains

```
scale_m_per_unit, floor_raw_y, eye_height_m, ceiling_m   the contract above
room_m2, walkable_m2, min_clear_width_m, stranded_pockets_m2
params            every threshold used, so a result can be reproduced
walk.outer        12-vertex polygon, raw .sog XZ, Douglas-Peucker simplified
walk.inner_rings  interior boundaries, same format
walk.holes        oriented rects: centre, half_extent, angle_deg, pad_m
walk.falloff_m    0.35 — boundary softening distance for the SDF
initialPose       position + target for the opening shot
heroes[]          order, position, target, standoff_m, top_m, footprint_m2,
                  travel_m, duration_s, dwell_s, saliency
```

`position` and `target` are raw `.sog` triples. Nine heroes at current settings.

## How it works

1. **Decode** (`decode_sog.py`) — SOG v2 is a zip of WebP textures. Means are
   16-bit split across `means_l`/`means_u`, lerped into the log-space bounds in
   `meta.json`, then `sign(v)·(exp|v|−1)`. Colour is the SH DC term through the
   codebook: `rgb = 0.5 + 0.28209479·sh0`.
2. **Room** — occupancy at body height (0.30–1.70 m) → free space → largest
   enclosed component → fill holes. The fill is the room's plan area; the holes
   are furniture islands.
3. **Object height** — `_stack_top()`, not the column top. A synth against a
   wall would otherwise report as 2.8 m tall because the wall is behind it.
   Counts the first break of ≥3 empty 5 cm bins *above the column's lowest
   occupied bin*, so a keyboard on an open stand reports the keyboard rather
   than the air beneath it.
4. **Envelope** — erode the plan by the wall inset, subtract each island
   dilated by its pad (0.50 m tall / 0.18 m low), then open with a disk the
   width of the narrowest acceptable corridor. That opening is what implements
   the pinching rule: slivers behind furniture disappear instead of becoming
   tar pits.
5. **Heroes** — a saliency field (splat density, colour spread, height above
   floor, local silhouette relief), smoothed, zeroed over the walk region and
   anything under 0.55 m so floor clutter and rugs never win. Peaks, then NMS at
   0.85 m separation. Each survivor grows a region by height similarity, and the
   camera is placed off the **face** of that region — not its centroid — at the
   standoff that keeps it outside the walk region. Hero poses sitting where a
   body cannot stand is deliberate, per `RESTYLE_HANDOFF.md`.
6. **Opening shot + tour** — the walk-region seat whose field of view contains
   the most visible saliency; then heroes ordered by bearing around the room
   centroid so consecutive fly-ins never whip back across frame.

## Running it

```bash
python3 decode_sog.py                    # once: .sog -> xyz.npy + sh0.npy
python3 autoscene.py --heroes 10         # -> scene.json + grids.npz
python3 planfig.py                       # -> plan.png     (occupancy / envelope / saliency)
python3 preview.py                       # -> previews.png (what each pose sees)
```

`preview.py` is the important one. It is a CPU point-splat rasteriser, ~7 s for
all frames, and it is the only honest check on framing — a pose can be
geometrically perfect and still be aimed at a curtain. Every tuning decision in
the current parameters came from looking at that contact sheet.

## Where it stands

**Working.** Ten candidates, nine survive placement, footprints 0.15–0.94 m²,
standoffs 0.96–1.45 m, camera heights 1.05–1.45 m, all framed near eye level.

**Roughly 4 in 6 are usable as-is.** The failures are aimed at a bright wall or
a curtain. Saliency built from density, colour and relief has no way to know a
Juno-60 matters and a drape does not — that ceiling is inherent to the
geometry-only approach.

## Open items

- **Hero quality needs the viewer in the loop.** Tune against real WebGPU
  frames, not the CPU previews. The previews are good enough to reject a bad
  pose, not to approve a good one.
- **Semantic labels.** The remaining quality gap is naming. A gear list from
  the studio owner, or a vision pass over the source frames, converts "object
  at (2.1, 3.9)" into "hero point: the Juno".
- **The capture path already encodes the hero points and I could not recover
  them.** The passes are labelled `B_01_console-orbit`, `B_03_dubstation-orbit`,
  `C_01_synth-wall-high` — each close pass orbits a target, so the orbit
  centroid *is* a hero point chosen on capture day. Registering the COLMAP solve
  into the oriented `.sog` frame failed: best plan-correlation 0.38, railing
  against the scale bound, pass centroids collapsing on top of each other. The
  fix is not a better search — it is **exporting the camera poses from LichtFeld
  after the orientation transform**, or recording the transform itself. Either
  makes this exact instead of a search, and the hero list falls out of the
  capture for free. This is the single highest-value input still missing.
- **`walk.ts` still to build**, per `RESTYLE_HANDOFF.md`: mode enum in
  `camera.ts`, orbit/fly demoted behind `?author`, per-demo
  `walk: { eyeHeight, floor, holes }` fed from `scene.json`. Boundary falloff on
  the velocity component along the boundary normal only, so sliding along a wall
  stays full speed.
- **Asset weight.** `Bluedio_optimized.sog` is 34.3 MB against Studio E's
  11.8 MB. It will load, but on a first visit behind the loading veil that is a
  long wait. There is also a second export, `Bluedio_optim.sog` (35.1 MB) —
  decide which is canonical before wiring anything up.
- **Repo.** Not yet decided whether Bluedio is a branch of `morisot-jftr-demo`
  or its own repo.

## Files

| File | What it is |
|---|---|
| `decode_sog.py` | SOG v2 → `xyz.npy`, `sh0.npy` |
| `autoscene.py` | the pipeline; all thresholds are module constants at the top |
| `envelope.py` | the WALK REGION for the viewer — looser defaults than autoscene, hand-editable, emits a paste-ready `region:` block |
| `planfig.py` | occupancy / walk envelope / saliency + hero arrows |
| `preview.py` | CPU renders from every proposed pose |
| `scene.json` | the output — walk polygon, heroes, opening shot, tour |
| `plan.png`, `previews.png`, `bluedio_render.png` | current state |
