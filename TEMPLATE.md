# Wiring a new scan into the viewer

Bluedio is the reference implementation. Everything that makes it behave the way
it does lives in **shared, scene-agnostic code** — `camera.ts`, `heropoints.ts`,
`ui.ts`, `main.ts`. A new scan does not touch any of them.

You edit three things, and only the third is optional:

| File | What for |
|---|---|
| `src/demos.ts` | one `Demo` entry — the scene, its poses, its copy |
| `index.html` | one `<section>` containing the viewer window |
| `src/style.css` | *optional* per-demo card sizing, if the copy is long |

The starting point is [`src/demo-template.ts`](src/demo-template.ts) — a
type-checked `Demo` carrying Bluedio's settled values, with every field
annotated. It is not imported anywhere, so it ships nothing, but `npm run build`
typechecks it, so it cannot rot.

---

## 1. The asset

A `.sog` export is a zip of WebP textures. The viewer wants it **unpacked**, as a
folder of textures beside a `meta.json`:

```bash
unzip -o "MyRoom.sog" -d public/splat/my-room
```

The folder name is the demo `id`. `public/splat/` is committed — Common Room
already ships at 29.5 MB / 2.30M gaussians and Bluedio at 33 MB / 2.53M, so an
asset in that class is normal rather than a problem. Keep individual files under
GitHub's 100 MB limit (the largest texture in a 2.5M-gaussian scene is ~8 MB, so
this is not usually a concern).

For an asset too large to commit, `src` also accepts a full `https://` URL,
provided the host sends a permissive `Access-Control-Allow-Origin`.

## 2. The demo entry

Copy `TEMPLATE` from `demo-template.ts` into the `DEMOS` array in `demos.ts` and
rename the `id`. Leave `initialPose` and the hero poses as zeros for now — you
cannot guess them, and step 4 is where they come from.

## 3. The page section

Add a section before the `<footer>` in `index.html`. This uses only existing
classes, so it inherits the whole editorial style — **no new CSS required**:

```html
<section class="section my-room">
  <div class="wrap">
    <div class="sec-head">
      <span class="eyebrow">Client · Category</span>
      <h1>My Room</h1>
      <p class="sub">Subtitle</p>
    </div>

    <div class="viewer-window ratio-16x9" data-demo="my-room">
      <div class="poster">
        <div class="room"></div>
        <div class="inner">
          <div class="kicker">Medium-scale room demo</div>
          <div class="roomname">Enter My Room</div>
          <button class="enter" type="button"><span class="tri"></span> Step into the room</button>
        </div>
      </div>
    </div>
    <div class="viewer-caption">
      <span><b>2.5M</b> gaussians</span>
      <span><b>Detail</b> worth calling out</span>
      <span><b>Another</b> detail</span>
    </div>
  </div>
</section>
```

Two couplings that break silently if you get them wrong:

- `data-demo` **must** equal the `id` in `demos.ts`.
- The `.ratio-*` class must match `refAspect` — `ratio-16x9` with `16 / 9`,
  `ratio-tall` with `3.4 / 5.5`.

## 4. Author the opening shot

```bash
npm run dev
```

Open in **Chrome** (WebGPU), enter the window, and fly:

- drag = look around (mouselook — your eye stays put)
- right-drag = pan · wheel = dolly forward/back
- `W`/`S` forward/back, `A`/`D` strafe, `Q`/`E` down/up, `Shift` = 3x

Those are the **authoring** controls. They are what you get while a demo has no
`walk` block — or at any time under `?author`, which switches walk mode off
precisely so you can fly to a framing a standing body could never reach. Once you
add a `walk` block (step 8) a visitor gets height-locked walking instead: no
`Q`/`E`, `Shift` = 2x, right-drag strafes horizontally, and **the wheel does
nothing**. Dollying the eye at a fixed standing height reads as a phantom step
the visitor never took, and there is no honest wheel gesture for a walking body.
(It still zooms inside a hero close-up, which is a modal inspection state with
its own card up.)

The **page itself is frozen** for as long as a scene is live — see
`UI.lockPageScroll`. A viewer sits partway down a long editorial page, and a
stray trackpad flick used to slide the whole thing out from under the visitor.
The stage's X is the only way out, and it releases the lock. A hero card whose
copy overflows still scrolls on its own, because the lock is on the document
rather than on wheel events.

When the framing is right, run `__logPose()` in the console. It prints a
ready-to-paste `{ position, target, fov }`. Drop it into `initialPose`.

Movement speed is keyed to this pose's framing distance, captured once — so a
tight opening pose gives slow movement throughout the scene. If the room feels
sluggish, a slightly wider opening shot fixes it. (Walk mode is the exception:
speed there is absolute, in metres per second.)

The opening shot does **not** have to be somewhere a body could stand. Bluedio's
is 2.14 m up and 0.42 m outside its own walk region, because that is where the
room reads best on arrival — walk mode eases the visitor down and in on their
first step. Frame it for the shot, not for the constraint.

## 5. Author the hero poses

Fly to each piece, frame it, `__logPose()`, paste into that hero's `pose`. Put
the array in the order a visitor should tour the room — the card's prev/next
stepper walks it in order.

## 6. Anchor the dots — do not skip this

`anchor` is the dot's 3D position, and it is **not** `pose.target`.
`__logPose()` reports target as a look-at point a fixed ~0.6 m in front of the
camera, which is empty air. Omit `anchor` and the dot pins itself to that air:
correct in world space, but it slides across the object as you dolly, because a
fixed pixel offset covers a growing physical distance with distance.

Add `?author` to the URL for a crosshair, aim at the piece, and run
`__logAnchor()`.

**Bulk alternative.** If you have many heroes, `autoscene/anchors.py` derives them
from the poses you already authored: it ray-marches the decoded point cloud along
each view direction and returns the first real surface. Feed it a JSON list of
`{id, position, target}` straight out of `demos.ts`:

```bash
python anchors.py poses.json
```

It prints paste-ready `anchor:` lines plus each hit distance, so an outlier is
obvious — a hero whose surface is much further out than the rest usually means its
frame centre passes *over* the subject rather than onto it, which is worth
re-authoring rather than pasting. Verified against Bluedio: it reproduces all ten
hand-checked anchors exactly.

## 7. Tune the orbit arc

Click each hero and drag both ways. If the camera swings into a wall, restrict
that hero's `arc`:

```ts
autoOrbit: { pivot: 'anchor', direction: 'random', arc: [0, 40] },
```

Degrees relative to the landing yaw, asymmetric allowed. Measured sign:
**dragging right moves the offset negative**, so `[-50, 0]` is the side you reach
by dragging right. If you set one and the camera swings into the wall you were
avoiding, negate both numbers.

Idle sway takes a quarter of the arc, centred on the landing yaw, so the
authored framing is always part of the resting motion. Add `amplitude` if you
want a wide draggable arc but calm idle motion.

## 8. Walk mode

Optional per demo, and entirely off unless the demo has a `walk` block. With
one, the visitor is locked to a standing eye height and confined to a derived
region. Without one they free-fly, exactly as every demo did before walk mode
existed. Bluedio is the reference implementation.

### 8a. The three scene numbers

```ts
walk: { eyeHeight: 1.55, floorY: -4.2, unitsPerMetre: 3 },
```

`floorY` and `unitsPerMetre` are facts about the SCENE; `eyeHeight` is a design
choice layered on top of them. That is why they are three fields and not one —
retuning the eye height should never mean touching the scale.

It is also why walk mode is opt-in. A **guessed** floor puts the visitor's
eyeline in the wrong place, and then every framing in the room reads subtly
wrong. Only add a `walk` block to a scene whose floor you have actually derived.

For Bluedio all three come out of `autoscene`: the floor is the one sharp
density plane it finds (raw `.sog` y = +4.20, so world y = **-4.20** after the
180-degree roll), and the scale comes from the LichtFeld anchor — raw y = 0 is
1.40 m up, so 1.40 / 4.20 = **1/3 m per unit**, i.e. `unitsPerMetre: 3`.

`eyeHeight` is **1.55 m**, which puts the eye between the 1.4 m and 1.9 m capture
rings, so every horizontal look direction is bracketed above and below by a
covered height rather than extrapolating off the top one. Settle it against real
frames with `__eyeHeight(1.6)` rather than arguing about it on paper.

### 8b. Derive the envelope

```bash
python envelope.py --xyz ./xyz.npy --sh0 ./sh0.npy
```

