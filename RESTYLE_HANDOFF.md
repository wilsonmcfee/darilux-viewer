# Project handoff — Darilux × JFTR demo (editorial rebuild)

Context for a new chat/agent picking up this project. Covers what the app is
now, how it got here, how the code is wired, and what's still open. Read the
"Don't break these" section before touching anything.

---

## What this is (30 seconds)

An interactive 3D Gaussian-splat demo for **Just For The Record**, built by
Darilux Studio. It's a **scrolling editorial one-pager** (not a fullscreen
viewer): warm paper ground, Fraunces display serif + Inter UI sans, hairline
rules, one red accent. The 3DGS viewers live INSIDE bespoke dark "viewer
windows" set into the page. Stack: Vite + TypeScript + PlayCanvas engine
(WebGPU-first, WebGL2 fallback). No framework, no Tailwind — plain CSS in one
file.

Live at: `https://wilsonmcfee.github.io/morisot-jftr-demo/`
Repo: `https://github.com/wilsonmcfee/morisot-jftr-demo` (deploys to Pages via
`.github/workflows/deploy.yml` on every push to `main`).

## How it got here (session history)

1. **v1** — fullscreen viewer with a top-right demo dropdown ("rail"), a
   bottom-left info drawer, dark espresso/Karla styling.
2. **v2 (current)** — rebuilt to match two static mockups (in the sibling
   folder `../JFTR recreation HTML/`): one scrolling page, viewers embedded in
   styled windows, click-to-enter posters, rail/drawer deleted. Also renamed
   Morisot → Darilux throughout. All committed and deployed.

## Page structure (top to bottom)

1. **Header** — Darilux brand line + "About this demo" pill (disclaimer modal).
2. **Studio E** section ("Full Immersion") — 16:9 viewer window
   (`data-demo="studio-e"`), caption row, about + amenities two-column, two
   PDF download buttons.
