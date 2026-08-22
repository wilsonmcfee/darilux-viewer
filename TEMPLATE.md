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

Per demo: `cardStyle`, `refAspect`, `initialPose`, `src`, `walk`, `guide`.

### The stage controls

Two controls sit in the viewer's bottom-left corner, and both are chrome the
shared code owns — a new scan gets them for free.

The **i** opens a navigation-help card built from the demo's `guide` field:
a `title`, a list of `{ key, action }` rows, and an optional `note`. Omit
`guide` and the i hides itself. It duplicates the copy under the viewer on
purpose — the page is frozen while a scene is open, so that copy is unreachable
exactly when someone wants it. Keep the two in step.

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