`autoscene/envelope.py` reads the same occupancy grid `autoscene.py` builds and
emits a paste-ready `region:` block plus an `envelope.png` to judge it by. It
prints what matters: walkable area, **longest walkable path**, any stranded
pockets, and how far the ring smoothing relaxed each standoff.

Watch the path length rather than the area — area counts a wide dead end the same
as a route. Bluedio at `autoscene.py`'s own defaults is 2.54 m2 with **2.49 m** of
path, which reads as shuffling in place. At `envelope.py`'s defaults it is
8.23 m2 with **7.42 m**, which reads as exploring the room.

| Flag | Default | Does |
|---|---|---|
| `--wall` | `0.30` | m inset from the room plan — which is already the gear FACE |
| `--pad-tall` / `--pad-low` | `0.32` / `0.20` | m off each island, picked by its height |
| `--sigma` | `1.4` | cells of blur on the distance field before the ring is traced |
| `--falloff` | `0.25` | m of boundary softening, written into the emitted block |

**The island pad is almost always the binding constraint.** On Bluedio, 0.40 and
above strands the region in one corner and makes the whole console side
unreachable; 0.32 opens it up. A STRANDED warning means that is the first number
to move.

### 8c. Hand-correct it

Geometry cannot tell a drape from a doorway, so expect to correct the derived
region by eye. Annotate a copy of `envelope.png` and write the regions into an
edits file — its shapes are in **the figure's own coordinates**, so they can be
read straight off your markup:

```bash
python envelope.py --edits edits_myroom.json     # writes a starter if missing
```

`exclude` carves floor out unconditionally. `include` forces floor in where a pad
was too greedy — it is intersected with the room's free space first, so it can
relax a standoff but can never put a visitor inside a wall. `islandPads`
overrides one island's pad by the rank the script prints.

Two traps, both of which the script now warns about rather than leaving you to
guess: an `include` that does not **touch** the main region is dropped as a
stranded pocket and silently does nothing; and the figure's x axis is **negated**
against viewer world x, so "left" on the plot is "right" in the viewer.

### 8d. A thin passage: falloffZones

A single global falloff cannot suit both open floor and a narrow connecting
channel — 0.25 m is right in the open and swallows a 0.35 m channel whole. Add a
box with its own value, in `region.falloffZones`; the tightest zone containing a
point wins.

```ts
falloffZones: [{ min: [-0.75, -4.65], max: [3.75, -2.85], falloff: 0.1 }],
```

Be clear about what this buys, because it is easy to over-expect. Motion ALONG a
passage is tangential to both its walls, and tangential motion is never damped —
so a channel was never going to feel sticky lengthwise, whatever the falloff.
What the zone fixes is moving ACROSS it. Measured mid-channel in Bluedio at
d = 0.12 m: lengthwise 100% either way, but sideways toward the near wall goes
from 48% to 100%, and a 45-degree diagonal from 78% to 100%. Without the zone the
visitor is not stopped, they are subtly railed onto the centreline.

### 8e. Verify in the browser

Console helpers, all live:

| Call | Does |
|---|---|
| `__walkDebug()` | signed distance to the boundary, plus the backstop counter |
| `__eyeHeight(m)` | retune the eye height with no reload |
| `__walk(0)` / `__walk(1)` | switch walk mode off and back on |

Then walk it, and check four things:

1. **Walk the perimeter.** You should not be able to feel where the boundary is.
   If you can, lower `--falloff`.
2. **Slide along a wall at full stick.** It must not slow down. If it does, the
   tangential component is being damped, and that is a bug in `walk.ts` rather
   than a tuning problem.
3. **Trigger every hero and exit.** The camera must land back inside the region,
   at eye height, every time.
4. **`__walkDebug().backstops` should stay at or near 0.** It guards against a
   long frame carrying you out; it is not a working part of the loop. Climbing
   every frame means the falloff is mistuned.

## 9. Card sizing, if the copy is long

The shared bottom card is 520px. Bluedio's copy is a real paragraph per hero, so
it grows **wide rather than tall** — more characters per line is fewer lines, at
no cost to legibility. Copy that block in `style.css` and change the selector:

```css
#hero-card.bottom[data-demo="my-room"] {
  width: min(620px, calc(100% - 180px)); /* 180px keeps the outside arrows clear */
  max-height: 52%;
  padding: 18px 24px;
}
#hero-card.bottom[data-demo="my-room"] .hero-card-title { font-size: 21px; }
#hero-card.bottom[data-demo="my-room"] .hero-card-desc {
  font-size: 14px;
  line-height: 1.5;
}
```

Bluedio's ten cards land at 131–173px, 21–28% of the window, with every title on
one line and none scrolling. That is the target.

## 10. Verify

```bash
npm run build
```

`tsc --noEmit` runs first and **must** pass. Then in the browser confirm the
splat's eight textures all return 200, the stage reparents into your window, and
`__logPose()` returns your authored opening pose — that last one proves the asset
load callback ran end to end.

---

## The knobs, in one place

Per hero, all under `autoOrbit`:

| Key | Default | Does |
|---|---|---|
| `pivot` | `'view'` | `'anchor'` orbits the object. **Set this.** |
| `direction` | `'right'` | `'left'` / `'right'` / `'random'` — which way it sets off |
| `arc` | `[-60, 60]` | degrees either side of the landing yaw; asymmetric allowed |
| `mode` | `'sway'` | `'spin'` full turntable (ignores `arc`), `'none'` holds still |
| `amplitude` | quarter of `arc` | idle sway half-width |
| `speed` / `ease` | `7.5` / `6` | sway degrees-per-second, and easing near the ends |
| `yawLimit` | `60` | symmetric shorthand for `arc`; ignored when `arc` is set |

Per demo: `cardStyle`, `refAspect`, `initialPose`, `src`, `srcMobile`, `walk`,
`guide`, `guideTouch`.

### URL flags

Everything below is a diagnostic or an A/B handle; none changes what a visitor
sees by default. Most have a console twin, but the URL form is the one that
survives being typed on a phone — which is the only place several of them are
interesting. Detail in "Performance" below.

| Flag | Does |
|---|---|
| `?stats` | frame time / resolution / splat count / sort time readout. `__stats(1)` |
| `?gl` | force the WebGL2 fallback, to reproduce an older phone at a desk |
| `?res=N` | override the render pixel ratio outright, bypassing the budget. `?res=1` = the 2026-08-23 build |
| `?mpx=N` | the backing-store budget in megapixels (default 2.0; 0 = off, the pre-2026-09-02 native-up-to-DPR-2 desktop). `__mpx(n)` |
| `?adapt=0` | turn the frame-time governor off (it is on by default, and off whenever `?res` is given). `__adapt(0/1)`, `__adapt('reset')` |
| `?minfps=N` | the governor's floor, default 30 |
| `?perf=N` | override just the mobile scale. `?perf=0.5` = SuperSplat's default, `?perf=1` = SuperSplat with performance mode off |
| `?lite=1` | load the reduced 1.6M bundle (`srcMobile`) — the default on phones and on WebGL2 |
| `?full=1` | force the full 2.53M asset (the default only on a WebGPU desktop) |
| `?sortdist=N` | metres of camera travel before a re-sort (default 0.05; 0 = engine stock). `__sortGate({distance})` |
| `?sortangle=N` | the directional-sort twin, degrees (only after `__splat({radialSorting:false})`). `__sortGate({angle})` |
| `?pbo=1` | WebGL2: upload the sort order through a PBO instead of one `texImage2D`. For Firefox A/Bs. `__pbo(1)` |
| `?flybake=1` | keep re-baking colour DURING fly-ins (held by default). `__flyBake(1)` |
| `?ondemand=0` / `=1` | force on-demand rendering off / on. Default: on for touch |
| `?win=N` | docked page only — the viewer window's aspect ratio. `__win(n)` |
| `?author` | authoring mode; also forces the full asset and disables walk mode |
| `?sharpen=N` | CAS sharpening A/B. `__sharpen(n)` |
| `?fov=N` | portrait fov ceiling. `__maxFov(n)` |
| `?look=N` | look-stick degrees per second. `__lookRate(n)` |
| `?lift=N` | hero framing lift, as a fraction of frame height. `__heroLift(n)` |
| `?touch=0` / `?touch=1` | force the thumb pads off or on. `__sticks(0/1)` |

Console-only: `__splat()` for the eight splat cost/quality knobs (including
`__splat('lastpass')`, the preset judged too aggressive on 2026-08-24), plus the
existing `__walk(0/1)`, `__eyeHeight(m)`, `__walkDebug()`, `__logPose()` and
`__logAnchor()`. `__sortGate()`, `__flyBake()` and `__pbo()` are the console
twins of the 2026-09-02 profiling flags above.

