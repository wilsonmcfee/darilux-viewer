# PHONE_DOCK_NOTES.md

The docked phone layout and the quality-restore pass, 2026-08-25. Companion to
`TEMPLATE.md`, which is where the *durable* documentation lives — the knob
table, the SuperSplat comparison, the on-demand rendering write-up and the URL
flags are all there, in the sections someone wiring a new scan would read. This
file records what changed, why, and what is still a judgement.

**Status:** shipped and tested on a real phone. The performance thesis is
CONFIRMED (§7). One bug came back from that test (§8), and an audit of the
same bug CLASS found nine more (§10). All fixed and verified.

**Read `TEMPLATE.md` → "Performance" before touching any of this.** In
particular "The overcorrection, and what SuperSplat actually does", which
supersedes the resolution and culling conclusions the 2026-08-23 pass recorded.

> **Superseded in part by the 2026-09-02 pass — `TEMPLATE.md` → "Profiled
> 2026-09-02".** Three things in this file are no longer current: (a) phones
> load the **1.6M** bundle, not the full 2.53M (§6, §7) — decided by device on
> 2026-08-31 after a WebGPU phone stuttered on 2.53M, and now also on every
> WebGL2 device; (b) the render ratio is no longer fixed per page — a 2.0 Mpx
> budget and a frame-time governor (`core/adaptive.ts`) re-decide it on every
> resize and during motion, and the HUD's `res` line shows the governor's
> scale; (c) `sort --` in §7 was radial sorting suppressing rotation-triggered
> sorts, but WALKING still sorts continuously on radial — the 2026-09-02 pass
> measured 28 sorts/s and an 11.67 MB upload per sort on WebGL2, and gated it.
> The layout content here (§2–§5, §8–§10) stands.

---

## 1. What came back from the phone, and what each complaint actually was

Will's report on the 2026-08-23 mobile build was three things:

| Report | What it actually was |
|---|---|
| "resolution dropped much too drastically, lost the photoreal characteristics" | Five simultaneous quality cuts, of which the render ratio was only one — and on a DPR-2 phone, not even the biggest |
| "the culling of splats was much too aggressive" | Literally true: every shared knob was moved quality-DOWN, where the benchmark moves them quality-UP |
| "framerate began to drop in a few minutes of use" | Thermal throttling from `autoRender = true`. A different bug from the other two, and the only one with a single clean fix |

He also named the control that made it obvious: *the same `.sog`, in SuperSplat's
own viewer, on the same phone, does not do this.* That was the right instinct
and it is what this pass was built on.

## 2. The finding: we were the aggressive one, and by how much

`playcanvas/supersplat-viewer` was read rather than inferred from. Its mobile
sizing is:

```js
const maxPixelDim = platform.mobile ? 1080 : 2160;
const pixelRatio  = Math.min(maxPixelDim / Math.min(screen.width, screen.height),
                             window.devicePixelRatio);
const scale       = pixelRatio * (performanceMode ? 0.5 : 1.0);
```

**The 0.5 multiplies a ratio already capped at 1080 physical pixels, not 1.0.**
The previous pass read "SuperSplat halves the canvas on mobile", concluded a
flat target of 1.0 expressed that better than a multiplier, and shipped half
SuperSplat's linear resolution on any DPR-3 phone.

| phone | SuperSplat (perf on) | old build | new full-bleed | new docked |
|---|---|---|---|---|
| 390x844, DPR 3 | 1.385 | 1.000 | 1.385 | **2.077** |
| 375x812, DPR 2 | 1.000 | 1.000 | 1.000 | **1.500** |

**Be precise about this rather than repeating the headline:** on a DPR-2 phone
the old build matched SuperSplat's resolution exactly, so *there* the softness
would have been entirely the culling. The caveat is worth keeping for the next
device, but it does **not** apply to the one this was reported from — §7 measured
it as a **403 CSS px, DPR 3** iPhone 16 Pro class device, so the full 2x
resolution gap was real for Will and the resolution fix is most of what he sees.

