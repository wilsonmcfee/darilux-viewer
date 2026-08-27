# REVEAL_NOTES.md

Findings from building `reveal-lab`. Companion to `REVEAL_HANDOFF.md`, which was
written before implementation; where the two disagree, this file is the one that
was checked against the engine.

**Status:** lab built and running. Tuning not yet done — that is the next
session, per the agreed split. Section 6 is the tuning order and the reasoning
behind it, which is the part that transfers.

---

## 1. Task 0 — the override API

**Engine:** `playcanvas` `^2.21.0` declared, **2.21.0** installed. The npm
package ships no `src/`, but `node_modules/playcanvas/build/playcanvas/src/` is
the untranspiled ESM tree and is readable.

**Mechanism:** `gsplatModifyVS` / `gsplatModifyPS` are registered shader chunks
in both language collections, shipped as empty stubs for exactly this purpose:

```glsl
void modifySplatCenter(inout vec3 center) {}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {}
void modifySplatColor(vec3 center, inout vec4 color) {}
```

Called from `glsl/chunks/gsplat/vert/gsplat.js:32,59` and
`vert/gsplatCorner.js:89`, in the order centre → rotation/scale → colour. All
four channels the brief wanted are reachable and nothing needed plumbing.

**Two routes. We use the first.**

| Route | Cost |
|---|---|
| `app.scene.gsplat.material.getShaderChunks(lang).set('gsplatModifyVS', …)` | applied at final render; no work-buffer re-render |
| `entity.gsplat.setWorkBufferModifier({glsl, wgsl})` + `workBufferUpdate = WORKBUFFER_UPDATE_ALWAYS` | re-renders all splat data every frame |

The engine's own docs steer away from the second for time-animated uniforms, and
they are right to.

**Per-splat identity:** `splat.index` (a `uint` on a global `Splat` struct set by
`setSplat()`). In scope in our chunk because `gsplatCommonVS` includes
`gsplatStructsVS` — which pulls in `gsplatSplatVS` — *before* `gsplatModifyVS`.
It is the work-buffer slot, not a stable asset-order id; fine for a single static
non-octree scene, which is all this viewer ever loads.

**Uniforms:** `material.setParameter(...)` does not recompile. `setDefine` does,
and `gsplat-shadow-renderer` / `gsplat-projector` additionally cache the chunk
*source* and rebuild when the string changes. So the chunk text is generated once
per session and every control — including the phase-function and easing
selectors — is a uniform that the shader branches on. A parameter explorer that
recompiles on every dropdown change is unusable.

**Both languages are mandatory.** `device.ts` is WebGPU-first, and
`GSPLAT_RENDERER_AUTO` resolves to `RASTER_GPU_SORT` on WebGPU /
`RASTER_CPU_SORT` on WebGL2 — never the compute path (the setter coerces
`GSPLAT_RENDERER_COMPUTE` back to `AUTO`). Both raster paths run this chunk, but
WebGPU runs the WGSL collection. A GLSL-only override is a silent no-op on the
machine you are most likely testing on. This is the real cost of the feature; the
API risk the brief worried about was not a risk at all.

**Space:** in unified rendering the mesh instance hangs off a fresh untransformed
`GraphNode("GSplatManager")`, so `matrix_model` is identity and `getCenter()`
returns **world** space — the entity's 180° roll is already baked in by the
work-buffer copy. Bounds and camera position must be passed in world.

**Verified live:** WGSL chunk compiles and runs on WebGPU (nvidia/blackwell,
Chrome), Bluedio's 2,534,528 splats, no console errors.

---

## 2. The finding that changes the effect

**Scaling toward zero does not give a point cloud in 2.21. It gives an empty
frame.** Three separate mechanisms erase a tiny splat:

1. `initCornerCov` dilates the projected covariance by `+0.3` on both diagonals,
   so even a zero-scale splat has an extent of about **1.55 px**.
2. It then **discards** the splat — `if (max(l1,l2) < minPixelSize) return false`
   — and `minPixelSize` defaults to **2**. 1.55 < 2, so the seed state is culled
   outright.
3. With `GSPLAT_AA` on, `aaFactor = sqrt(detOrig/detBlur)` tends to zero with the
   projected area and multiplies alpha; `clipCorner` then shrinks the quad again
   as alpha nears the clip threshold.

