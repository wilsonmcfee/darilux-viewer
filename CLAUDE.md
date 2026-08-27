# CLAUDE.md — Darilux Studio viewer

A config-driven 3D Gaussian splat viewer: PlayCanvas + vanilla TypeScript +
Vite, no framework. WebGPU with a WebGL2 fallback. One engine, multiple pages,
scene data declared entirely in `src/demos.ts`.

Deeper references, in the order they usually matter:

- `TEMPLATE.md` — wiring a new scan, every tuning knob, performance findings,
  and the "Gotchas that cost real time" list. Read the gotchas before
  debugging anything that looks like a projection, CSS, or timing bug.
- `docs/` — subsystem notes (mobile pass, phone dock, reveal, restyle handoff,
  walk implementation brief, Bluedio context).
- `autoscene/RUNNING.md` — the offline Python pipeline.

## Verify by rendering, not by compiling

`tsc --noEmit` passing means nothing here. After any substantive change, run
`npm run dev`, open the page, click Enter, and confirm a splat renders and a
hero fly-in works. A viewer that builds and shows a black canvas is a broken
viewer.

The converse trap: `npm run dev` does **not** typecheck — only `npm run build`
does. A wrong field name in `demos.ts` runs happily and misbehaves silently.
Do both.

**Headless/hidden-pane warning:** a browser pane that is not displayed reports
`document.hidden`, so `requestAnimationFrame` never fires — the engine does not
tick, transitions never advance, ResizeObserver stays silent. All of that reads
exactly like broken code. Test with the pane visible, or pump frames by hand
(`app.update(1/60)` then `app.render()` — `update()` alone leaves the camera's
view matrix stale). See TEMPLATE.md gotcha 13.

## The coordinate contract — measured, not guessed. Do not re-level.

The `.sog` is **Y-down (up = −Y)**; orientation was set in LichtFeld Studio and
is correct. `main.ts` rolls every splat entity 180° about Z, so a raw `.sog`
point `(x, y, z)` sits at `(−x, −y, z)` in world space. Anything from the
offline pipeline needs x and y negated; `__logPose()` output does not — it is
already world-space.

| Quantity | Value |
|---|---|
| Scale | **1 unit = 1/3 m exactly** (LichtFeld anchor: raw y = 0 is 1.40 m up; 1.40 / 4.20) |
| Floor plane (Bluedio) | raw `y = +4.20` → world `y = −4.20` after the roll |
| Eye height / nav plane | raw `y = 0` |
| Walk eye height | 1.55 m above the floor (between the 1.4 m and 1.9 m capture rings) |

Full derivation and conversions: the coordinate contract table in the pipeline
handoff (`HANDOFF.md`, moving to the pipeline repo). Read it before touching
any number in a `walk` block or `scene.json`.

## demos.ts is data. No rendering logic lives in it.

Everything the viewer shows — scene files, camera framing, copy, hero-point
positions, walk regions, the brand block — is declared in `src/demos.ts` as
data; the shared interfaces live in `src/types.ts`, which is where engine
files import them from (never from demos.ts). Engine files are scene-agnostic
and must stay free of client names; brand strings flow through
`src/core/brand.ts`. If a client need can't be expressed as data in the
config, extend the types — never branch on a client.

The layout: `src/index.ts` is the public API (`createViewer({ mount, scenes,
brand, onEnter, onHeroOpen })` → `{ load, goToHero, destroy }`); the pages
boot through `src/site-entry.ts`, which exposes the handle as `__viewer`.
Engine code sits in `core/` (main, camera + flyto + orbit, sceneloader,
device, stage, knobs, splatquality, splatpick, brand, authoring), `nav/`
(walk, locomotion, joystick, heropoints), `ui/` (ui, phonedock, perfhud,
disclaimer) and `styles/` (five sheets imported by styles/index.css, in an
order that same-specificity ties depend on). Client page styling lives in
`sites/<client>/brand.css`, linked from each page's head.

The `?author` rig (`core/authoring.ts`, incl. `__logPose`) is build-gated:
present in dev, tree-shaken out of `npm run build` unless
`VITE_AUTHORING=1` is set.

New scenes start from `src/demo-template.ts` (type-checked, never imported, so
it ships nothing and cannot rot) and follow `TEMPLATE.md` step by step.

## The multi-page build

Vite builds **only** the pages listed in `build.rollupOptions.input` in
`vite.config.ts`. A page missing from that map works perfectly under
`npm run dev` and silently vanishes from `dist/`. Currently listed: `index.html`
(the JFTR reel), `bluedio.html` (standalone), `bluedio-phone.html` (docked
phone layout).

- `lab.html` is **deliberately unlisted** — it is a local scratch page, and
  listing it would publish it. Add it only when it is ready to be seen.
- `base` is `'./'` (relative), which is load-bearing for GitHub Pages project
  sites. Keep new pages at the repo **root**: a page in a sub-folder resolves
  `splat/…` against its own directory and 404s.
- Every push to `main` deploys to GitHub Pages via `deploy.yml`. Park
  work-in-progress on a branch.

## Authoring workflow (poses, anchors)

Poses cannot be guessed — they only make sense against the rendered scene.

1. `npm run dev`, open in Chrome (WebGPU), enter the scene.
2. Free-fly to the framing (add `?author` for the crosshair rig; it also
   forces the full asset and turns walk mode off so you can fly).
3. Run `__logPose()` in the console — it prints a paste-ready
   `{ position, target, fov }` for `initialPose` or a hero's `pose`.
4. Anchors are **not** `pose.target` (that is empty air ~0.6 m in front of the
   camera). Aim the `?author` crosshair and run `__logAnchor()`, or bulk-derive
   with `autoscene/anchors.py`.

Other live helpers: `__walk(0/1)`, `__eyeHeight(m)`, `__walkDebug()`,
`__stats(1)`, `__splat()`. URL flags (`?stats`, `?gl`, `?res=`, `?lite=1`,
`?author`, …) are catalogued in TEMPLATE.md.

## Git hygiene

- `autoscene/` intermediates (`xyz.npy`, `sh0.npy`, `grids.npz`, `unpacked/`,
  `reachable.json`) are gitignored: ~95 MB, regenerable in seconds from the
  splat, and stale the moment a pose moves. Regenerate rather than trusting a
  copy; never commit them.
- Raw captures (`*.ply`, `*.psht`) stay out of git. Only compressed, web-ready
  splats under `public/splat/` are committed (interim state — assets are
  moving to object storage + CDN).
- Commit messages here are unusually good. Match that standard: say what
  changed and why, not "fix".

## Current restructure

The repo is mid-restructure from single-client demo to reusable core + per-
client sites. The plan lives in the working docs (`AUDIT.md`,
`ARCHITECTURE.md`, `PUNCHLIST.md` — kept outside this repo): core never knows
a client's name; scene data and brand CSS move to per-client repos; splats
move to R2. Check the punchlist before inventing structure.