And on culling, the direction of travel was simply backwards. SuperSplat moves
three knobs and **every one keeps more splats than the engine default**;
the old preset moved five and every one kept fewer, on top of half the
gaussians. Full table in `TEMPLATE.md`.

## 3. What shipped

**Quality restored (`src/device.ts`, `src/splatquality.ts`, `src/main.ts`)**

- Render ratio now uses SuperSplat's cap-then-scale model verbatim, with the
  scale as a per-page argument: 0.5 full-bleed, 0.75 docked.
- `MOBILE_PRESET` rewritten. It now deviates from engine stock in three places,
  and only `colorUpdateAngle` costs any quality — kept because this is a walk
  viewer and that knob is triggered by translation, which SuperSplat barely does.
- `alphaClip` and `antiAlias` added to `splatquality.ts`. The old file claimed
  the engine ships six knobs; it ships eight, and one of the two it missed is
  the one SuperSplat actually sets.
- Phones load the **full 2.53M** scene. `?lite=1` selects the reduced bundle,
  which is kept, along with its pipeline — it is still the only lever that
  touches the depth sort.
- `__splat('lastpass')` restores the old preset in one call, so the regression
  is an A/B rather than a git archaeology exercise.

**On-demand rendering (`src/camera.ts`, `src/main.ts`, `src/perfhud.ts`)**

The fix for the multi-minute decay, and the top item on TEMPLATE's "still on the
table" for two passes. Measured in-page: **0 frames rendered across 180 frames
of sitting in a hero close-up.** Full write-up in `TEMPLATE.md`.

**The docked layout (`bluedio-phone.html`, `src/phonedock.ts`, `src/style.css`)**

A third page, not a replacement. Scene in a 4:3 window at the top, thumb pads and
the i/points row in a strip underneath, hero card replacing the pads in the same
strip with its × top-left — Will's mockup.

## 4. Why the docked layout is a performance change, not just a layout one

This is the part worth not losing. A 4:3 window at phone width is **~35% of the
area** of a full-bleed portrait screen, so the same frame cost buys ~1.7x the
linear resolution. That is why it can run at `perfScale` 0.75 where the
full-bleed page runs at 0.5, and it is the whole reason the docked page can be
sharper than either the old build *or* SuperSplat while costing about 1.5x the
old fill.

Three more things it fixes for free, none of which needed tuning:

- **The field of view.** Poses are authored at 68.6 degrees horizontal.
  Full-bleed portrait cannot show that without a 112-degree vertical fisheye, so
  `camera.ts` caps at 80 and the visitor sees **42.4 degrees — 62% of the
  authored framing**. A 4:3 window sits inside the cap entirely (v 54 / h 68.6).
  The portrait fov ceiling, open as a judgement call since 2026-08-22, simply
  stops being a question on this page.
- **The pads stop covering the scene.** They used to sit over both bottom
  corners of the picture.
- **The hero framing lift goes to 0.** It existed to stop a card covering the
  gear it describes; the card is not in the frame any more. Every hero pose is
  now shown as authored.

## 5. The one number that wants Will's eye

**The window aspect.** 4:3 was chosen and is the default. But the constraint
that actually bounds it is the fov ceiling, and 4:3 is nowhere near it:

| aspect | window | dock | v fov | h fov | authored framing intact? |
|---|---|---|---|---|---|
| 4:3 | 375x281 | 531px | 54.2 | 68.6 | yes — **shipped default** |
| 1:1 | 375x375 | 437px | 68.6 | 68.6 | yes |
| **0.85** | 375x441 | **371px** | 77.5 | 68.6 | yes — the ceiling, exactly |
| 0.80 | 375x469 | 343px | 80.0 | 67.7 | **no, clipping begins** |

**0.85 is the tallest window that still shows everything the poses were composed
to show.** At 4:3 the dock is 531px tall holding two 116px thumb pads, which is
a lot of dark; at 0.85 it is 371px, which is about the proportion the mockup was
sketched at. `?win=0.85` against no parameter is the A/B, and the pads are
anchored to the bottom of the dock either way so the empty space collects under
the picture rather than around them.

## 6. Open, and honest about it

*Updated after the phone test — see §7. Two of the three open numbers are now
answered.*

