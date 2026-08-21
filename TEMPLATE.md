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

When the framing is right, run `__logPose()` in the console. It prints a
ready-to-paste `{ position, target, fov }`. Drop it into `initialPose`.

Movement speed is keyed to this pose's framing distance, captured once — so a
tight opening pose gives slow movement throughout the scene. If the room feels
sluggish, a slightly wider opening shot fixes it.

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

## 8. Card sizing, if the copy is long

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

## 9. Verify

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

Per demo: `cardStyle`, `refAspect`, `initialPose`, `src`.

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
   WASD to a crawl.
6. **`npm run dev` does not typecheck.** Only `npm run build` does. A wrong field
   name in `demos.ts` will run happily and misbehave silently, so build before
   you trust it.
7. **NumPy >= 2.0** if you use the offline `autoscene` pipeline — and note that
   its `scene.json` is in raw coordinates. See
   `Bluedio Experience/autoscene/RUNNING.md`.

## Deploying

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes to GitHub Pages within about a minute. **Every push to `main` goes
live**, so park work-in-progress scenes on a branch until they are ready to be
seen.