### The stage controls

Two controls sit in the viewer's bottom-left corner, and both are chrome the
shared code owns — a new scan gets them for free.

The **i** opens a navigation-help card built from the demo's `guide` field:
a `title`, a list of `{ key, action }` rows, and an optional `note`. Omit
`guide` and the i hides itself. It duplicates the copy under the viewer on
purpose — the page is frozen while a scene is open, so that copy is unreachable
exactly when someone wants it. Keep the two in step.

**Write `guideTouch` as well.** It is the same shape, shown instead of `guide` on
a phone, and it is not optional in practice: `guide` names keys — W A S D, Shift,
Esc — that a touch screen does not have, and on a phone this card is the *only*
navigation help that can be reached at all. A demo with `walk` gets thumb sticks
on touch, so the touch copy should name the **left stick** (walk) and the **right
stick** (look) rather than the keyboard. Omit it and touch visitors fall back to
`guide`, which is better than nothing and worse than a sentence of work.

### Touch controls

Nothing to configure. On a touch-shaped viewport (`pointer: coarse`, or a
viewport at or under the 820px mobile breakpoint) a demo that declares `walk`
gets two thumb sticks — left walks, right looks — shown only while free-roaming
and hidden for the duration of a hero close-up. A demo with no `walk` block gets
none, because sticks that cannot move anything are a lie.

They are analog: a half-pushed stick walks at half speed. Both feed the same code
paths as the keyboard and the mouse, so the walk region, the eye-plane pin and
the hero yaw arcs all apply without the touch path knowing they exist.

The pads sit **above** the bottom-left controls row, not beside it, because the i
and the points toggle stay where they are and a left thumb lands on that corner.
Inset is 35px on the mobile breakpoint and 22px above it — on a tablet the hands
are further apart, so there the pads want to stay nearer the corners.

**A finger's tap on a hero dot is resolved by the canvas, not by the dot.** Under
`(pointer: coarse)` the marker elements are inert (`markers.css`) and the camera
reports taps — one finger, under 12px of travel, under 400 ms — through
`onTap`; `main.ts` hands the position to `HeroPointManager.hitTest()`, which
picks the nearest visible dot within 30 CSS px. The 22px dot is ~3.6 mm on a
phone, and a thumb lands within ~7 mm of its aim, so most taps at a dot used to
miss it and become a zero-length drag. Growing the element would have let it
steal orbit drags in a close-up (the other dots stay on screen there); resolving
the tap on the canvas keeps every drag a drag. A mouse still clicks the element.

**Landscape on the docked page** (`bluedio-phone.html` turned sideways) is the
full-bleed arrangement without any re-parenting: under `(orientation: landscape)
and (max-height: 560px)` the dock becomes a transparent overlay on a full-screen
window, the pads sit in the bottom corners at 90% size (104px), the i/points
row sits bottom-centre, and the hero card is a bottom bar with a 0.15 lift. The
render pixel ratio follows the layout too — the full-bleed scale (0.5) sideways,
the docked scale (0.75) upright — because the canvas is ~2.3x the area. The
query string lives in `phonedock.ts` as `PHONE_LANDSCAPE_QUERY`, copied
verbatim into `stage.css`; keep the two identical.

Two things a touch device also changes, both easy to miss:

- **Tooltips are suppressed** under `(hover: none)`. A touch screen fires
  `:hover` on *tap* and then leaves it stuck, so the `data-tip` chip appeared
  over the very card the tap had just opened. Removed with `content: none`; the
  `aria-label` still carries the words. Desktop tooltips are untouched.
- **Hero close-ups lift their subject** — see "Hero framing on a phone" below.

### Hero framing on a phone

The mobile hero card is a centred object in the bottom third, and on a hero with
a real paragraph of copy it grows tall enough to cover frame centre — which is
exactly where a fly-in parks its subject. So on the mobile card layout the camera
**aims slightly below the pivot**, putting the subject `heroLift` of the frame
height above centre. Default **0.27**; measured, the subject moves from 50% to
23% of the frame, and the tallest of Bluedio's ten cards (269px, top edge at
59.7%) still leaves ~37% of the frame clear.

Two things about how it is implemented, because both matter if you touch it:

- It is a **look-at offset**, not a change to the pose. The camera still lands on
  the authored `position` byte-for-byte, the orbit pivot stays *on* the object so
  auto-orbit still circles the gear rather than a point beneath it, and
  `__logPose()` still reports the authored framing. Authoring is unaffected.
- The maths is exact: `shift = 2 · f · distance · tan(vFov/2)` puts the pivot `f`
  of the **frame height** above centre. It eases over 0.35s in both directions;
  applied instantly it jolts at the start of every fly-in.

Desktop gets `0` — its card is a wide shallow bar that clears the subject, and
lifting there would recompose every hero pose you authored.

Note the lift is a fixed fraction, so it is tuned for the tall cards and slightly
over-lifts the short ones. If that reads wrong, the other lever is trimming the
card's `max-height` and using a smaller lift.

### The tuning knobs

Every "feel" number in the mobile pass was judged by holding a phone, so every
one of them is reachable **from** a phone as a URL param — a console is not.
Params survive a reload; the console twins do not.

| Param | Console | Default | What it is |
|---|---|---|---|
| `?fov=N` | `__maxFov(n)` | `80` | portrait vertical-fov ceiling (below) |
| `?look=N` | `__lookRate(n)` | `75` | look-stick degrees/second at full push |
| `?lift=N` | `__heroLift(n)` | `0.27` | hero subject lift, fraction of frame height |
| `?touch=0\|1` | `__sticks(0\|1)` | auto | force the pads on or off |

They compose: `?look=60&lift=0.2`. `?lift=0` is meaningful — it turns the lift
off for a clean A/B. Called with no argument, `__maxFov()` reports the fov
actually being rendered, which is the fastest way to tell an authored fov from a
compensated one.

`?fov=115` and `?look=105` restore the pre-tuning values if you ever want to see
what was being complained about.

### Portrait, and the field-of-view ceiling

On a portrait phone the frames go **vertical** — `.ratio-*` becomes 9:16 under
`(max-width: 820px) and (max-aspect-ratio: 1/1)` — which roughly doubles the
usable frame on a 375px-wide screen. Landscape phones keep 4:3. Both carry a
`max-height` so the frame cannot grow taller than the screen it is shown on, and
both need `width: 100%` beside it: without a definite width, Chrome satisfies the
cap by shrinking the *width* to preserve the ratio, and the frame pulls away from
the column it should fill.

`camera.ts` compensates fov on any viewport narrower than `refAspect`, to keep the
authored horizontal coverage. That is right for 16:9 → 4:3 and **wrong for
portrait**: holding a 68.6° horizontal field at aspect 0.46 costs a 112° vertical
fov, which is a fisheye. `maxEffectiveFov` caps it at **80°**, so portrait gives up
horizontal coverage instead — the right thing to give up when a look stick turns
your head in a fraction of a second. It never binds on a landscape viewport, so
desktop framing is untouched. Retune with `__maxFov(n)`; `__maxFov(115)` restores
the pre-cap behaviour.

The **switch** beside it shows and hides the hero-point markers, so a visitor can
look at the room without dots over it. It reads "Point visibility" on hover,
defaults to ON, and its state **survives a scene load** — `HeroPointManager`
keeps the visitor's preference separate from the load gate that hides markers
while a splat streams in, so `setVisible(true)` on arrival cannot switch the
points back on for someone who turned them off. Nothing per-demo to configure.

Per demo, all under `walk` — omit the whole block for the old free fly:

| Key | Default | Does |
|---|---|---|
| `eyeHeight` | — | standing eye height, METRES above `floorY` |
| `floorY` | — | world y of the floor plane |
| `unitsPerMetre` | — | scene scale; every other distance in the block is metric |
| `speed` | `1.25` | m/s. `runMultiplier` (`2`) is Shift |
| `accel` | `0.11` | s. The ramp that reads as a body rather than a cursor |
| `settle` | `1.1` | s easing from the opening shot down and in. `0` starts standing |
| `look` | none | optional `{down, up}` pitch clamp. Free by default — **leave it** |
| `region` | none | the walkable region; omit for height-locked but unbounded |

Inside `region`: `outer` (and optional `innerRings` / `holes`) in WORLD units;
`falloff` (`0.25`) and `spawnMargin` (`0.30`) in METRES; `falloffZones` for local
overrides — boxes in WORLD units carrying a METRES falloff, tightest wins.