- ~~`perfScale` 0.75~~ **ANSWERED.** 60 fps, worst 18 ms, at dpr 2.01 on a
  WebGL2 iPhone. It holds, with headroom: the 0.85 window renders 57% more fill
  at the same frame time.
- ~~Full 2.53M vs the 1.2M bundle~~ ~~**ANSWERED.** `sort --` on the real device:
  the depth sort did not fire once. `?lite=1` is not needed and is kept only as
  a fallback for a genuinely slower phone.~~ **RE-ANSWERED THE OTHER WAY,
  2026-08-31 and 2026-09-02.** `sort --` was a still-ish camera under radial
  sorting; walking sorts continuously. A 1.6M bundle (not 1.2M — that one read
  as broken) is now the default on every phone and every WebGL2 device. See
  `sceneloader.ts` for the lineage and `TEMPLATE.md` → "Profiled 2026-09-02"
  for the upload-per-sort measurement behind it.
- **Still open: the window aspect** (§5 — 4:3 shipped, 0.85 is the fov limit and
  measured to have headroom), and **whether `colorUpdateAngle: 30` reads flat
  while walking**, which is the one quality deviation from SuperSplat and can
  only be judged in motion.
- **`?stats`'s sort line stays the arbiter for any future device.** If sort ever
  runs longer than a frame the picture *swims* rather than merely running slow,
  and no pixel knob touches it — that is when `?lite=1` earns its place. Splat
  count moves sort and nothing else; resolution and the culling knobs move fill
  and nothing else. They fail differently and are diagnosed separately.
- **`antiAlias` is exposed and off.** Genuine candidate for shimmer on small
  distant splats at reduced resolution, but the engine warns it may alter
  opacity on splats not trained with AA, and nobody knows which LichtFeld
  Studio did. `__splat({antiAlias: true})`, judge the drapes and the far wall.
- **Nobody has checked whether superspl.at serves an LOD-converted asset.**
  `supersplat-viewer` sets `splatBudget`, `lodUpdateAngle` and
  `lodBehindPenalty`, all no-ops on a flat SOGS bundle. If the editor builds an
  octree on upload, that is a *structural* advantage this viewer does not have
  and it is the remaining unexplained part of the comparison.
- ~~**Landscape on the docked page** falls back to the same rules as everything
  else~~ **DESIGNED, 2026-09-01.** Sideways, the dock becomes a transparent
  overlay over a full-bleed window — the full-bleed page's arrangement with no
  re-parenting (the `isPhoneDock` invariant holds). Pads in the bottom corners
  at 90% size, i/points bottom-centre, hero card as a bottom bar with a 0.15
  lift, render ratio dropped to the full-bleed scale for the ~2.3x canvas. The
  block is at the end of `stage.css`; the query is `PHONE_LANDSCAPE_QUERY` in
  `phonedock.ts`. Not yet judged on the device.
