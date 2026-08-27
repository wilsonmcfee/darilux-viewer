# Bluedio — context supplement

Written in response to a Claude Code review that re-verified `scene.json` in
Node and found three real defects plus two dangling references. This file
answers both questions, confirms the findings, and carries the context that
`HANDOFF.md` assumed you already had.

**Read this before `HANDOFF.md`.** Where they disagree, this file wins — it is
newer and it incorporates your corrections.

---

## Your two blockers

### 1. Where the pipeline lives

It ran in a **Claude cloud session**, not on your machine. That is why there is
no Python and no `xyz.npy` / `sh0.npy` on disk — only the `.sog` you were given.
Will is installing Python now, so re-running locally will become possible, but
**you should not need to.**

The division of labour that makes sense:

- **The cloud session owns the pipeline.** It has the decoded caches
  (`xyz.npy`, `sh0.npy` — 2.53M × 3 float32 each, ~30 MB apiece, which is why
  they were never committed), numpy/scipy/skimage, and the CPU preview
  rasteriser. When a parameter needs changing, ask for a regenerated
  `scene.json` rather than rebuilding the toolchain.
- **You own the viewer.** `demos.ts`, `walk.ts`, `camera.ts`, and everything
  that needs real WebGPU frames to judge. That feedback loop is the reason the
  work moved to you at all.

If you do want it locally: `pip install numpy scipy scikit-image pillow`, then
`decode_sog.py` (~40 s over 2.53M gaussians) writes the two `.npy` caches, and
everything downstream reads those. The decode is the only part that touches
WebP; the rest is plain array work.

A Node port of the decoder is feasible but not worth it — the format is a zip
of WebP textures, means split 16-bit across `means_l`/`means_u`, lerped into the
log-space bounds in `meta.json`, then `sign(v)·(exp|v|−1)`. Straightforward, but
you would still be reimplementing scipy's morphology and distance transforms
downstream.

### 2. The walk-mode spec is not missing — it is in the wrong copy

You are right that it is not in `RESTYLE_HANDOFF.md` at HEAD. It is in the
**Claude project's copy** of `RESTYLE_HANDOFF.md`, which has diverged from the
repo's. The project copy is newer and carries a whole section the repo copy
does not.

**Action for Will: sync the project copy into the repo**, so the spec stops
living in two places. Same risk applies to `CAPTURE_REFERENCE.md`, which is a
project doc and — as far as I can tell — has no repo counterpart at all.

The relevant text, verbatim, so you are unblocked either way:

> ## The navigation model (design constraint, not a preference)
>
> > **Status:** design decision made; implementation pending. `camera.ts` currently
> > ships free orbit + fly, which predates this decision. See Open items.
>
> **A visitor may experience a scene in exactly two ways: an authored hero fly-in,
> or a constrained walk at fixed eye height inside a region derived from the capture
> path. There is no free orbit and no free fly in the shipped experience.** Orbit
> and fly remain, gated behind `?author`, as authoring tools only.
>
> ### Why this is a hard rule
>
> A splat is only trustworthy where the camera went. Coverage confers legitimacy;
> outside the swept volume the optimizer was guessing, and free navigation lets a
> visitor walk straight into that guess. Two specific failure modes:
>
> - **Wall-face contact.** Pressed against an acoustic panel you see Gaussian
>   blobs, floaters, and reconstruction seams — the single worst frame in the
>   scene, and free-fly makes it one drag away. `CAPTURE_REFERENCE.md`'s entire
>   aperture ladder is calibrated for legibility at standing viewing distance;
>   the viewer has to honour the distance the capture was designed around.
> - **Unreconstructed volume.** Above the high ring, behind furniture, outside the
>   perimeter — no parallax was ever collected there, so there is nothing to see
>   but haze.
>
> The constraint is therefore **a quality guarantee, not a limitation**: every
> frame a client can reach is a frame we engineered to look good. Framed that way
> it is also a selling point, not an apology.
>
> ### The walk envelope derives from the capture path
>
> Not from the room, and not from a comfortable default. From where the camera
> actually went.
>
> - **Horizontally** — the walkable region approximates the plan area enclosed by
>   the perimeter rings, inset by the standoff distance. Wall-adjacent floor the
>   rings never covered is outside the region by construction.
> - **Vertically** — a *fixed* eye height, chosen to sit inside the vertical
>   bracket the rings establish (0.9 / 1.4 / 1.9 m per `CAPTURE_REFERENCE.md`).
>   **Use 1.55 m**, not the 1.6–1.7 m a naive "human eye height" default would
>   suggest: 1.55 is a plausible standing eye height *and* is bracketed above and
>   below by the 1.4 and 1.9 m rings, so every horizontal look direction sits
>   between two covered heights rather than extrapolating off the top one.
>   Per-demo value in `demos.ts` — if a room was captured at different ring
>   heights, its eye height moves with them.
> - **No vertical freedom at all.** No Q/E, no crouch, no head bob. Fixed height
>   is both the coverage-honest choice and the comfortable one (no induced motion
>   sickness on a mouse-look walk).
>
> ### Boundary behaviour
>
> The boundary is **never visible** and never a hard stop. Compute signed distance
> to the region edge and scale movement by roughly `smoothstep(0, falloff, d)`,
> applying the falloff **only to the velocity component along the boundary
> normal** — so sliding parallel to a wall stays full speed while pushing into it
> decays asymptotically. Tuned correctly, nobody notices a limit; they simply lose
> interest in that direction. A hard clamp reads as an invisible wall and breaks
> the illusion instantly.
>
> ### Region shape: primitives, not traced footprints
>
> Outer walkable ring plus subtracted **holes**, each an oriented rectangle
> (desks, consoles, couches, racks) or a circle (chairs, stools, stands). Closed-
> form distance functions, which the falloff needs anyway. Region SDF is
> `min(dist to outer ring, min over holes)`.
>
> Per-object `pad`, because the two standoffs exist for different reasons:
>
> | Object class | Reason for the hole | Pad |
> |---|---|---|
> | Tall (rack, console meterbridge, outboard wall) | **optical** — close contact fills frame with the least-reconstructed geometry | ≥ 0.5 m |
> | Low (couch, table, amp — below the eye line) | **plausibility only** — never enters the render badly, just implausible to stand inside | 0.15–0.2 m |
>
> Uniform padding wastes floor area a small control room cannot spare; per-object
> padding buys much of it back.
>
> **The pinching rule.** If an object sits within roughly one standoff of a wall,
> do *not* make it a hole — extend the wall inset around it and treat it as
> architecture. Otherwise the inflated regions overlap and leave a sliver of
> technically-walkable floor behind the couch, where falloff makes movement feel
> like wading through tar in the least interesting corner of the room. A
> middle-of-room desk is the legitimate hole case (region becomes an annulus);
> verify the loop's narrowest clear width is ≥ 0.8 m after padding.
>
> ### Hero points live *outside* the walkable region
>
> Deliberately. Hero poses sit where a body cannot stand — 40 cm off a console
> face, above a desk, at angles no walk could reach. This makes the fly-in a
> privileged camera move rather than a shortcut ("the viewer can go where you
> can't"), which is the framing that justifies the hero-point line in
> `JFTR_Pricing_and_Scope`. It also dissolves the collision problem entirely:
> free navigation never approaches an object, close inspection is always authored,
> so **real collision detection is never required**. On hero exit, ease back to
> the nearest point inside the region.
>
> ### Connectivity check (author-time)
>
> Nothing structurally guarantees the region is connected. At author time,
> rasterize the polygon-with-holes to a coarse grid (~10 cm cells), flood-fill
> from the spawn point, and log any walkable cell not reached. Catches sealed
> pockets and stranding before a client finds them.
>
> ### Where walk mode does *not* belong
>
> Walk mode has to earn its place per room. Studio E at ~168 sq ft, inset for
> standoff and minus the console footprint, may leave only ~40–50 sq ft of
> walkable floor — two or three steps, which reads as shuffling in place rather
> than exploring. For rooms that tight, an authored hero-point sequence with no
> walk mode is the honest deliverable. Decide per room against the floorplans;
> the split tends to track the room bands already used for pricing.

And the open item that lists the implementation surface:

> - **Walk mode not yet built.** `camera.ts` ships free orbit + fly, which the
>   navigation model above supersedes. Needs: a `src/walk.ts` constraint module,
>   a mode enum in `camera.ts`, per-demo `walk: { eyeHeight, floor, holes }` in
>   `demos.ts`, orbit/fly demoted behind `?author`, and a `__logWalkable()`
>   authoring helper (click floor points → paste polygon), matching the existing
>   `__logPose()` / `__logAnchor()` idiom.

Note the tension you should be aware of: the spec says **1.55 m** eye height,
bracketed by 1.4/1.9 m rings. Bluedio's `y = 0` is at **1.40 m** — Will's
choice, and it is what the whole coordinate contract is pinned to. For a
hero-only demo this is moot. If Bluedio ever gets walk mode, that discrepancy
needs a decision, not a silent pick.

---

## Your three defects — all confirmed, all fixed

A corrected `scene.json` ships alongside this file. Diff summary:

**1. Heroes 4 and 5 were the same object.** Your diagnosis was exactly right:
NMS ran on saliency *peak cells*, and those two peaks sat 0.95 m apart against a
0.85 m box (18 cells vs `sep=17`), then `frame_it()` grew both into one region
with nothing re-checking afterwards. Fixed by re-testing separation on the
**grown centroid** after `frame_it()` returns:

```python
cxm, _, czm = pose["centroid_m"]
if any(math.dist((cxm, czm), (p["centroid_m"][0], p["centroid_m"][2])) < HERO_SEP
       for p in picks):
    continue
```

Minimum pairwise centroid separation in the new output is **1.471 m**, up from
0.249 m. Hero count 9 → 8.

**2. The opening shot sat 13 mm outside the polygon.** Also right, and your
"harmless today, fatal the moment `walk.ts` clamps" is the correct severity
call. Two changes rather than one:

- The seat is now chosen only from cells at least **0.30 m** from the raster
  boundary, which is more than triple the 0.09 m simplification error, so RDP
  cannot shave it out. New margin: **0.316 m**.
- Containment is now **asserted at export**, not assumed. Every pose is tested
  against the *simplified* polygon with an even-odd test. `initialPose` carries
  `inside_walk_polygon: true` and the pipeline hard-fails if it isn't. Each hero
  carries the same field — all 8 are `false`, which is the design intent, now
  recorded instead of implied.

Your shoelace figure was correct and is now exported rather than left to be
discovered: `polygon_area_m2: 2.499` against `raster_area_m2: 2.543`, with
`simplify_eps_m: 0.09` beside them. The 1.7% is RDP loss, not an arithmetic bug.

**3. Winding.** Confirmed and normalised. Outer ring is now counter-clockwise
(positive shoelace) in metric XZ, inner rings clockwise, and `walk.winding`
states it in the file so a sign test in `walk.ts` cannot flip silently.

One caveat on the winding contract: it is defined in **metric XZ**, and the
exported coordinates are raw `.sog` units. Since `S` is a positive scalar the
sign is preserved, but if anything downstream mirrors an axis, re-check it.

---

## Your two closed items

**Canonical `.sog`: agreed, `Bluedio_optimized.sog`** — but the stated evidence
was wrong, so correcting it here before someone diffs the two files and gets
confused. They are **not** near-identical to ~1e-6. Measured:

| | `_optimized` | `_optim` |
|---|---|---|
| count | 2,534,528 | 2,534,528 (identical) |
| scales codebook | — | identical, 0.0 diff |
| means bounds (log space) | — | differ up to **4.3e-3** |
| sh0 codebook | — | differs up to **4.2e-2** |
| shN codebook | — | differs up to **3.0e-2** |
| gaussian ordering | — | **different** |

That last row is the one that matters: SOG is *Spatially Ordered* Gaussians and
the ordering is part of the compression, so a re-export reshuffles it. Any
index-wise comparison of the two files is meaningless — compared that way the
median per-gaussian offset is 1.34 m, which reflects nothing but the reordering.

Distributionally they do agree, which is what justifies the conclusion: same
training result, and the floor plane lands at **+4.190** (`_optimized`) vs
**+4.210** (`_optim`) — 6.7 mm apart, both rounding to 4.20. Colour differs by a
median 7.6/255 per voxel; a separate quantisation pass, not a different scene.

So: same solve, two independent exports. Keep `_optimized` (later, smaller).
Delete the other.

**Precision note on `S`, arising from the above.** The floor was originally
measured with 5 cm bins and read 4.20, which made `S = 1.40/4.20 = 1/3` look
exact. At 2 cm bins the canonical file reads **+4.190**, giving `S = 0.33413` —
a 0.24% difference. Immaterial (a 0.50 m pad becomes 0.5012 m) and **not worth
regenerating `scene.json` over**, but do not treat 1/3 as an exact property of
the scene. It is a rounding coincidence at the original bin width. The real
precision floor on `S` is Will's 1.40 m assertion, not the floor fit.

**Asset weight: you are right and I was wrong.** I benchmarked against Studio E,
which is the smallest scene in the repo, and drew a conclusion the comparison
doesn't support. Against `common-room` at 29.5 MB / 2.30M gaussians — already
shipping, same loading veil — Bluedio at 34.3 MB / 2.53M is +16%, essentially
the same class. Treat the item as closed. Ignore that paragraph in `HANDOFF.md`.

---

## The contact sheet, on the corrected set

Regenerated after the dedupe. Eight heroes now, my read:

| # | verdict | what it is |
|---|---|---|
| opening | ✓ | wide, keyboards + drape + room depth |
| 0 | ok | cluttered shelf; busy but reads |
| 1 | ✓ | keyboard/desk against the drape |
| 2 | marginal | cymbal stands, colourful clutter |
| 3 | **reject** | blown white — window or lit wall |
| 4 | ✓ | drum kit / gear cluster |
| 5 | ✓ | speaker cabinet, reads clearly |
| 6 | ✓ | keybed close-up, cleanest of the set |
| 7 | ✓ | keyboard + drape, keybed reads |

**Six keepers, one reject, one marginal.** Drop 3; keep 2 only if you want eight.
Your independent read on the previous sheet matched this within one item, which
is about as much agreement as a subjective call gets.

---

## Your read on hero-only — agreed, and the number you found is the better one

You are right that `heroes_in_frame: 1.281` argues the case harder than the
sensitivity sweep does. The sweep shows walk mode is *cramped*; your number
shows it is *pointless*. The opening shot sees roughly two of nine heroes, the
walk pocket spans x −2.89…−1.14 m while the gear spans −2.17…+3.10 m, and every
hero camera but one sits 1.9–5.0 m outside anywhere a body can stand.

That is a stronger statement than "not enough floor": **there is no standing
position in this room from which the room reads.** Worth putting to Will in
those terms, because it generalises — it is a property of gear arranged around
a perimeter with the middle occupied, which is what a live room *is*. It will
recur, and it is a better per-room test than floor area alone.

---

## Context `HANDOFF.md` assumed you had

### The scale chain, and what it rests on

Everything metric traces to one assertion from Will: **`y = 0` is 1.40 m**.
The floor plane at `y = +4.20` is solved from the data (one sharp density plane,
103k gaussians in a 4 cm band, mass collapsing above it). 1.40 / 4.20 = 1/3
exactly, which is clean enough to be slightly suspicious but is what he said.

If that number is ever revised, **nothing needs re-deriving** — `S` is a single
multiplier at the top of `autoscene.py` and every threshold is expressed in
metres, so they all scale together. Do not hardcode metric values downstream.

Independent corroboration is weak but not absent: the ceiling lands at 2.90 m,
which is unremarkable for a live room. If Will lasers the ceiling, that pins `S`
properly and the 1.40 m becomes a check rather than an axiom.

### The scene was levelled in LichtFeld, not in solver coordinates

Do not re-level it. The raw Y axis is **5.7× sharper** as a vertical axis than
the COLMAP gravity vector (vertical-density peak fraction 0.0394 vs 0.0069),
which is only possible if the export was already gravity-aligned. It is Y-down:
up is **−Y**. Confirmed by mass collapsing past the floor plane — 68k gaussians
in 4.3–5.0, 17k in 5.0–7.0, against 103k in the single 4 cm floor band.

### The capture data is on disk and you can read it

`3dGS/images/Images_fulldataset_reconstruction/sparse/` — a COLMAP reconstruction,
**1166 of 1186 frames registered (98.3%)**, one PINHOLE camera at 3845×2159,
f≈2330 px (~79° horizontal). The passes are labelled, and the labels are the
interesting part:

| pass | frames | what it is |
|---|---|---|
| `A_01_ring-1-high` | 168 | perimeter ring, high |
| `A_02_ring-2-mid` | 168 | perimeter ring, mid |
| `A_03_ring-3-low` | 148 | perimeter ring, low |
| `B_01_console-orbit` | 193 | close pass, console |
| `B_02_transition-console-to-dubstation` | 18 | the filmed transition |
| `B_03_dubstation-orbit` | 168 | close pass, dub station |
| `C_01/02/03_synth-wall-high/mid/low` | 101 each | wall target, three heights |

This is a protocol-following capture — three rings, close passes shot inside the
same solve, transitions filmed rather than cut, per `CAPTURE_REFERENCE.md`.
The ring planes fit to within 2° of each other with 1.3–2.9 cm out-of-plane RMS,
which is a very level handheld pass.

**The `B_` and `C_` pass names are hero points Will already chose on capture
day.** Each close pass orbits a target; the orbit centroid is that target. This
is why the LichtFeld pose export keeps being called the highest-value missing
input — it is not a nice-to-have, it converts hero placement from a saliency
heuristic into a readout of a decision a human already made.

I could not recover them by registration: best plan-correlation 0.38, railing
against the scale bound, pass centroids collapsing onto each other. That is a
failed fit, not a marginal one. Do not spend time on it — the COLMAP frame and
the exported `.sog` frame differ by whatever transform Will applied in
LichtFeld, and recovering it by image correlation across two very different
point distributions (SfM features vs. dense gaussians) is the wrong tool. The
transform itself, or poses exported after it, makes this exact.

### What the room actually is

A **live room, not a control room** — drum kit, keyboards on stands, red drapes,
cymbal stands, a speaker cabinet. `HANDOFF.md` uses "console" and "dub station"
because those are the capture pass names; do not assume a control-room layout
from them. Two large body-height islands (2.00 m² and 5.15 m²) sit in the middle
of the plan and are what kill walk mode.

### Sibling-repo conventions worth honouring

From the project's `RESTYLE_HANDOFF.md`, for the `demos.ts` wiring:

- `data-demo` on the `.viewer-window` **must match** the demo `id` in `demos.ts`.
  Existing ids: `studio-e`, `common-room`, `synths`.
- `cardStyle` is per-demo: `'hud'` (left-center), `'hud-bottom'` (bottom-center;
  used by synths and Studio E), `'anchored'` (pinned to the 3D point, tracks the
  camera; used by Common Room). Your `'hud-bottom'` pick matches the two
  gear-focused demos, which is the right precedent.
- **Only one splat is ever in memory.** The shared `#stage` reparents into
  whichever window is live; the × unloads and re-docks. A fourth demo costs
  nothing at rest.
- `npm run build` runs `tsc --noEmit` first and **must pass**.
- Sandboxed agents can commit but not push. Will pushes.

### How the previews were tuned, and why it matters to you

`preview.py` is a CPU point-splat rasteriser — ~7 s for the whole contact sheet,
no GPU, no viewer. Every parameter in `autoscene.py` was set by looking at that
sheet and rejecting poses, not by reasoning about geometry. Three rounds of it
moved the cameras from knee height aimed at cable runs to eye height aimed at
keybeds.

Keep using it as the cheap filter even once you have WebGPU frames. It is good
enough to **reject** a bad pose and not good enough to **approve** a good one —
that asymmetry is the whole value.

---

## Go ahead

Wire Bluedio in as a fourth hero-only demo. Six heroes — drop 3, and drop 2 if
you want it tight. `initialPose` as shipped (it now passes containment).
`cardStyle: 'hud-bottom'`. No `walk` field.

Card copy will be placeholder until someone names the gear. That is the
remaining quality gap and it is not a code problem: a saliency field built from
density, colour and silhouette relief has no way to know a Juno matters and a
drape does not. A gear list from the studio owner, or a vision pass over the
source frames in `3dGS/images/`, is what closes it.