Global, in `main.ts`: `HERO_PIVOT_PUSH` (0.18) — how far past the surface anchor
the orbit pivot sits, as a fraction of the camera-to-anchor distance.

## Performance — where the frame time goes

**Profiled 2026-08-23, and again 2026-09-02.** This section used to open
"nobody has profiled this viewer yet". That is no longer true, and everything
below is measurement rather than arithmetic. The instrument is in the page:
**`?stats`**. The 2026-09-02 pass — a Firefox profile from a laptop, a screen
recording from an iPhone 18 Pro, and a desk reproduction with `?gl` — is
written up in "Profiled 2026-09-02" below; read it before touching the sort or
the bake.

### Read the instrument first

`?stats` (or `__stats(1)`) puts a readout in the top-left corner:

```
webgl2  60 fps  worst 17ms
375x812  0.30 Mpx  dpr 1.00
1.60M splats  sort 8ms x16
up x7 4.9ms  bake x2
```

Every line answers a question you would otherwise guess at.

- **renderer** — `webgpu` or `webgl2`. Establish this before anything else. The
  two are not variations of each other: WebGPU sorts on the GPU, WebGL2 ships
  the centres to a worker and counting-sorts the whole cloud on the CPU. Two of
  the engine's culling knobs (`minContribution`, `foveationStrength`) are
  WGSL-only and do **nothing at all** on WebGL2 — so on exactly the devices that
  struggle, the most powerful-sounding settings are inert. Older phones and any
  in-app browser wrapping WKWebView land here.
- **worst** — the slowest frame in the window. Judge stutter on this, never on
  the fps mean. A 60 fps mean with one 45 ms frame per second reads as "laggy"
  to a person and as "fine" to an average.
- **Mpx / dpr** — the backing-store size, which is the fill workload. Not the
  CSS size.
- **sort** — depth-sort milliseconds, from the engine's own `gsplat:sorted`
  event. This line separates the two mobile failure modes, which look identical
  from outside and have **opposite** fixes:
  - *sort small, fps bad* → fill-bound. Cut resolution and overdraw.
  - *sort longer than a frame* → the order arrives stale, so the image **swims**
    while you move rather than merely running slow. Only cutting splat COUNT
    helps; the sort is linear in it and no pixel knob touches it.
- **up** *(added 2026-09-02, WebGL2 only)* — order-texture uploads this window
  and the mean time the main thread spent inside each `texImage2D`. Every
  completed sort re-uploads the WHOLE order texture (11.67 MB at 2.53M), and
  that call is the one place a frame waits for the GPU queue — so ~1 ms means
  the GPU is keeping up and 5-18 ms means it is not. `--` on WebGPU, where the
  order never leaves the GPU.
- **bake** *(added 2026-09-02)* — full colour re-bakes this window, i.e. the SH
  pass over every resident splat that camera *translation* triggers. GPU work,
  invisible to every other number here. If the frame dips and `sort` and `up`
  are quiet, this is what did it.

Two companion flags make the phone reproducible at a desk:

- **`?gl`** forces the WebGL2 fallback on a machine that has WebGPU. Without it
  a laptop only ever exercises the path that was not the problem.
- **`?res=N`** overrides the render pixel ratio. `?res=2` reproduces exactly
  what shipped before the mobile pass.

And **`?full=1`** loads the desktop asset on a phone, which is the honest A/B
for judging what the reduced bundle costs.

### What was actually wrong, in order of size

> **REVISED 2026-08-25.** Two of the four findings below were overcorrected and
> one was simply wrong about SuperSplat's arithmetic. The picture that shipped
> came back judged "resolution dropped much too drastically, lost the photoreal
> characteristics, culling much too aggressive" — and that was a fair reading.
> Read "The overcorrection, and what SuperSplat actually does" immediately
> below before acting on any number in this subsection.

Measured on the WebGL2 path at a 375x812 portrait frame.

**1. Render resolution — the single biggest lever, and the whole SuperSplat gap.**
`maxPixelRatio` was capped at 2 for every device, which is far too sharp for a
phone. Cutting it was right. Cutting it to a flat **1.0** was not — see below.

**2. Splat count — the only thing that touches the sort.** See
`autoscene/RUNNING.md` → "mobile_asset.py". The default has moved three times
and the lineage lives in `sceneloader.ts`; **as of 2026-09-02 the 1.6M bundle
is the default on every phone AND on every WebGL2 device**, and only a WebGPU
desktop loads the full 2.53M. The 1.2M bundle that this pass built was replaced
by the 1.6M one on 2026-08-31 (the 1.2M read as broken on the device — floors
and desks thinned to see-through). `?lite=1` / `?full=1` override either way.

**3. `radialSorting` — a threshold, not a preference.** The engine re-sorts when
the camera changes by more than `1e-3`, but *which quantity* that tests depends
on this flag. Directional (the default) tests the forward vector, so
`acos(dot) > 1e-3 rad` = **0.057 degrees** of rotation, and position is ignored
entirely. The look stick turns at 75 deg/s — 1.25 deg per frame, twenty-two
times over threshold — so simply looking around requested a re-sort every frame.
Measured A/B while swinging the look:

| | sort activity | worst frame |
|---|---|---|
| directional (engine default) | `14ms x2` | 33 ms |
| radial | none | **18 ms** |

It is a genuine trade — radial re-sorts on translation instead, and walk mode
translates — so it is in the mobile preset and A/B-able with
`__splat({radialSorting: false})`.

**4. `alpha: false` and `stencil: false` on the device.** Both defaulted to
true and neither is used. An alpha-backed canvas is composited SRC_OVER against
the page every frame and can never be promoted to an opaque layer; the stencil
allocated a packed depth-stencil attachment across the whole surface for a
renderer that never reads one. **This one stands unchanged.**

### The overcorrection, and what SuperSplat actually does

*Added 2026-08-25, after reading `playcanvas/supersplat-viewer` rather than
inferring it from behaviour. This supersedes the resolution and culling
conclusions above.*

**The formula.** SuperSplat does not "halve the canvas". It caps the SHORT AXIS
OF THE SCREEN at a physical pixel count and *then* halves:

```js
const maxPixelDim = platform.mobile ? 1080 : 2160;
const pixelRatio  = Math.min(maxPixelDim / Math.min(screen.width, screen.height),
                             window.devicePixelRatio);
const scale       = pixelRatio * (performanceMode ? 0.5 : 1.0);  // mobile default: on
```

The 0.5 is applied to a ratio that is already near the device DPR, not to 1.0.
Worked through, and note that the answer **depends on the device**:

| phone | SuperSplat (perf on) | SuperSplat (perf off) | old build | new full-bleed | new docked |
|---|---|---|---|---|---|
| 390x844, DPR 3 | 1.385 | 2.769 | 1.000 | 1.385 | 2.077 |
| 375x812, DPR 2 | 1.000 | 2.000 | 1.000 | 1.000 | 1.500 |

**So the old flat 1.0 matched SuperSplat exactly on a DPR-2 phone and was half
its linear resolution — a quarter of its pixels — on a DPR-3 phone.** Do not
repeat the claim that resolution was the whole gap: on an older DPR-2 device it
was not the gap at all, and the softness there came entirely from the culling.

**The culling is where this viewer was genuinely the aggressive one.** Every
shared knob, engine stock vs SuperSplat vs what shipped:

| knob | engine stock | SuperSplat | old preset | now |
|---|---|---|---|---|
| `alphaClip` | 0.3 | **1/255** — keeps *more* | untouched (0.3) | **1/255** |
| `alphaClipForward` | 1/255 | untouched | **0.03**, 7.6x harsher | 1/255 |
| `minContribution` | 3 | **1** — keeps *more* | 6 | 3 |
| `minPixelSize` | 2 | untouched | 3 | 2 |
| `colorUpdateAngle` | 10 | 0.2 (1 in perf mode) | 30 | 30 |
| `radialSorting` | false | true | true | true |
| splat count | — | full 2.53M | 1.2M | full 2.53M |

SuperSplat moves three knobs and **every one keeps more splats than the engine
would by default.** The old preset moved five and every one kept fewer, on top
of half the gaussians and (on a DPR-3 phone) a quarter of the pixels. Five
simultaneous cuts, never A/B'd against each other, against a benchmark that
makes none of them. That is the whole of the "too aggressive" report.