- **Hero dots on touch, same date.** The 22px dot was the "points don't
  respond" report: ~3.6 mm on a phone against a ~7 mm thumb landing, so taps
  missed the element and became zero-length drags. Markers are now inert under
  `pointer: coarse` and the canvas resolves a tap to the nearest dot within
  30px (`HeroPointManager.hitTest`, via the camera's `onTap`). Needs the
  device to confirm.
- The full-bleed `bluedio.html` is **unchanged structurally** and still the more
  immersive page on a fast phone. Keeping both means choosing is a link, not a
  revert.

## 7. The phone test — the thesis is confirmed

Will ran it on an **iPhone 16 Pro class device: 403 CSS px wide, DPR 3, iOS
Safari, WebGL2** (not WebGPU — so this is the slow path, the one that sorts 2.53M
splats on a worker thread). Read straight off `?stats` in his screenshots:

```
webgl2  60 fps  worst 18ms
810x608  0.49 Mpx  dpr 2.01        <- 4:3, the default
2.53M splats  sort --
```

```
webgl2  60 fps  worst 18ms
810x953  0.77 Mpx  dpr 2.01        <- ?win=0.85
2.53M splats  sort --
```

Every number in that readout is a claim from this pass being paid off:

- **`2.53M splats`** — the full asset, on a phone, on the WebGL2 path. The 1.2M
  reduction was never necessary. SuperSplat was right and the previous pass's
  central premise was wrong.
- **`sort --`** — the depth sort did not fire ONCE during the sample window.
  `radialSorting` is the reason, and it is the one thing from the 2026-08-23
  pass that was unambiguously correct.
- **`60 fps  worst 18ms`** — no dropped frames, at more than double the pixels
  the old build rendered.
- **`dpr 2.01`** — this is the whole resolution argument, on his actual device:

| | ratio | vs old build |
|---|---|---|
| old build | 1.000 | — |
| SuperSplat's own mobile default | 1.343 | 1.34x |
| **here, docked** | **2.015** | **2.02x** |

He is rendering **1.5x sharper than SuperSplat's default and 2x sharper than
the build he called "not photoreal"** — and it holds 60 fps. His device is DPR 3,
so the DPR-2 caveat in §2 does not apply to him: resolution really was half of
what it should have been.

The 0.85 window renders 0.77 Mpx against 4:3's 0.49 — 57% more fill, same
60 fps, same 18 ms worst frame. **There is headroom at 0.85**, which is the
argument for it beyond the framing one in §5.

## 8. The bug the phone test found — and it was mine

**The thumb pads did not work at all.** From `TEMPLATE.md`'s own framing this is
a re-parenting bug, and it is the exact class this layout is most exposed to.

The docked CSS neutralised the old `.stick { position: absolute; bottom: 74px }`
with **`position: static`**. That is not "not positioned" — it removes the pad as
a **containing block**, and each pad owns three absolutely positioned things that
silently re-resolved against `#phone-dock` instead:

| | what it does | what it did instead |
|---|---|---|
| `.stick-knob` | `left/top: 50%` | both knobs stacked at the dock's centre |
| `.stick::after` | `left/top: 50%` | "walk" and "look" overprinted into glyph soup — visible in the screenshot as a garbled disc between the pads |
| `.stick::before` | `inset: -20px` | **the input killer** |

`::before` is the invisible ring of slop around each pad and it inherits
`pointer-events: auto`. Resolved against the dock it became a hit target **20px
larger than the entire dock**. Two of them, stacked; the later one in DOM order
(the look stick) won every hit test. So the walk pad was unreachable and every
touch anywhere in the dock steered the camera — which is exactly "I can't
actually move around the scene properly."

Fixed with `position: relative` plus `top/right/bottom/left: auto`. The four
`auto`s are load-bearing: under `relative` the inherited `bottom: 74px` and
`left: 22px` stop being placement and become OFFSETS. Verified by hit-testing
straight across the dock, which now reads
`dock … LEFT … dock … RIGHT … dock` where before every point returned `RIGHT`.

Three things fixed alongside it, all consequences:

- **Slop ring -20px → -12px.** It shrank *because* the pad grew. -20px was sized
  for a 96px pad pinned to a screen edge; at 116px centred by `space-evenly`,
  two -20px rings **overlap by 10.7px on a 320px phone**. At -12px the same
  phone has 5.3px of clearance and the total thumb target is still bigger than
  before.
- **Labels moved out from under the knob** to 78% of the pad. Hiding them under
  the knob was right when the pads were a ghostly overlay on a photograph; in
  the dock they are the control surface, and a label you only see once you are
  already pushing is not a label.
- **The viewer window gained a second max-height cap**,
  `min(74svh, calc(100svh - var(--dock-min-h)))`. The dock needs a fixed 242px
  and has `overflow: hidden`, so `?win=0.62` — reachable from the knob this
  layout deliberately exposes — silently **clipped the pads by 15px** rather
  than complaining.

## 9. A pre-existing bug found in passing

The red rounded border on **ABOUT THIS DEMO**, present in one screenshot and
absent in the other, is not the new page's doing — it is a specificity leak that
had been live on `bluedio.html` since that page was created.

`#disclaimer-open` scores **0,1,0,0**. Both dark pages style that button through
`.solo-foot button` / `.phone-foot button`, which score **0,0,1,1** and lose. So
both were rendering the *paper reel page's* treatment: a pill border in `--line`
(a dark ink, near-invisible on a dark page) and `pulse-soft`, an **infinite red
ring that expands to 9px every 3.4 seconds**. Present in one frame, gone in the
next — which is precisely how it looked from outside.

Fixed by scoping the offender to `body:not(.solo):not(.phone)` rather than
escalating the dark pages' specificity, which is the convention this file
already follows for the per-demo hero-card rules (MOBILE_NOTES §2). A future
page now gets a plain button and opts in.

Worth noting the animation was `infinite`: on a page that now renders on demand,
that one element would have kept the compositor repainting forever. It never
gated the ENGINE — that decision is camera-only — so it was not a correctness
bug for the canvas, but it was a permanent trickle of battery for a button
nobody is looking at.

## 10. The audit, and the nine more defects it found

The thumb-pad bug in §8 was one instance of a *class* — re-parenting silently
changing what a rule resolves against — so a four-lens audit was run over the
docked layout (positioning/specificity, touch input, hover states, and the
device/chrome), every finding adversarially verified by an independent agent
told to refute it. 19 raised, **16 confirmed, 3 refuted**, deduplicating to nine
distinct defects beyond §8. All are fixed.

**The one that mattered most visually: the docked cards had no surface at all.**

```
--shell        #14100c            = rgb(20, 16, 12)     the dock's ground
--glass-strong rgba(20,16,12,.85) = the SAME rgb triple
```

Compositing 85% of rgb(20,16,12) over rgb(20,16,12) returns rgb(20,16,12).
**Contrast ratio 1.00 — the identical pixels.** The identity is deliberate and
was correct: those panels were designed to sit over a live splat, where the
alpha is the whole point. Re-parenting removed the photograph, so the hero card,
the help card, the stepper arrows and the i/points buttons were all reduced to a
1px hairline at 16% alpha with the copy floating loose on the dock. **This exact
correction had already been made for one element and not carried across** — the
thumb pads were re-tinted to a light fill with the comment "there is no
photograph under them any more". Now `--shell-2` (opaque, 1.14 against the
ground, 14.3:1 for body copy) on all four, and `backdrop-filter` dropped, since
blurring a flat fill is a full backdrop re-sample per frame for nothing —
which matters more than it used to on a page trying to let the GPU idle.

