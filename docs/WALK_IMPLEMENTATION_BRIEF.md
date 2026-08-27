# `walk.ts` — implementation brief

Everything needed to build the constrained-walk module. Design rationale lives in
`RESTYLE_HANDOFF.md` § "The navigation model"; the derivation pipeline that
produces the input lives in `claude_BLUEDIO_AUTOSCENE_HANDOFF.md`. This file is
the contract between them.

**Scope:** consume a pre-derived walk envelope and constrain the camera to it.
**Not in scope:** authoring, tracing, or deriving boundaries. That is
`autoscene.py`'s job and it is already done. Do not build a `__logWalkable()`
helper — an earlier note in `RESTYLE_HANDOFF.md` Open items mentions one; it is
obsolete.

---

## 1. The two modes

A visitor gets exactly two: an **authored hero fly-in**, or a **constrained walk
at fixed eye height**. Free orbit and free fly stay in the codebase but move
behind `?author` as authoring tools. Add a mode enum to `camera.ts`; walk is a
third mode, not a variation of fly.

Walk mode is **per-demo optional**. Bluedio ships hero-only (2.54 m² walkable,
9% of the floor — a room whose walkable area collapses should not offer walk).
If a demo has no `walk` block, the viewer is hero-only and the walk code never
initialises.

---

## 2. Coordinate contract — read before touching a number

The `.sog` is **Y-down: up is −Y.** Levelled in LichtFeld before export; do not
re-level.

| Quantity | Bluedio value | Notes |
|---|---|---|
| `scale_m_per_unit` (S) | 1/3 exactly | from `scene.json` |
| `floor_raw_y` | +4.20 | from `scene.json` |
| `eye_height_m` | 1.40 | from `scene.json` — **do not hardcode** |
| Ceiling | −4.50 raw / 2.90 m | |

```
x_m = x * S                    x = x_m / S
y_m = (floor_raw_y - y) * S    y = floor_raw_y - y_m / S
z_m = z * S                    z = z_m / S
```

`scene.json` geometry is in **raw `.sog` coordinates**, matching the PlayCanvas
camera. But every tuning constant (falloff 0.35 m, pads, corridor width) is
**metric**. Mixing the two silently is the most likely bug in this module.

**Do this:** a tiny frame helper holding `S` and `floor_raw_y` with
`toMetres(v)` / `toRaw(v)`. Convert the envelope to metres **once** at load;
convert camera position in and out each frame. All constraint math is metric,
Y-up, floor at 0. Three multiplies per frame — do not optimise this away.

**Note on eye height.** `RESTYLE_HANDOFF.md` states 1.55 m as the general rule
(bracketed by the 1.4/1.9 m capture rings). Bluedio's `scene.json` says 1.40 m,
because Will pinned the nav plane in LichtFeld and the scale derives from that
same anchor. **`scene.json` wins.** Read `eye_height_m`; never hardcode either
number. The rule is "inside the bracket the rings establish," and the pipeline
already knows where that is for a given room.

---

## 3. Input shape

```
walk.outer        vertex ring, raw XZ, Douglas-Peucker simplified (12 verts on Bluedio)
walk.inner_rings  interior boundaries, same format — holes in the plan
walk.holes        oriented rects: { centre, half_extent, angle_deg, pad_m }
walk.falloff_m    0.35 — boundary softening distance
eye_height_m      fixed camera height above floor
```

`inner_rings` and `holes` are both subtractive but arrive differently: rings come
from plan-fill (architecture, alcoves), rects from island detection (furniture).
Treat them identically in the SDF.

---

## 4. The region SDF

Signed distance in the XZ plane, **positive inside the walkable region**:

```
d(p) = min( sdPolygon(p, outer),
            min over inner_rings:  -sdPolygon(p, ring),
            min over holes:         sdOrientedRect(p, hole) - hole.pad_m )
```

`sdPolygon` positive inside; negate for rings so their interiors read negative.
Padded rects: compute unpadded distance then subtract the pad — this inflates the
hole outward, which is what the pad means.