`alphaClipForward: 0.03` is the one to understand, because it is not merely a
cull: the vertex shader sizes each quad by
`clip = min(1, sqrt(log(alpha / alphaClipForward)) * 0.5)`, so raising the floor
**shrinks every gaussian** and deletes the faint tail outright. That faint tail
is most of what makes a splat scene read as a photograph rather than as
geometry. It is the single likeliest cause of "lost the photoreal look".

**The method lesson, which is the durable part.** The previous pass A/B'd each
knob against *itself* and found each one defensible. Nothing A/B'd the STACK,
and nothing established a ceiling by asking what the reference implementation
actually does. One afternoon reading SuperSplat's source would have prevented
five compounding cuts. Read the reference before tuning against it.

### The splat knobs, and which ones your device honours

The engine ships **eight** cost/quality parameters on `app.scene.gsplat` — the
"six" this section used to claim missed `alphaClip` and `antiAlias`, and missing
`alphaClip` mattered, because it is the one SuperSplat actually reaches for.
Every one ran at its stock default for the life of this project, because
`main.ts` added the gsplat component with no options and never touched the scene
params. They now live in `src/splatquality.ts`, are applied **once** at scene
load on touch devices, and are tunable live:

```
__splat()                            report current values + which are live here
__splat({ alphaClipForward: 0.06 })  set one or more
__splat('mobile')                    the current preset
__splat('off')                       engine stock
__splat('lastpass')                  the OLD preset, judged too aggressive
```

`__splat('lastpass')` against `__splat('mobile')` while walking is the honest
A/B: it is exactly the change made on 2026-08-25, one call each way.

| knob | stock | SuperSplat | mobile | works on |
|---|---|---|---|---|
| `alphaClip` | 0.3 | 1/255 | **1/255** | both |
| `alphaClipForward` | 1/255 | untouched | 1/255 | both |
| `minPixelSize` | 2 | untouched | 2 | both |
| `colorUpdateAngle` | 10 | 0.2 | **30** | both |
| `radialSorting` | false | true | **true** | both |
| `antiAlias` | false | configurable | false | both |
| `minContribution` | 3 | 1 | 3 | **WebGPU only** |
| `foveationStrength` | 0 | unused | 0 | **WebGPU only** |

The mobile preset now deviates from engine stock in exactly **three** places,
and only one of them costs quality:

- `alphaClip` 1/255 — a quality *increase* over stock, matching SuperSplat.
- `radialSorting` true — a re-sort threshold change, not a quality trade.
- `colorUpdateAngle` 30 — **the one deliberate deviation from SuperSplat**, and
  it is deliberate because SuperSplat is an ORBIT viewer and this is a WALK
  viewer. The re-bake trigger is camera *translation*, which orbiting barely
  does and walking does constantly. Challenge this first if anything looks flat
  in motion.

`antiAlias` is off rather than on because the engine's own caveat is that it is
meant for splats *trained* with anti-aliasing, and "if the source splats were
generated without anti-aliasing, enabling this option may slightly soften the
image or alter opacity". Nobody has established which LichtFeld Studio did for
Bluedio. It is a genuine candidate for shimmer on small distant splats at
reduced resolution — A/B it with `__splat({antiAlias: true})` and judge the
drapes and the far wall. Note it forces a **shader recompile**, so expect a
hitch on the call that changes it.

`alphaClipForward` is the one worth understanding, because it is not merely a
cull. The vertex shader sizes each gaussian's quad by
`clip = min(1, sqrt(log(alpha / alphaClipForward)) * 0.5)`, so raising the floor
**shrinks every quad** and deletes outright anything fainter than the floor. At
0.03 an opaque splat keeps ~85% of its linear extent; a 10%-alpha splat keeps
~55%. It bites hardest exactly where the cost is concentrated — an offline pass
over this scene measured ~4% of the gaussians, the big faint haze, carrying
roughly a third of all projected screen area.

`colorUpdateAngle` matters specifically because this is a *walk* viewer. The
bundle carries view-dependent colour, which the unified renderer bakes into the
work buffer and re-bakes after `tan(colorUpdateAngle)` world units of
translation — at the default 10 degrees, every **5.9 cm**. Walking at 1.25 m/s
re-baked all 2.5M splats about twenty times a second. 30 degrees gives 19 cm.

`foveationStrength` is first-party foveated rendering, shipped in 2.20.0 and
used by nobody — neither this viewer nor SuperSplat's. It raises the cull
threshold radially from screen centre, leaving the middle sharp. On a portrait
phone with a centred subject it is close to free. WebGPU only.

### Dead ends — measured, so nobody re-runs them

- **Upgrading the engine.** 2.21.0 to 2.21.4 changes 16 files, none of them
  gsplat; the newest gsplat commit reachable from the 2.21.4 tag predates
  2.21.0. All the gsplat work landed in 2.20.0. SuperSplat pins 2.21.3.
- **`unified: true`.** Already the engine default in 2.21 — a no-op.
- **`splatBudget` / LOD.** A hard no-op on a flat SOGS bundle: the budget only
  trims octree resources and counts everything else as immovable. Needs a
  streamed SOG, which `splat-transform` will not synthesise from one input.
- ~~**Copying SuperSplat's `scene.gsplat` settings.**~~ **REVERSED 2026-08-25.**
  The observation was right — it sets `minContribution`, `alphaClip` and
  `colorUpdateAngle` *lower* than engine defaults — and the conclusion drawn
  from it was backwards. That those values are quality-UP is the *finding*, not
  a reason to dismiss them: it is the evidence that SuperSplat's smoothness is
  not bought with culling, which is what made five simultaneous cuts here look
  reasonable when they were not. `alphaClip: 1/255` is now adopted verbatim.
  `colorUpdateAngle` is the one value correctly left alone, and only because
  this is a walk viewer and that one is triggered by translation.
- **Hero markers and the walk SDF.** Both suspected in the previous version of
  this section; both measured and refuted. 40 marker style writes cost ~4-8 us a
  frame; Bluedio's 49+14-vertex region SDF costs 1.0 us while walking. Noise
  next to a million-splat sort. (`left/top` instead of `transform` is 0.037
  ms/frame — real, and still noise.)
- **Culling splats invisible from the reachable camera set.** Sound in theory —
  the walk polygon and hero poses are known ahead of time — but measured
  negative, and deletion-based pruning blotches surfaces. See RUNNING.md.

### On-demand rendering — landed 2026-08-25

**This was the top item on "still on the table" for two passes, and it is the
fix for "the frame rate drops after a few minutes."** That symptom is thermal:
`autoRender` was true for the whole session, so a phone showing a *completely
stationary picture* still rasterised the entire splat cloud sixty times a
second, heated up, and throttled. No per-frame tuning can fix it, because the
problem is the frames existing at all.

Measured in-page, walking and then standing still on the docked page:

| state | frames rendered |
|---|---|
| walking | every frame |
| easing to a stop after releasing the stick | ~35 frames, then cold |
| standing still, 60 frames | **0** |
| reading a hero card, 180 frames (3 s) | **0** |
| after a `gsplat:sorted` event | exactly 3 (the render hold) |

**How the idle test avoids the trap this section used to warn about.** The
previous note said `pinEyeTo()`'s `drift !== 0` fires on ~25% of idle frames
from a 1-ulp float residue and would defeat a naive detector. It would. So the
test is not a flag: `camera.ts` snapshots the five numbers that *every* motion
source writes (`target`, `distance`, `yaw`, `pitch`, `fov`) and compares them
with **epsilons sized to swallow the residue** — 1e-4 world units against a
~5e-7 ulp, which is 0.03 mm at 3 units per metre. Being a snapshot rather than
an enumeration, it also cannot be broken by adding a motion source later.

Three things outside the camera call `controller.wake()`, and forgetting any of
them shows a stale picture: a splat landing, a canvas resize, and **a depth sort
completing on the worker** — that last one is asynchronous, so the frame drawn
before it arrived is holding the previous splat ordering.

It does not arm until ~90 frames after a scene lands. The bake, the first sort
and the auto-framing all resolve over several frames after `load` fires, and
sleeping through them is how this optimisation shows a black or half-sorted room.

**The infinite `ping` marker animations turned out not to matter**, contrary to
the old warning: they are CSS on DOM elements, so they never touch the engine's
render decision. The thing that *did* have to change is **auto-orbit**, which is
real camera motion and would have kept a hero close-up — the state a visitor
sits in longest — awake permanently. It is dropped on touch devices; desktop
keeps it. Without that, on-demand rendering buys nothing during the one state it
most needs to.

`?ondemand=0` turns it off for an A/B; `?ondemand=1` forces it on desktop.