**Three findings were one root cause: `#stage-controls` lost its gate.** On every
other page it lives inside `#stage`, which parks in `<div id="stage-dock"
hidden>` until a viewer opens — so `[hidden]` kept it off screen before entry for
free. It is the only id in `DOCKED_IDS` shipping with no class of its own, so
moving it into the permanently-visible dock removed its only gate and nothing
replaced it. A points switch sat on the poster flipping its own knob and
`aria-checked` while `heroes` was still null: a control that lied, then took two
taps to work once a scene was live. Replaced with an explicit `data-state` on
the dock (`poster` / `roam` / `hero`) written by `refreshSticks()`. **`hero`
hiding the controls row is what the mockup drew** — the card and nothing else —
and it closes the next finding for free.

**The help card buried the gear card, including its close button.** Nothing made
them exclusive; full-bleed they sat at opposite corners, but the docked block
centres both on the same point and `#info-card` (z-29) paints over `#hero-card`
(z-28). Read the help, tap a piece of gear, and the camera flew to it while the
help copy stayed on top — the only way out being the other card's × in the
opposite corner. Fixed at the choke point (`showHeroCard()` hides the help card)
plus the state machine above, which means the i is not even reachable during a
close-up.

**A closed card kept eating taps for 400 ms.** An opacity-0 element is still
fully hit-testable, and `hideHeroCard()` defers `.hidden` by 400 ms so the fade
can finish — while `main.ts` re-shows the pads on the same tap. Full-bleed that
cost a corner; docked, the invisible card lies straight across the pads. Close a
close-up, reach for the walk stick, and the top of both pads was dead. Now
`pointer-events: none` at rest, `auto` on `.open`.