So "seed scale" is not one slider, it is four coupled ones, and three of them are
engine-level: `minPixelSize` (a material parameter — no recompile, lowered for the
reveal and restored to 2 afterwards), `antiAlias` (a define — applied once, not
toggled per reveal, because a recompile hitch at the moment the reveal *ends* is
the worst place to put one), and `seedAlphaFloor` in our own shader, which fights
the AA crush with no recompile at all.

### 2a. And then the opposite problem

With those set, the first run on Bluedio came up as a **milky cream white-out**,
not dots. The arithmetic is obvious in hindsight: 2.5M splats at ~1–2 px each over
a ~1 MP viewport is several times full coverage, and every one of them blending at
an alpha floor saturates the frame.

That produced the one control the brief did not anticipate: **`seedGate`** — how
much of the alpha floor a splat gets *before its own phase window opens*. At 1
every splat in the room is drawn from frame one (fog, and expensive). At 0 an
unstarted splat is invisible, so the bloom is a genuine advancing front with empty
space ahead of it and the GPU only pays for splats actually in flight. With any
structured phase function this is the difference between "the room assembles
itself" and "the room fades up" — which is the whole brand argument. Default 0.15:
a faint haze ahead of the front.

---

## 3. Timing — the brief's hybrid is not reachable as written

"Honest" timing means splats bloom as bytes arrive. That cannot happen here. A
SOG bundle is `means_l`, `means_u`, `quats`, `scales`, `sh0`, `shN_*`, and
`GSplatResource` does not exist until every one has downloaded **and** decoded.
There is no partially-renderable splat: the whole scene pops into being when
`asset.once('load')` fires, so nothing can bloom during the download.

The three policies therefore reduce to three ways of choosing the reveal's
**duration** from measured load time, and they are implemented that way in
`driver.ts: effectiveDuration()`. The honest part of the experience is the loading
veil, which does report real aggregated byte progress — `parsers/sog.js`
`combineProgress()` sums across all sub-assets — handing off to a theatrical
bloom.

**Note the inversion.** `hybrid` makes the reveal *shorter* on a slow load, not
longer. A visitor who has already waited nine seconds does not want a longer
animation, and the brief's "must never finish before the asset does" constraint is
satisfied for free, since the reveal cannot start until the asset is complete.
`loadTimeSlope` is how many seconds come off per second of load beyond 2 s.

Two smaller caveats found in the same code, both relevant if the veil's progress
readout is ever tightened: `combineProgress` extrapolates the total while files
are still reporting (`total * count / reporting`), so early progress is jumpy; and
bytes-complete precedes decode-to-GPU, so 100% is not "ready".

---

## 4. Decisions taken

- **Camera is locked at `initialPose` for the whole reveal.** The reveal owns
  scale, opacity, colour and (optionally) a small position settle, and never moves
  the camera. That keeps it independent of which camera mode exists, so it does
  not need rewriting when `walk.ts` lands, and it cannot violate the navigation
  model.
- **Veil handoff is a parameter, not a guess.** `veilHandoff` (ms, default 180) is
  how long after `ui.hideLoading()` starts its 450 ms fade before the reveal
  begins. It exists in the config now so the production wiring has one number to
  set rather than a hardcoded delay; the lab has no veil, so tuning it needs the
  real page.
- **Backdrop is parameterised, both ends.** The brand argument is for revealing
  against paper (`#efeae2`) rather than the black void every other 3DGS viewer
  uses, but the shipped viewer window is a deliberate dark shell (`#14100c`) whose
  entire chrome — veil, cards, hero dots — is designed against it. So seed colour,
  rest colour and the crossfade between them are all controls. This is the one
  genuinely open aesthetic question.
- **Reduced motion needs one line of JS.** The page's existing mechanism is three
  CSS rules (`style.css:911`) and CSS cannot gate a vertex shader. There is now a
  single exported `prefersReducedMotion()` in `driver.ts`; when it is true the
  driver flattens spread, hash, seed scale, displacement and tint to a plain
  opacity crossfade rather than skipping the reveal. The lab can override it, or
  tuning on a machine with the OS setting on would be impossible.

---

## 5. Frame time

Measured on Bluedio (2.53M splats), WebGPU, desktop:

| State | Frame time |
|---|---|
| At rest | 16.7 ms avg · 16.8 p95 (vsync-locked) |
| Mid-reveal | 37.4 ms avg · 100 ms p95 |

So **yes, the reveal costs measurable time**, and the answer to that open item is
not "negligible". Almost certainly overdraw: `minPixelSize` lowered to 1.0 keeps
millions of splats alive that the engine would normally cull, and at the original
`seedAlphaFloor` of 0.35 every one of them blended. `seedGate` should cut most of
it, since a gated splat fails the alpha clip and is discarded before rasterising.
**Unverified** — attribution needs the A/B run with the lab visible, using the
on-screen frame time. Do that before trusting any preset on a mid-range laptop.

---

## 6. What to tune, in order, and why

The order matters more than the values. Each step changes what the next one looks
like.

1. **`seedGate`, then `seedAlphaFloor`.** Get the seed state to read as *dots*
   before touching anything else. Every other parameter is judged against this
   frame, so tuning curves over a white-out is wasted work. Hold the scrub at
   `t = 0.15` and look at it.
2. **`spread`.** With the gate working, spread controls how *thick* the front is.
   This is the parameter that decides whether the effect reads as assembly or as a
   fade, and it interacts hard with step 1: more spread means fewer splats in
   flight at once, which is both prettier and cheaper.
3. **`hashBlend`.** The brief is right that this is the biggest single quality
   lever, but it is only judgeable once the front has a thickness. 0.2–0.3 is the
   stated range; verify against `vertical` first since a floor-up sweep shows a
   hard plane most obviously.
4. **`duration` and `ease`.** Now the shape. Use the curve preview — the two solid
   envelopes are the first and last splat to bloom, so the gap between them *is*
   spread made visible.
5. **`minPixelSize` and `antiAlias`.** Only now, and watch the frame-time readout
   while you do. These trade seed legibility against cost and against how the
   scene looks at rest.
6. **Backdrop crossfade.** Last, because it changes the apparent colour of
   everything above it.
7. **Re-check on `Common Room` and `Studio E`.** Consistency across scenes matters
   more than per-scene optimisation — if a value has to change per room, the
   parameterisation is wrong and that is a finding, not a tuning result.

Displacement is deliberately left at 0. It is the only parameter that can produce
a genuine artifact (a stale depth sort), and the lab labels where it breaks rather
than clamping it. Try it after everything else works; a settle under ~0.35 m is
safe, a fly-in is not.

---

## 7. Open items

- Frame-time attribution (§5) — needs the A/B with the pane visible.
- Whether `seedGate` at 0 leaves the veil handing off to an empty frame, and
  whether `opacityLead` is enough to cover it. Needs the real page, not the lab.
- Whether hybrid needs a per-scene floor or one global value. Untestable until
  there are real load times from a deployed build rather than localhost.
- Whether entering a second room should replay the full reveal. The driver
  re-triggers per scene load, so full replay is what happens today; an abbreviated
  variant would be a `duration` scale on repeat entries, not new machinery.
- Not touched, per scope: walk mode, hero re-authoring, metric scale. Nothing
  found here bears on them, except that a locked-off reveal camera means walk mode
  can land without revisiting this code.

---

## Files

| File | Role |
|---|---|
| `lab.html` | dev-only entry. Vite's default build input is the root `index.html`, so this is never emitted — verified: `npm run build` produces `dist/index.html` only, with no lab code in the bundle. Do **not** add it to `rollupOptions.input`. |
| `src/lab/main.ts`, `src/lab/lab.css` | the lab: scene switcher, controls, curve preview, scrub, frame time, preset export |
| `src/reveal/config.ts` | the parameter surface, and the contract with production |
| `src/reveal/shader.ts` | the `gsplatModifyVS` override, GLSL and WGSL |
| `src/reveal/driver.ts` | chunk install, uniform push, timing policy. **This becomes `src/reveal.ts`.** |

Nothing in `src/main.ts`, `src/ui.ts` or `src/demos.ts` has been touched — the
production wiring is the next session's work.

In the lab: `R` replays, `__logReveal()` prints a pasteable preset (same idiom as
`__logPose()` / `__logAnchor()`), and `__reveal` is the live driver for poking at
values the panel does not expose.