**`?stats` reads `idle · not drawing` when it is working.** The HUD samples on
`frameend`, which stops firing entirely when the page sleeps, so it grew a
`tick()` off `update` — otherwise it freezes mid-number and goes on displaying
whatever fps the visitor last moved at, which is worse than a wrong number.

### Still on the table

- **A mobile bundle without spherical harmonics.** With `shN.bands = 0` the
  engine never runs the colour re-bake at all (`hasSphericalHarmonics` false),
  the two `shN_*.webp` files (~3.4 MB of the 22.6 MB) go away, and the fly-in
  hold becomes moot. The cost is view-dependent colour — a flatter specular on
  the drum shells and the glass. Worth an on-device A/B before the next
  `mobile_asset.py` run; see "Profiled 2026-09-02".
- **Upstream PRs** for a public sort threshold and a chunked WebGL2 order
  upload — see the end of "Profiled 2026-09-02". Until then
  `core/gsplatinternals.ts` carries the local version and must be re-checked on
  every engine bump.
- **`gsplatCentersEnabled = false` on WebGPU**, which skips a ~71 MB load-time
  transient. Must stay true on WebGL2, where the CPU sorter needs the centres.
- **Streamed SOG with real LOD levels**, which is the only route to
  `splatBudget` and the mechanism SuperSplat actually uses. Worth more attention
  than it has had: `supersplat-viewer` sets `splatBudget`, `lodUpdateAngle` and
  `lodBehindPenalty`, so if superspl.at serves an octree-converted asset rather
  than the flat `.sog` it was given, that is a *structural* advantage over this
  viewer rather than a tuning one — and it would be the remaining unexplained
  part of the comparison. Nobody has checked which it serves.

### Already done, so do not rediscover these as wins

- **On-demand rendering** — see the section immediately above.
- `app.autoRender = false` whenever no viewer is live, and the stage is parked
  in a hidden dock. A closed viewer costs nothing.
- Exactly one splat in memory at a time; `unloadScene()` destroys the entity and
  unloads the asset, including on the superseded-mid-load path.
- The engine is not created at all until the first Enter click.
- `antialias: false` — splats do their own edge softening.
- No `CameraFrame` is constructed unless `?sharpen` is passed.
- **2026-09-02, all in "Profiled 2026-09-02" above:** radial sorting and
  `colorUpdateAngle` 30 on every device; the 5 cm sort gate on the WebGL2
  re-sort trigger; the 1.6M bundle on WebGL2 as well as on phones; colour
  re-bakes held during fly-ins; the 2.0 Mpx render budget; the 30 fps
  frame-time governor with its not-fill-bound revert; the `up` / `bake` / `res`
  HUD lines. The PBO order-upload path was measured worse on Chrome and is
  exposed only as `?pbo=1` for a Firefox A/B.

### One measurement trap

A browser pane that is not displayed reports `document.hidden`, so
`requestAnimationFrame` never fires and the engine does not tick. Profile on a
real device, or with the pane visible. See "Gotchas" #13.

### Profiled 2026-09-02 — the order upload, the re-bake, and two phones

Three new datapoints arrived together, and they point at two mechanisms,
neither of which is the hero points or the cards.

**1. A Firefox profile from a laptop (Linux, so WebGL2).** 51% of all script
time — 1.08 s of a 14 s capture — was inside `WebGL2RenderingContext.texImage2D`,
reached through `applyPendingSorted → onSorted → setOrderData → uploadDirect`.
That is the engine uploading the result of the CPU depth sort. On WebGL2 the
order lives in an R32U texture of `textureSize²` texels (1708² = 11.67 MB for
2.53M splats) and the engine re-specifies the WHOLE texture with one
`texImage2D` every time a sort completes. It does this deliberately: its source
says the PBO + `texSubImage2D` alternative "stalls the main thread on multi-MB
uploads through Chrome's renderer→GPU IPC". The main thread was otherwise ~85%
idle in that profile — the laptop is GPU-bound, and `texImage2D` is where the
main thread queues behind the GPU.

**2. A screen recording from an iPhone 18 Pro (WebGPU, docked page, 1.6M).**
Free roam holds 60 fps with a worst frame of 17-19 ms. Every dip — 36-52 fps
with 60-94 ms worst frames — coincides with a hero fly-in or the fly-home after
closing a card. Nothing else in the recording moves the camera metres in a
second. The one thing in the pipeline that keys off camera TRANSLATION and
touches every splat is the colour re-bake: at the mobile preset's 30° it runs
every 19 cm, so a 4 m fly-in bakes 1.6M splats ~20 times in 1.6 s.

**3. Reproduced at a desk** — `bluedio.html?gl&stats`, Chrome/Windows, 2.53M at
1280x720, the engine pumped by hand because the pane was hidden (gotcha 13).
Four seconds of each motion, `radial` = `radialSorting`, `cua` =
`colorUpdateAngle`:

| motion | settings | sorts | uploads | upload mean / max | main-thread mean / worst | colour bakes |
|---|---|---|---|---|---|---|
| mouse-look, 6 drags | directional (old desktop default) | 6 | 6 × 11.67 MB | 1.0 / 2.4 ms | 0.3 / 2.5 ms | — |
| mouse-look, 6 drags | radial | **0** | 0 | — | 0.1 / 0.3 ms | — |
| walk 4 s | radial, cua 10 (old desktop default) | 111 | 110 | 5.0 / 17.4 ms | 6.7 / **70 ms** | **62** |
| walk 4 s | directional | 0 | 1 | — | 0.6 / 20.6 ms | 63 |
| walk 4 s | radial, cua 30 | 112 | 112 | 4.9 / 17.6 ms | 4.8 / 33 ms | 21 |
| walk 4 s | radial, cua 89.9 (no bakes) | 113 | 113 | 4.7 / 17.9 ms | 4.1 / 20 ms | 0 |
| walk 4 s | radial, cua 30, **sort gate 5 cm** | 73 | 73 | **0.8** / 8.6 ms | 2.0 / 19.6 ms | 22 |
| walk 4 s | radial, cua 30, sort gate 25 cm | 16 | 16 | 0.5 / 0.6 ms | 0.5 / 2.2 ms | 21 |
| walk 4 s | radial, cua 10, **PBO path** | 101 | (PBO) | — | **12.1** / 49.9 ms | 59 |
| walk 4 s | **1.6M bundle**, radial, cua 30, gate off | 234 | 234 × 7.37 MB | 0.6 / 4.8 ms | 1.4 / 5.7 ms | 21 |
| walk 4 s | **1.6M bundle**, radial, cua 30, gate 5 cm — *as shipped* | 71 | 72 × 7.37 MB | 0.3 / 0.6 ms | 0.5 / 2.7 ms | 20 |

The last two rows are the shipped WebGL2 configuration and its one-knob A/B.
Note that the smaller bundle sorts FASTER (12 ms), so without the gate it
sorts MORE often — 58 a second — which is why count alone was never going to
settle the upload problem. The HUD read `up x4 0.3ms  bake x1` per 250 ms
window while walking, and the hero fly-in and fly-home each showed `bake` at 0
in flight and exactly 1 on arrival.

What the table says, in order:

- **The two sort modes are not "more" and "less" — they choose which motion
  costs.** Directional re-sorts on rotation (0.057°) and never on translation;
  radial re-sorts on translation (a third of a millimetre) and never on
  rotation. Both are correct: depth along a fixed axis is invariant under
  translation, distance is invariant under rotation. Mouse-look is the
  continuous motion on a desktop, so radial is now in the BASE preset for every
  device (it was mobile-only).
- **At walking speed a re-sort completes as fast as the worker can produce one**
  — 27-28 a second — and each one is an 11.67 MB upload. The upload is ~1 ms
  when the GPU is idle and 5 ms here when it is not; on the Firefox laptop it
  was 18 ms. The cost is GPU back-pressure, not the memcpy.
- **The colour re-bake is the other GPU load.** 15 a second at the old desktop
  default; cutting it to 30° took the worst walking frame from 70 to 33 ms, and
  removing it entirely to 20 ms. 30° is now BASE on every device.
- **The sort gate.** The engine's re-sort threshold is a hard-coded 1e-3 with no
  public knob (the LOD test has `lodUpdateDistance`; the sort test has
  nothing), so `core/gsplatinternals.ts` replaces the method on the live
  manager, with feature checks and a one-time warning if the engine's shape
  changes. Default 5 cm, chosen from the sort's own latency: a sort lands 20-37
  ms after it was asked for, so at 1.25 m/s the order on screen is already
  3-5 cm behind the camera. Note the upload mean falling from 4.9 to 0.8 ms on
  a 35% cut in count — that is the GPU queue finally draining between uploads.
  Inert on WebGPU, which sorts on the GPU every frame and never runs the test.
