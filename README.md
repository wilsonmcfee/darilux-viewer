# Darilux Studio — JFTR demo reel

An interactive, browser-based reel of three Gaussian-splat captures for **Just For The Record**, delivered as one page:

1. **Five Synthesizers** — small scale, with a hero point on each instrument
2. **Studio E** — medium scale, full-room coverage + 2 hero points
3. **Common Room** — large scale, a composite of two captures showing fidelity across a bigger space

The page is a scrolling editorial layout (Fraunces + Inter on warm paper) with the viewers set INSIDE bespoke dark windows: a Studio E section, then a Common Room section (full walkthrough + a synths window with the collection list). Each window shows a styled poster until the visitor clicks "Enter" — then one shared stage (canvas + overlays) moves into that window and the scene streams in. Only one splat is ever in memory at a time; the engine itself isn't even created until the first Enter click. Built on the PlayCanvas engine (WebGPU-first, WebGL2 fallback), the same architecture as the SuperSplat starter used for the pilot viewer.

## Quick start

```bash
npm install
npm run dev          # opens a local dev server; --host is on for phone testing
```

Then drop your compressed splats into `public/splat/` (see that folder's README) and author the camera poses (below).

```bash
npm run build        # type-checks, then bundles into dist/
npm run preview      # serve the production build locally
```

### Testing on a phone

`server.host` is on, so the dev server already listens on every interface — the
usual blocker is Windows Firewall, not config. Two routes:

- **Tailscale** (no changes needed): open the Tailscale app on the phone and hit
  `http://<this-machine's-100.x address>:5173/bluedio.html`. The Tailscale
  interface is classed *Private*, so the existing inbound Node.js rule covers it.
- **Plain Wi-Fi**: only works if that network is classed *Private*. A network
  Windows has classed *Public* will silently refuse the connection even though
  the server is listening. Either add a rule for TCP 5173 or reclassify the
  network — both need an elevated shell.

The mobile build is a genuinely different layout (portrait frame, thumb sticks,
different help copy), so **desktop-narrow is not a substitute for a phone** for
anything to do with feel. The knobs that let you tune it from the device are URL
params — see `TEMPLATE.md` → "The tuning knobs". Add `?stats` to any page for
the frame-time readout (renderer, fps/worst, Mpx/dpr, splats/sort, and the
`up` / `bake` / `res` line); `TEMPLATE.md` → "Performance" says how to read it.

## Where things live

| File | What it's for |
|---|---|
| **`src/demos.ts`** | **The one file you edit.** All scenes, their copy, camera framing, hero points and walk regions — as data. No rendering logic. `src/types.ts` holds the interfaces. |
| `src/index.ts` / `src/site-entry.ts` | The public `createViewer()` API, and the page boot that exposes it as `__viewer`. |
| `src/core/main.ts` | Boots the engine, owns the frame loop, on-demand rendering, the render ratio and the governor's resize. |
| `src/core/sceneloader.ts` | One splat at a time: load, swap, unload — and which bundle a device gets. |
| `src/core/camera.ts` (+ `flyto.ts`, `orbit.ts`) | Orbit + fly + walk camera, eased hero fly-ins, `__logPose()`. |
| `src/core/device.ts` | WebGPU→WebGL2 device selection, the render pixel ratio and the 2.0 Mpx budget. |
| `src/core/adaptive.ts` | The frame-time governor: scales resolution to hold a 30 fps floor. |
| `src/core/splatquality.ts` | The engine's splat cost/quality knobs, the presets, the fly-in bake hold. |
| `src/core/gsplatinternals.ts` | The one file that reaches past the engine's public API (sort gate, HUD hooks). |
| `src/core/knobs.ts` | Every URL flag and `__console` handle. |
| `src/core/stage.ts` / `brand.ts` / `authoring.ts` | Shared chrome markup, the brand block, the build-gated `?author` rig. |
| `src/nav/` | `walk.ts` (height lock + region SDF), `locomotion.ts`, `joystick.ts` (thumb sticks), `heropoints.ts` (the dots). |
| `src/ui/` | `ui.ts` (overlay UI), `phonedock.ts` (the docked phone layout), `perfhud.ts` (`?stats`), `disclaimer.ts`. |
| `src/styles/` | Five sheets imported by `index.css`, in an order same-specificity ties depend on. Client styling in `sites/<client>/brand.css`. |

> **The deep documentation is `TEMPLATE.md`**, not this file. It is the
> walkthrough for wiring a new scan in, and it is where walk mode, the touch
> controls, the portrait layout, the tuning knobs and the performance notes are
> written up properly. This README is orientation only.

## Authoring hero points (the human-in-the-loop step)

A splat is millions of unlabeled points — nothing marks "this is the console," and code can't render the scene to pick coordinates. So poses are authored by eye, exactly like the pilot rig:

1. `npm run dev`, click "Enter" on the demo's window, and move to the framing you want. Controls: **drag** orbits, **right-drag / Shift+wheel** pans, **wheel** zooms, and **WASD + Q/E** flies through the scene (**Shift** = faster) — the quickest way to get up close to a piece of gear. On a phone the same scene is driven by **two thumb sticks** (left walks, right looks) and `Q/E`/wheel do not exist; authoring is a desktop job either way, and `?author` disables walk mode for it.
2. In the browser console run `__logPose()` — it prints a ready-to-paste pose.
3. Paste it into `demos.ts` as either the demo's `initialPose` (opening shot) or a hero point's `pose` (where the fly-in lands). Save — it hot-reloads.

The `anchor` on a hero point is the 3D spot its label pins to (defaults to the pose's target). All poses in `demos.ts` are placeholders marked `TODO` until you author them against the real scenes.

## The splat files

The scenes live under `public/splat/` as SuperSplat SOGS bundles (a folder each: `meta.json` + `.webp` textures) — synths ~9 MB, Studio E ~8 MB, common room ~30 MB, and Bluedio as **two** bundles: `bluedio` (2.53M gaussians, 33 MB) for WebGPU desktops and `bluedio-mobile` (1.6M, 23 MB) for phones and every WebGL2 device (`demos.ts` → `src` / `srcMobile`; the decision is in `src/core/sceneloader.ts`, built by `autoscene/mobile_asset.py`). ~100 MB total, still under GitHub Pages' per-file limit, so everything ships from the repo for now — assets are slated to move to R2 + CDN. To re-export a scene, see `public/splat/README.txt`. Keep raw `.ply`/`.psht` out of git (already in `.gitignore`).

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source → "GitHub Actions"**.
3. Every push to `main` builds and publishes via `.github/workflows/deploy.yml`.

The Vite `base` is relative (`./`), so it works whether the site is served at `you.github.io/<repo>/` or a custom domain — no config to change.

## Reconciled with the real SuperSplat starter

The viewer has been aligned to the actual starter output (all three scenes loaded):

- **Format** — SOGS bundles (`meta.json` + `.webp`), loaded as a `gsplat` asset with a `filename` hint.
- **Orientation** — the splat entity is rolled 180° on Z (SuperSplat exports are flipped); without it the scene is upside-down.
- **WebGPU** — no glslang/twgsl helpers needed on the current engine, so there's no `public/lib` dependency. We keep a WebGL2 fallback the starter doesn't have.
- **Poses** — the synths scene uses its authored SuperSplat pose; Studio E and the common room auto-frame from scene bounds until you author poses with `__logPose()`.

## Still to author (your next pass)

- **Hero-point poses** — the synth and Studio E hero points in `demos.ts` are still placeholders. Author them with `__logPose()` (see above). The scenes load and orbit fine without this; it's the fly-in targets that need real coordinates.
- **Opening shots for Studio E / common room** — optional; replace `initialPose: null` with an authored pose for a stronger first frame.

---
