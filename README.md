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
params — see `TEMPLATE.md` → "The tuning knobs".

## Where things live

| File | What it's for |
|---|---|
| **`src/demos.ts`** | **The one file you edit.** All three scenes, their copy, camera framing, and hero points — as data. No rendering logic. |
| `src/disclaimer.ts` / `DISCLAIMER-DRAFT.md` | The "About this demo" copy (draft, for your review). |
| `src/main.ts` | Boots the app, loads one splat at a time, runs the frame loop. |
| `src/camera.ts` | Orbit + fly camera, eased hero fly-ins, `__logPose()` helper. |
| `src/heropoints.ts` | The floating 3D-anchored gear labels. |
| `src/walk.ts` | Height-locked movement + the walkable-region SDF (Bluedio). |
| `src/joystick.ts` | The two touch thumb sticks, and the "is this a touch device" test. |
| `src/stage.ts` | The shared viewer chrome as markup, injected into every page. |
| `src/device.ts` | WebGPU→WebGL2 device selection + the "unsupported browser" backstop. |
| `src/ui.ts` / `src/style.css` | The overlay UI and the Darilux styling. |

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

The three scenes are already in place under `public/splat/` as SuperSplat SOGS bundles (a folder each: `meta.json` + `.webp` textures) — synths ~9 MB, Studio E ~12 MB, common room ~30 MB, **~50 MB total**. That's comfortably under GitHub Pages' 100 MB per-file limit and ~1 GB repo guidance, so everything ships straight from the repo — no external asset host needed. `demos.ts` points each `src` at its `meta.json`. To re-export a scene, see `public/splat/README.txt`. Keep raw `.ply`/`.psht` out of git (already in `.gitignore`).

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