- **The PBO path is worse on Chrome**, exactly as the engine's comment says:
  12.1 ms mean main-thread frame against 6.7 ms. It is exposed as `?pbo=1` for
  one reason — nobody has measured what Firefox does with either path, and
  Chrome's IPC rationale does not apply there.

**What changed as a result** (all in the code, none in the data):

1. `BASE_PRESET` — `radialSorting: true`, `colorUpdateAngle: 30` — on every
   device. Neither knob changes the picture at rest, so the authoring view is
   untouched.
2. The sort gate, 5 cm default, `?sortdist=N`.
3. WebGL2 loads the 1.6M bundle on any device (`?full=1` overrides). The
   upload drops to ~7.4 MB, the sort from 20 to 12 ms, the bake by the same
   ratio, on the one path that has no GPU sort.
4. Colour re-bakes are HELD for the duration of a fly-in and fired once on
   arrival (`suspendColorBake` / `resumeColorBake`; released on arrival,
   interruption, scene swap). `?flybake=1` restores the old behaviour for an
   A/B on the phone. Only the view-dependent specular component goes stale, on
   a picture moving too fast to read it.
5. The HUD gained an `up` line (WebGL2 uploads and their cost) and a `bake`
   line (colour re-bakes), so both mechanisms are readable on the device that
   has the problem.

**What to ask the two friends to run.** The Firefox laptop:
`bluedio.html?stats` as shipped, then `?stats&sortdist=0` (the old cadence),
then `?stats&pbo=1`, each while walking with W — read `up`. The iPhone:
`?stats` then `?stats&flybake=1`, tapping a hero and closing it — read `worst`
and `bake` during the flight. If the fly-in dips survive with `bake --`, the
hypothesis is wrong and the next suspect is the DOM work at card open/close.

**Addendum, the same afternoon: fullscreen on a desktop is fill-bound, and so
is SuperSplat.** With everything above in place the desktop still lagged
fullscreen — and Will ran the same scan in SuperSplat fullscreen and it lagged
too. Same engine, same asset, same pixels. `?res=0.7` fixed the frame rate
outright, which settles it: the ceiling is fill.

The desktop rule had been "render native up to DPR 2" with no ceiling on the
pixel COUNT, so the workload depended entirely on the monitor: 0.9 Mpx in the
1280x720 window every number above was measured in, 3.7 Mpx on a 1440p
fullscreen, 8.3 Mpx on 4K or on 1440p at 150% scaling. Nine times the tuned
fill, plus a GPU sort of 2.53M every frame. No sort or bake knob touches it.

So the backing store now has a **budget of 2.0 Mpx** ("1080p"), applied on
every resize by scaling the ratio DOWN to `sqrt(budget / cssArea)`, floor 0.5:
a 1080p monitor renders native, 1440p at 0.74 (the 0.7 judged smooth), 4K at
0.49. The compositor upscales the rest; splats tolerate that far better than
polygon edges, and the card, captions and dots are DOM and stay crisp. It never
binds on the phone layouts, which sit at ~0.6 Mpx already. `?mpx=N` / `__mpx(n)`
to A/B it, `?mpx=0` for the old behaviour, `?res=N` still wins outright.

**The frame-time governor — a 30 fps floor on every device.** The budget caps
fill from the monitor's side; `src/core/adaptive.ts` closes the loop from the
frame's side, because no fixed number can know what a given GPU carries. It
reads the gap between consecutive RENDERED frames off `frameend` (true frame
pacing under rAF; undrawn on-demand frames do not count and a gap over 500 ms
restarts the window), and scales the device-decided ratio DOWN — never above
it — until the mean fits, then climbs back when there is headroom:

- **down** after 40 consecutive frames whose mean is more than 5% over
  33.3 ms, by `× sqrt(0.95 · target / mean)` clamped to [0.6, 0.9] per step
  (pixels scale with the square, so a badly over-budget device gets most of
  the way in one move). The 5% is the vsync margin: rAF paces in whole
  vsyncs, so a device that has landed exactly on the two-vsync 33.3 ms line is
  AT the floor, and without the margin float noise read it as over;
- **up** by ÷0.9 after 120 consecutive frames under 18 ms — doubling that
  window after every bounce, to 960 — so a healthy 60 Hz device returns to
  full resolution and a marginal one does not oscillate;
- **hold** between the two bands;
- **revert and pause** if a step down left the frame over the floor AND did
  not improve the mean by 8%: a device whose ceiling is the CPU sort or the
  upload does not get blurred for nothing. The pause is 15 s, doubling on
  every repeat to two minutes; a step that works resets it. Reading `res` dip
  and snap back on the HUD is that rule saying "not fill-bound — look at
  `sort` and `up` instead".

Every change, and every window resize, is followed by a 20-frame / 600 ms
cooldown (a swapchain reallocation makes its own slow frames), and a scene load
holds it for 60 rendered frames. Floor 0.4 (16% of the pixels). **The resize
itself happens at the top of the next `update`, not where the decision is
made:** the governor decides on `frameend`, after the frame has been drawn, and
resizing there clears the buffer and presents one black frame — the first phone
test saw that as "the screen flickers black when I move quickly", because fast
motion is when the governor acts. Applied before the render, the resized buffer
is drawn in the same tick and nothing blank is shown. It composes
with everything above: `applyRenderRatio()` in main.ts multiplies its scale
last. `?res=N` disables it (an absolute ratio is an A/B), `?adapt=0` disables
it, `?minfps=N` moves the floor, `__adapt()` reports, `__adapt('reset')` is
the one-call A/B for what it bought. The HUD's `res` reading is its scale.

Verified two ways. Against a synthetic model with rAF's whole-vsync pacing
(`scratchpad` simulation, four cases): a fill-bound 60 ms frame took ONE step to
0.69 and sat at the two-vsync 33.3 ms line, held; made fast, it climbed back
to 1.0 in four ÷0.9 steps; a CPU-bound 45 ms frame stepped to 0.80, reverted,
and paused 15 s then 30 s; a marginal 36 ms frame took one step to 0.80 and
held. In the page, driving the engine at 45 ms per frame by hand: `down ×0.84`
(backing store 1280x720 → 1073x603, HUD `res 0.84`), then the revert to 1.00
with a 15 s pause, because a busy-wait is exactly the kind of frame the canvas
size cannot shorten.

**The durable fix is upstream.** Two engine changes would make most of this
file unnecessary: a `scene.gsplat.sortUpdateDistance` / `sortUpdateAngle` pair
next to the existing `lodUpdate*` params, and a double-buffered,
chunked-over-frames order upload on WebGL2 so no single frame carries 11.67 MB.
Both are small PRs against `gsplat-manager.js` and `gsplat-work-buffer.js`.


## Gotchas that cost real time on Bluedio

1. **The 180-degree roll.** `main.ts` rolls every splat entity 180 degrees about
   Z, so a raw `.sog` point `(x, y, z)` is at `(-x, -y, z)` in world space.
   Anything from an offline pipeline needs x and y negated. `__logPose()` output
   does not — it is already world-space.
2. **`anchor` is not `pose.target`.** See step 6. This one looks like a
   projection bug and is not.
3. **A marker box must contain only the dot.** `.hero-marker` is centred on the
   projected point with `translate(-50%, -50%)`, so anything else sharing its box
   shifts the dot by half that width. The caption is absolutely positioned for
   exactly this reason. If you add anything to a marker, keep it out of flow.
4. **Marker projection runs on `prerender`, not `update`.** The engine only
   dirties the camera's cached view matrix on the `prerender` event, so
   projecting from `app.on('update')` silently uses the previous frame's camera
   pose and the dots lag. Do not move that call.
5. **Movement speed is keyed to the opening pose**, captured once — not to the
   live zoom. Deliberate: keying it to live distance made zooming in throttle
   WASD to a crawl. Walk mode is the exception: absolute m/s via `unitsPerMetre`.
6. **A walk region's polygon is in WORLD units; everything else about it is in
   METRES.** `falloff`, `spawnMargin` and each hole's `pad` are metric, the ring
   is not. `walk.ts` converts the ring once at construction and never again, so
   the only place the two can get mixed is a hand-written region.
7. **`?author` turns walk mode OFF.** You cannot author a hero pose 2.4 m up from
   a body that cannot leave the floor. `__walk(1)` puts it back if you want to
   check a framing at standing height without dropping `?author`.