Standard 2D oriented-rect SDF (transform `p` into the rect's local frame first):

```
q = abs(p_local) - half_extent
d = length(max(q, 0)) + min(max(q.x, q.y), 0)
```

**Boundary normal** — finite-difference the SDF rather than tracking the closest
feature analytically. Cheaper to write, correct across the `min()` seams where
analytic normals get fiddly:

```
eps = 0.01                                  // metres
n = normalize([ d(x+eps, z) - d(x-eps, z),
                d(x, z+eps) - d(x, z-eps) ])
```

`n` points toward increasing distance, i.e. **inward**.

---

## 5. Movement constraint

The whole feel of the mode is here. Boundary is **never visible** and **never a
hard stop** in normal use.

```
d  = sdf(pos)
n  = gradient(pos)                       // inward
vn = dot(v, n) * n                       // component along the normal
vt = v - vn                              // tangential — never damped

if (dot(v, n) < 0)                       // moving toward the boundary
    vn *= smoothstep(0, falloff_m, d)

v' = vt + vn
```

Damping **only** the inward-pointing normal component is what makes sliding along
a wall stay full speed while pushing into it decays asymptotically. Damping the
whole velocity vector makes movement near walls feel like tar — the thing this
design exists to avoid.

**Backstop:** `smoothstep` decays but never reaches zero, and a long frame or a
mode transition can still land `d < 0`. After integrating, if `d < 0`, project
back along `n` by `-d`. This should be unreachable in normal play; if it fires
every frame, the falloff is mistuned.

**Vertical: none.** Camera Y is pinned at `eye_height_m` above the floor. No Q/E,
no crouch, no bob. This is the coverage-honest choice (the capture rings bracket
one height band) and also the comfortable one.

**Look: free.** Do not clamp pitch. Being unable to turn your head reads as
claustrophobic; being unable to walk somewhere reads as furniture. Soft limits at
the extremes only if ceiling coverage proves thin in review.

---

## 6. Hero-point interaction

Hero poses sit **outside** the walk region by design — off a console face, above
a desk, where no body stands. This is deliberate, not a bug to fix: it makes the
fly-in a privileged move rather than a shortcut, and it is why real collision
detection is never needed (free navigation never approaches an object; close
inspection is always authored).

So:

- **Suspend the constraint entirely during a fly-in.** Do not try to path around
  the region.
- **On exit, ease to the nearest point where `d >= 0`.** Cheapest correct
  version: from the hero position, march along `n` until `d >= 0`, then ease the
  camera there over ~0.6 s while restoring `eye_height_m`.
- Restore the constraint only once the camera is inside.

`initialPose` in `scene.json` is already a walk-region seat, so the opening shot
needs no special handling.

---

## 7. Mobile

> **OVERRULED 2026-08-22 — twin thumb sticks shipped instead of tap-to-walk.**
> This is the fourth place the brief was overruled in practice (the other three
> are noted against §5 eye height, look clamping, and `__logWalkable`), and it is
> the only one where the brief's *reasoning* was right and its *conclusion* was
> not. The premise below holds completely: phones are a meaningful share of
> traffic and WASD does not exist there.
>
> Tap-to-walk was rejected because it can only ever express "go to that floor
> point". It cannot look and move at the same time, cannot ease off, cannot
> sidestep, and cannot stop halfway — it is a waypoint, not a body, and this
> viewer's whole claim is that you are standing in the room. §8's own check 2
> below already asks the reviewer to "slide along a wall **at full stick**",
> which is a thing no tap affordance can do; the brief was arguably already
> assuming an analog control by the time it got to verification.
>
> What shipped: a left stick that walks and a right stick that looks, both
> analog, entering the SAME code paths as WASD and the mouse — so everything §4,
> §5 and §6 specify (the region SDF, the inward-only damping, the eye-plane
> invariant, the hero-exit march to `d >= 0`) applies to touch without being
> reimplemented for it. Nothing in §4-§6 needed to change to support them.
> Tap-to-walk was never built and there is no plan to; a tap on the canvas still
> means "fly to this hero point", which is the affordance that was already there.
> See `TEMPLATE.md` → "Touch controls" and `src/joystick.ts`.

The original text, for the record:

Click/tap-to-walk should be the primary affordance, WASD the desktop addition.
A meaningful share of traffic will be phones where WASD does not exist. Tap
target resolves to a floor point; reject it if `d < 0` rather than clamping,
otherwise taps on furniture slide you somewhere unintended.

---

## 8. Verification

The pipeline already reports `min_clear_width_m` and `stranded_pockets_m2`, so
connectivity is validated upstream — no need to re-implement the flood fill in
TypeScript.

What to check in the viewer:

1. Walk the full perimeter. Deceleration should be unnoticeable; if you can feel
   where the wall is, lower `falloff_m`.
2. Slide along a wall at full stick. Should not slow. If it does, the tangential
   component is being damped — bug in §5.
3. Trigger every hero and exit. Camera must always land inside the region at
   correct eye height, never inside furniture.
4. Log any frame where the §5 backstop fires. Should be zero.