**Rotating the phone collapsed the page into a 400px column.** `@media
(min-width: 560px)`, written for a laptop review pass, is matched by an iPhone 16
Pro in landscape at 874 CSS px — review borders, dead shell either side and all.
Exactly the trap MOBILE_NOTES §2 records for `.ratio-tall`. A width test can
never tell "wide screen" from "phone turned sideways"; `and (pointer: fine)` can.

**The docked card's typography was width-dependent, in two layers.** At 874px
the `@media (max-width: 820px)` block stops applying, so the card fell back to
desktop sizes — measured **23px titles and 14.5px body**, sized for a 620px card,
inside the ~296×180 scroll box that is the smallest the docked card ever gets.
The per-demo `@media (min-width: 821px)` block leaked on top of that. Both fixed:
the per-demo rules scoped `body:not(.phone)`, and the base sizes restated inside
the docked block so a fixed-shape column stops changing shape with the window.

**Three smaller ones.** The card title still reserved a 30px right gutter for a ×
the docked layout moved to the left, squeezing the longest label to an extra line
on a 360px Android. `#phone-dock`'s `min-height` was a stale hand-written 176px
("two 96px pads plus air") against pads that are now 116px and a row that needs
242 — and being a min-height on a `flex: 1` item, the shortfall became an
overflow that pushed the controls row off screen rather than a squeeze. And
`refreshSticks()` was never re-run on a width-only resize, because the review
shell pins `#stage` to 400px, so dragging a window across the 820px breakpoint
changed it by zero pixels in both axes; it now listens to the media queries that
*are* the condition.

**Sticky `:hover` — the unfixed half of a bug this project already fixed once.**
MOBILE_NOTES §3 removed the tooltip *pseudo-element* under `@media (hover: none)`
and stopped there, leaving each button's own hover paint. Three consequences,
each a control reporting a state it is not in — and in this layout the stuck
state usually never clears, because `joystick.ts` calls `preventDefault()` on
pointerdown so a later tap on a pad does not move it either:

- **The points toggle painted brighter OFF than ON.** While on,
  `#points-toggle[aria-checked='true']` (1 id + 1 attr) outranks `.stage-ctl:hover`
  (2 classes). The instant a tap flips it to false that rule drops out, the stuck
  hover wins, and `.switch-knob { background: currentColor }` drags the knob
  near-white. Exactly backwards.
- **The i stayed lit after its card closed** — `:hover` and
  `[aria-expanded='true']` declare the identical pair of properties.
- **The last-used stepper arrow stayed lit**, reading as "previous disabled".

**And one regression that was mine, an hour old.** The `body:not(.solo):not(.phone)`
scoping I used for the red pulse ring scores (0,1,2,1) — `:not()` takes its
argument's specificity — which quietly beat the `prefers-reduced-motion` override
at (0,1,0,0). Turning motion off stopped stopping the pulse. Scoping by negation
also leaves the paper treatment as the default that every future page must opt
out of, which is the opposite of what my own comment claimed. Now `body.reel` on
index.html, opt-in, with the reduced-motion rule scoped to match so it wins on
source order.

**Refuted, and worth recording so nobody re-runs them:** that the dock never sets
`touch-action` and re-enables pinch zoom; that the bottom row sits inside the iOS
home-indicator strip; and that `viewport-fit=cover` with no `env(safe-area-inset-*)`
anywhere is a live defect. All three were checked and are not real here.

## 11. The method lesson

The 2026-08-23 pass A/B'd every knob against itself and found each one
defensible. Nothing A/B'd the **stack**, and nothing established a ceiling by
reading what the reference implementation does. Five compounding cuts each
looked reasonable in isolation; together they were the complaint. One afternoon
with `supersplat-viewer`'s source would have prevented all of it.

## Files

Changed: `src/device.ts`, `src/splatquality.ts`, `src/camera.ts`, `src/main.ts`,
`src/perfhud.ts`, `src/ui.ts`, `src/phonedock.ts`, `src/style.css`, `index.html`,
`vite.config.ts`, `TEMPLATE.md`.
New: `bluedio-phone.html`, `src/phonedock.ts`, this file.