3. **Common Room** section ("The Collection") —
   - `01 · The Room`: 16:9 window (`data-demo="common-room"`)
   - `02 · The Synths`: **portrait** window (`data-demo="synths"`, class
     `ratio-tall`, aspect 3.4:4.5 at 85% column width — deliberately "15%
     skinnier, 50% longer" than the old 4:3) beside "the collection" list
   - Closing CTA ("Come play the collection" → Book a Studio Tour)
4. **Footer** + disclaimer/unsupported modals.

Posters are intentionally **pin-free** (the decorative `.pin` markers from the
mockups were removed). The only pins are the live 3D `.hero-marker` dots once
a scene is loaded.

## The stage architecture (the core idea)

There is ONE shared `#stage` — the PlayCanvas `<canvas>` plus every viewer
overlay (hero layer, hero cards, loading veil, exit ×). It parks in a hidden
`#stage-dock` and:

- **Nothing GPU-related exists until the first "Enter" click** (lazy boot in
  `main.ts → ensureApp()`; unsupported devices get the fallback modal).
- On Enter, the stage is **reparented into that window** (window gets `.live`,
  its poster hides), then the scene streams in. Canvas sizing =
  `FILLMODE_NONE` + `RESOLUTION_AUTO` + a ResizeObserver on the stage.
- Entering a different window moves the stage there; the old window gets its
  poster back. The × (`#stage-exit`) unloads the scene, frees memory, and
  re-docks the stage. **Only one splat is ever in memory.**
- Clicking a synth in the collection list (`#synth-list`, rendered from
  `demos.ts` so list and scene always agree) enters the synths viewer if
  needed and flies to that hero once loaded (`pendingHero` in `main.ts`).

## File map

| File | What it's for |
|---|---|
| `index.html` | The whole editorial page + the parked `#stage` markup. |
| `src/demos.ts` | **The one content file.** Three demos (`studio-e`, `common-room`, `synths`), poses, hero points, copy. Untouched by the rebuild. |
| `src/main.ts` | Lazy boot, stage reparenting, scene load/unload, frame loop. |
| `src/ui.ts` | DOM wiring: Enter buttons, `.live` state, synth list, loading veil, hero cards, disclaimer. No rail/drawer anymore. |
| `src/camera.ts` | Orbit + fly camera, hero fly-ins, `__logPose()` / `__logAnchor()`. Unchanged. |
| `src/heropoints.ts` | 3D-anchored DOM markers; anchored card now clamps to the **hero-layer bounds** (the window), not the browser window. |
| `src/device.ts` | WebGPU→WebGL2 device selection. Unchanged. |
| `src/style.css` | 100% of styling. `:root` split into page (paper) and viewer-shell (dark) variable groups. |

## Run & verify

```bash
npm install
npm run dev      # local dev server; open in CHROME (WebGPU). Vite hot-reloads.
npm run build    # MUST pass — runs `tsc --noEmit` then `vite build`
```

Note for sandboxed/Linux agents: `node_modules` on disk was installed on
Windows; rollup's native binary won't run on Linux. Copy the project (minus
`node_modules`) elsewhere and `npm install` fresh to verify builds.

---

## Don't break these (CSS ↔ JavaScript couplings)

The TypeScript queries elements by **id** and builds markup with specific
**class names**. Restyle freely, but do **not rename** an id or class without
updating the matching `.ts` file, or the app breaks silently.

### Element IDs the code depends on (keep the ids)
`stage`, `stage-dock`, `stage-exit`, `viewer`, `hero-layer`, `synth-list`,
`disclaimer-open`, `disclaimer`, `disclaimer-close`, `disclaimer-body`,
`unsupported`, `loading`, `loading-label`, `hero-card`, `hero-card-close`,
`hero-card-body`, `hero-card-anchored`, `hero-card-anchored-close`,
`hero-card-anchored-body`.
(`author-crosshair` is injected by JS only when the URL has `?author`.)

### Structural attributes/classes the code queries (keep these)
- `.viewer-window[data-demo="…"]` — the bespoke windows; `data-demo` must match
  a demo `id` in `demos.ts` (`studio-e`, `common-room`, `synths`).
- `.enter` — the Enter button inside each window's `.poster`.

### Class names built in JS (in `src/ui.ts` and `src/heropoints.ts`)
Written via template strings, so a rename must happen in **both** the `.ts`
and the CSS: `hero-marker`, `hero-dot`, `hero-caption`, `hero-card-title`,
`hero-card-icon`, `hero-card-sub`, `hero-card-desc`, `hero-card-placeholder`,
`hero-card-specs`, `s-name`, `s-meta`, `spinner`, `modal`, `modal-card`,
`modal-close`.

### State classes toggled by JS (style the states, keep the names)
- `.hidden` — global `display:none !important`; JS shows/hides with it.
- `.live` — on the active `.viewer-window`: hides its `.poster`, shows `#stage-exit`.
- `.open` — on `#hero-card`: triggers the slide-in transition.
- `.show` — on `#hero-card-anchored`: fade-in.
- `.bottom` — on `#hero-card`: the bottom-center placement variant (vs left).

### Animation timing is coupled to JS timeouts
When a card/veil hides, JS waits a fixed time before adding `.hidden`, matched
to the CSS transition. If you change these **CSS durations**, keep the **JS
timeouts in `ui.ts`** ≥ the CSS duration:

| Element | CSS transition | JS timeout (`ui.ts`) |
|---|---|---|
| `#loading` | `opacity .45s` | `450ms` |
| `#hero-card` (`.open`) | `.4s` | `400ms` |
| `#hero-card-anchored` (`.show`) | `.3s` | `320ms` |

### Positioned-by-JS elements (don't fight them with CSS)
`.hero-marker` and `#hero-card-anchored` get their `left`/`top` set **every
frame** by `heropoints.ts` (they track 3D points, in canvas/stage coordinates).
Style their look, but don't set `left`/`top`/`position` in CSS in a way that
conflicts. `transform` offsets are fine (the anchored card uses
`translateY(-50%)`; keep that pattern).

### The canvas background is set in code, not CSS ⚠️
The 3D canvas clear color is set in **`src/main.ts`**, not CSS:

```ts
clearColor: new Color(20 / 255, 16 / 255, 12 / 255, 1), // matches --shell #14100c
```

If you change `--shell` (the dark viewer-window ground), update this line to
match, or the splat's background won't match the window it sits in. This is
the one styling value that lives outside `style.css`.

### Files NOT to touch for a reskin
`camera.ts`, `device.ts`, `heropoints.ts` (logic), `demos.ts` (content/data).
The **only** non-CSS file a reskin should touch is `main.ts`, and only the
`clearColor` line above.

---

## Card styles (already built — reuse, don't reinvent)

Per-demo `cardStyle` in `demos.ts` picks how a hero's description card appears:
- `'hud'` — glass panel, left-center of the window
- `'hud-bottom'` — same panel, bottom-center (synths + Studio E use this)
- `'anchored'` — small callout pinned to the 3D point, tracks the camera (Common Room)

All three share `.hero-card-*` / `#hero-card-anchored` styling.

## Responsive

One breakpoint: `@media (max-width: 820px)`. It stacks the two-column grids,
deepens the 16:9 windows to 4:3, widens `ratio-tall` to full column, and turns
the hero card into a bottom sheet inside the window.

## Accessibility niceties to preserve

`aria-*` attributes and `role="dialog"` on the modals/cards, focus-visible
behavior, sufficient text contrast over the glass panels, and the
`prefers-reduced-motion` guard (kills the ping animation + smooth scroll).

## Authoring workflow (unchanged)

`npm run dev` → Enter a window → free-fly (drag orbits, right-drag pans, wheel
zooms, WASD+Q/E flies, Shift = faster) → `__logPose()` in the console prints a
pasteable pose for `demos.ts`. Add `?author` to the URL for a crosshair +
`__logAnchor()` to place hero dots.

## Deploying

Push to `main` → GitHub Actions builds and publishes to Pages (~1 min). If the
live page looks stale after a green run, it's cache: hard refresh
(Ctrl+Shift+R); the Pages CDN can also hold old HTML for up to ~10 min.
Sandboxed agents can commit locally but can't push (no GitHub credentials) —
Will pushes from his machine.

## Open items

- **Hero-point poses** — Common Room heroes and some copy in `demos.ts` still
  carry placeholder/rough poses; author with `__logPose()` / `__logAnchor()`.
- **Opening shots** — Studio E / Common Room `initialPose` values work but can
  be refined for stronger first frames.
- **DISCLAIMER-DRAFT.md** — the "About this demo" copy is still a draft
  awaiting Will's final wording (mirrored in `src/disclaimer.ts`; keep in sync).
- **Repo name** still says `morisot-jftr-demo` (code says Darilux); renaming
  the repo would change the Pages URL — decide before sharing links widely.