8. **`npm run dev` does not typecheck.** Only `npm run build` does. A wrong field
   name in `demos.ts` will run happily and misbehave silently, so build before
   you trust it.
9. **NumPy >= 2.0** if you use the offline `autoscene` pipeline — and note that
   its `scene.json` is in raw coordinates. See
   `autoscene/RUNNING.md`.
10. **CSS specificity beats media queries.** A per-demo card rule such as
    `#hero-card.bottom[data-demo="bluedio"]` (id + class + attribute) outranks the
    mobile `#hero-card.bottom` (id + class) no matter which media query it sits
    in, because a media query adds nothing to specificity. This shipped as a real
    bug: the desktop `width: min(620px, 100% - 180px)` resolved to **195px** on a
    375px stage and welded the card to the left edge of the frame. Per-demo card
    rules now live inside `@media (min-width: 821px)` — **put new ones there.**
11. **`aspect-ratio` + `max-height` needs `width: 100%`.** Without a definite
    width, Chrome satisfies the cap by shrinking the *width* to preserve the
    ratio (measured 430x323 instead of 623x323), and the frame pulls away from
    the column it should fill. With it, the ratio yields instead — which is the
    entire point of having a cap.
12. **A vertical `aspect-ratio` must be guarded on orientation, not just width.**
    An iPhone SE in *landscape* is 667px wide and matches `max-width: 820px`, so
    an unguarded 9:16 there produces a frame **1108px tall inside a 375px
    viewport**. Hence the `and (max-aspect-ratio: 1/1)` on the portrait query.
13. **Testing in a browser whose pane is not displayed is testing nothing.** The
    tab reports `document.hidden`, so `requestAnimationFrame` never fires: the
    engine does not tick, `ResizeObserver` callbacks never arrive (they are
    delivered at rAF time), and CSS transitions never advance. Every one of those
    reads exactly like broken code. If you must drive it headless, pump frames by
    hand — `AppBase.getApplication()` then `app.update(1/60)` in a loop — and
    **call `app.render()` before any `worldToScreen()` measurement**: `update()`
    does not fire `prerender`, and per the note in `main.ts` only `prerender`
    rebuilds the camera's cached view matrix, so projections silently use a stale
    camera. That one cost an hour and reported a subject at the top of the frame
    that was really dead centre.

14. **Re-parenting chrome breaks every rule that resolved against its old
    ancestor — and the failures are invisible in review.** `bluedio-phone.html`
    moves four elements out of `#stage` into a dock, and every defect below came
    from that one operation. Read this list before moving any chrome again.

    - **`position: static` is not "un-positioned", it removes a CONTAINING
      BLOCK.** Cancelling an inherited `position: absolute` that way silently
      re-pointed the thumb pads' knob, label and `::before` slop ring at the
      dock. The slop ring has `inset: -20px` and inherits `pointer-events:
      auto`, so it became a hit target larger than the whole dock and **the
      controls stopped working entirely**. Use `position: relative` with
      `top/right/bottom/left: auto` — the four `auto`s are what stop the
      inherited offsets becoming relative displacements.
    - **A translucent panel over a flat ground of the SAME colour is invisible.**
      `--glass-strong` is `rgba(20,16,12,.85)` and `--shell` is `rgb(20,16,12)`.
      Over a splat the alpha is the whole point; over the dock it composites to
      the identical pixels — **contrast ratio 1.00**. Every docked panel needs
      its fill restated, and `backdrop-filter` dropped, since blurring a flat
      fill costs a backdrop re-sample per frame for nothing.
    - **Check what was gating the element before you move it.** `#stage-controls`
      was kept off the poster purely by `#stage` living inside
      `<div id="stage-dock" hidden>`. It is the one piece of stage chrome with
      no `hidden` class of its own, so docking it produced a points switch that
      flipped its own `aria-checked` while `heroes` was still null.
    - **An `opacity: 0` element is still fully hit-testable.** Cards fade for
      300-400 ms before `.hidden` lands; docked, that invisible card lies across
      the thumb pads. Pair every fade with `pointer-events: none` at rest.
    - **Elements that were far apart can become mutually exclusive.** The help
      card and the gear card sat at opposite corners full-bleed and were never
      made exclusive; centred on the same dock point, the higher z-index one
      buried the other's close button.
    - **A width media query cannot tell a wide screen from a phone turned
      sideways.** `(min-width: 560px)`, written for a laptop review, matches an
      iPhone in landscape at 874px. Add `and (pointer: fine)`. This is gotcha 12
      in a second costume — and the docked card's whole typography had the same
      shape of bug, living in a `max-width: 820px` block it fell out of on
      rotation.
    - **A ResizeObserver is a proxy for the viewport, not the viewport.** A
      fixed-width review shell means `#stage` is the same size at 900px and
      700px, so crossing the touch breakpoint fired nothing. Listen to the
      media queries that *are* the condition.

15. **`:not()` carries its argument's specificity, so scoping by negation
    escalates.** `body:not(.solo):not(.phone) #disclaimer-open` scores (0,1,2,1)
    and silently outranked the `prefers-reduced-motion` override at (0,1,0,0) —
    reduced motion stopped stopping an infinite animation. Negation also makes
    the scoped treatment the DEFAULT that every future page must opt out of.
    Scope positively (`body.reel`), and keep any override at matching
    specificity so source order decides it. Companion to gotcha 10.

16. **`var()` defeats the two-declaration CSS fallback idiom.** The usual
    `prop: <old>; prop: <new>` pattern works because a browser discards the
    second declaration at *parse* time. A value containing `var()` skips
    parse-time validation entirely — it is substituted at computed-value time,
    and if invalid then becomes IACVT, which resolves the property to its
    **initial** value rather than to the earlier declaration. So a `vh` line
    above an `svh` line containing `var(--x)` looks like a fallback and is a
    no-op. Use `@supports` instead. Here it would have silently removed the cap
    holding the dock open on any pre-15.4 WKWebView — the exact browser the
    layout targets.

17. **A per-frame inline style beats every stylesheet, so a JS-positioned
    element cannot be governed by CSS on the property JS writes.**
    `heropoints.ts` used to write `style.pointerEvents = 'auto'` on every marker
    every frame, which would have silently undone the `pointer: coarse` rule
    that makes the dots inert to a finger. State that CSS needs the last word
    on goes through a class (`.offscreen`), never inline. Companion to the
    hit-target lesson: a 22px dot is not a touch target, and the fix is a hit
    radius resolved on the canvas, not a bigger element.

## A standalone page for one scan

A scan good enough to send on its own gets its own page. `bluedio.html` is the
worked example: the same viewer, alone and full-bleed, at
`…/morisot-jftr-demo/bluedio.html`. **No second repo** — same project, same
push-to-main deploy, same committed splat.

Three pieces:

1. **The page.** Copy `bluedio.html`. All it contains is `<div id="stage-dock"
   hidden></div>`, one `.viewer-window[data-demo="…"]` with a poster, and
   `<body class="solo">`. Note the **absence** of a `.ratio-*` class —
   `body.solo` pins the window to the viewport instead. Keep `refAspect` at the
   value the poses were authored against; `camera.ts` widens the fov on any
   window narrower than that, so full-bleed needs no re-authoring.
2. **The build.** Add the file to `build.rollupOptions.input` in
   `vite.config.ts`. Miss this and the page works perfectly under
   `npm run dev` and is silently absent from `dist/` — which is exactly what was
   happening to `lab.html`.
3. **Nothing else.** The stage chrome is injected by `stage.ts`, so the page
   does not restate it and cannot drift from the reel page when it changes.

**Keep new pages at the repo ROOT.** `base` is `'./'`, so a page in a sub-folder
resolves the splat against its own directory — `/bluedio/splat/…` rather than
`/splat/…` — and 404s. A prettier URL is not worth a broken one. If you want
`/bluedio/` badly enough, set an absolute `VITE_BASE` and give up the
"works at any path" property.

## Deploying

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes to GitHub Pages within about a minute. **Every push to `main` goes
live**, so park work-in-progress scenes on a branch until they are ready to be
seen.

Every page listed in `rollupOptions.input` publishes together:

| Page | URL |
|---|---|
| The reel | `https://wilsonmcfee.github.io/morisot-jftr-demo/` |
| Bluedio, standalone | `https://wilsonmcfee.github.io/morisot-jftr-demo/bluedio.html` |

`lab.html` is deliberately not listed, so it stays a local scratch page. Add it
to the input map when it is ready to be seen.
