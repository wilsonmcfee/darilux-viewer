# Running the pipeline

The offline half of the viewer: it reads a `.sog` and derives the walk envelope,
hero points and camera poses that `src/demos.ts` consumes. It lives in the same
repo as the viewer so the two cannot drift apart, but it is NOT part of the web
build — nothing here ships to the browser.

Run everything from this directory. No venv needed; `uv` fetches the interpreter
and the deps per-run:

    UV="$LOCALAPPDATA/Microsoft/WinGet/Packages/astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe/uv.exe"
    DEPS='--with numpy>=2 --with scipy --with scikit-image --with pillow --with matplotlib'

    "$UV" run $DEPS python decode_sog.py             # -> xyz.npy + sh0.npy   (1.2 s)
    "$UV" run $DEPS python autoscene.py --heroes 10  # -> scene.json          (2.7 s)
    "$UV" run $DEPS python planfig.py                # -> plan.png
    "$UV" run $DEPS python preview.py                # -> previews.png        (2.5 s)
    "$UV" run $DEPS python envelope.py               # -> envelope.ts.txt + .png (3 s)

No unzip step: `decode_sog.py` now defaults to `../public/splat/bluedio`, the
bundle the viewer already ships, which is an unpacked SOG directory already.

`xyz.npy`, `sh0.npy` and `grids.npz` are ~95 MB of regenerable intermediates and
are gitignored — do not commit them.

## envelope.py — the walk region

`autoscene.py` decides **whether** a room deserves walk mode, and is deliberately
conservative: 0.50 m wall inset, 0.50 m off tall gear, and a final
`binary_opening` with a 0.80 m disk. On Bluedio that is 2.54 m2 with 2.49 m of
walkable path, which is the correct answer to its question.

`envelope.py` answers the other one — the room IS getting walk mode, so what is
the best envelope for it? Same occupancy grid, three different defaults (0.30 m
inset, 0.32 m island pad, no opening), giving **8.23 m2** on the same room. It
emits a paste-ready `region:` block for `demos.ts` plus an `envelope.png` to
judge it by, and prints stranded pockets and standoff encroachment so a bad
envelope is loud rather than silent. Judge the shape off the figure — that is
what the figure is for.

The island pad is the sensitive number: at 0.40 and above Bluedio's region
strands in one corner and the whole console side becomes unreachable.

Hand corrections go in a JSON passed to `--edits` — `exclude` / `include` shapes
in the figure's own coordinates, plus per-island pad overrides. Run it with
`--edits somefile.json` and no such file to get a commented starter. Note that
the figure's x axis is **negated** against viewer world x, and that an
`include` which does not touch the main region is dropped (the script says so).

Full prose walkthrough: `../TEMPLATE.md` step 8.

## Version constraint (this bit is load-bearing)

`autoscene.py` needs **NumPy >= 2.0** (`np.trapezoid`, the 2.0 rename of
`np.trapz`). The original `rdp()` also called `np.cross` on 2-vectors, which
NumPy **removed in 2.3** — so the code as shipped could not run on any single
NumPy version, only in the 2.0-2.2 window it was authored in. `rdp()` now writes
the 2-D cross product out by hand, so any NumPy >= 2.0 works. Verified on 2.5.2.

## Other rooms

`decode_sog.py` takes a directory of unpacked SOG textures as its first
argument. Every scene in `../public/splat/` is already in exactly that layout:

    "$UV" run $DEPS python decode_sog.py ../public/splat/common-room

Gaussian counts, for scale:

    common-room  2,302,682 gaussians    studio-e  399,535    synths  493,612

## Lineage note (read before editing autoscene.py)

Two independent fixes of the same three defects existed briefly: the cloud
session's (`SEAT_MARGIN` + a 12-vertex RDP ring + an export assert) and a local
one (adaptive-eps containment ring + overlap-based hero dedupe). They solved
different halves and each lost on the half it skipped:

| | verts | walk cells outside ring | opening-seat clearance |
|---|---|---|---|
| cloud  | 12 | 37 / 1017 (0.09 m2) | 270 mm |
| local  | 66 | 0 | 18 mm — inside the 0.35 m falloff |
| merged | 66 | 0 | 293 mm |

`autoscene.py` here is the MERGE and supersedes both. It keeps the adaptive-eps
ring (so the polygon is a superset of the walkable raster and nothing is
unreachable) AND `SEAT_MARGIN = 0.30` (so the visitor does not spawn inside the
boundary damping). It exports the cloud version's provenance fields —
`simplify_eps_m`, `polygon_area_m2`, `raster_area_m2`, `margin_m`,
`inside_walk_polygon` — and refuses to write a scene whose opening shot is
outside its own walk polygon.

Cross-check worth keeping: both implementations independently chose the SAME
opening seat, `[-7.5497, 0.0, 2.1787]` at yaw 40 with a 0.316 m margin, and the
same 8 hero poses.

Archived for reference, and still OUTSIDE this repo in the `Bluedio Experience`
working folder: `scene_cloud_8heroes.json` (cloud export) and
`scene_v1_9heroes.json` (the original run, with the duplicate hero). The raw
`Bluedio_optimized.sog` and the capture frames live there too — they are far too
large to commit, and the decode default above means you do not need them.

## mobile_asset.py — the reduced bundle for phones

`src/demos.ts` carries an optional `srcMobile` beside `src`. Phones load it,
and **since 2026-09-02 so does every WebGL2 device, desktop included**; only a
WebGPU desktop loads the full scene (`?lite=1` / `?full=1` override, and
`src/core/sceneloader.ts` carries the lineage of that decision). It exists
because splat **count** is the one cost no renderer setting can reduce: a
device on WebGL2 — an older phone, any in-app browser wrapping WKWebView,
Firefox on Linux — sorts the whole cloud on the CPU every time the camera
moves, that sort is linear in the count, and (the 2026-09-02 finding) **every
completed sort then re-uploads the entire order texture to the GPU**, which is
`textureSize² × 4` bytes and the single largest main-thread cost on that path.
Measured on the WebGL2 path with `?gl`:

| bundle | gaussians | download | depth sort | order upload per sort |
|---|---|---|---|---|
| `bluedio` (desktop) | 2,534,528 | 34.4 MB | 19–20 ms | 11.67 MB (1708²) |
| `bluedio-mobile` | 1,600,000 | 22.6 MB | 11–12 ms | 7.37 MB (1357²) |
| (1.2M, retired) | 1,200,000 | 18.0 MB | 8–10 ms | — |

> **Requested from the viewer side, 2026-09-02 — a bundle A/B worth building.**
> The other engine cost that pass found is the colour re-bake: camera
> translation re-evaluates the view-dependent (spherical-harmonic) colour of
> EVERY resident splat, on both renderers, and it is the likeliest cause of the
> fly-in frame drops in the iPhone 18 Pro recording. A bundle exported with
> `shN.bands = 0` never re-bakes at all (`hasSphericalHarmonics` is false in the
> engine), and drops `shN_centroids.webp` + `shN_labels.webp` (~3.4 MB of the
> 22.6). The cost is view-dependent colour — flatter specular on drum shells and
> glass. Build it as a third bundle beside the 1.6M one and judge it on the
> device before deciding; the viewer's `?stats` `bake` line will read `--` on it.
> Now that the 1.6M bundle also serves WebGL2 desktops, judge floor and desk
> seal at desktop window sizes too, not only on a phone.

The bundle was 1.2M first and was rebuilt at 1.6M on 2026-08-31: on the device
(iPhone 16 Pro, iOS 18.5) the 1.2M version showed invisible floor panes and
see-through desks — the surface-mat thinning this file already predicts under
"significance pruning", arriving a little later on the merge path. 1.6M is the
measured seal point ("visually indistinguishable from the full asset"), A/B
verified at the opening pose, a floor zoom and a hero close-up. If a device
still swims at 1.6M, rebuild smaller and re-judge the floor before shipping it.

When a sort overruns a frame the depth order lands stale, and the picture
*swims* rather than merely running slow. That is the failure this fixes, and
`?stats` puts the sort time on screen so you can see which side of the line a
device is on.

### Building it

Three commands. The Python pass does the two things `splat-transform` cannot
express; `splat-transform` does the decimation and the encode.

    UV="$LOCALAPPDATA/Microsoft/WinGet/Packages/astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe/uv.exe"
    ST="npx -y @playcanvas/splat-transform@3.3.0"
    # Raw scans moved out of the old "Bluedio Experience" folder in the
    # 2026-08 restructure; they live under C:\3dgs-assets now.
    SRC="/c/3dgs-assets/training/bluedio/Hi Def Bluedio.ply"

    # 0. the reachable camera set, read from demos.ts so it cannot drift
    node --experimental-strip-types autoscene/reachable.mjs > autoscene/reachable.json

    # 1. crop the far tail + delete the fog gaussians   (~2 s)
    "$UV" run --with 'numpy>=2' --with scipy python autoscene/mobile_asset.py \
        "$SRC" "$TEMP/bluedio_cut.ply"

    # 2. adaptive decimation to the target count        (~30 s)
    $ST "$TEMP/bluedio_cut.ply" --filter-nan \
        --decimate-adaptive 1600000 "$TEMP/bluedio_1v6m.ply"

    # 3. encode to an unbundled SOGS directory          (~7 s)
    #    (-w to overwrite an existing bundle in place)
    mkdir -p public/splat/bluedio-mobile
    $ST -w "$TEMP/bluedio_1v6m.ply" --filter-nan --filter-harmonics 1 -m -i 3 \
        --max-workers 8 public/splat/bluedio-mobile/meta.json

Step 0 must be re-run whenever the walk region or the hero poses change — it
reads both out of `src/demos.ts`. Steps 1–3 must be re-run whenever the source
scan changes.

`-i 3` in step 3 is not cosmetic. The SH codebook k-means defaults to 10
iterations and took **over ten minutes** on this input at that setting, against
6.5 s at 3, for no visible difference. `--max-workers 8` is free on any modern
machine. `splat-transform` also does **not** create its output directory — the
`mkdir -p` is required or step 3 fails with a bare ENOENT on a temp file.

### What each stage does, and why it is that stage

**The crop (`--box`, default ±45 raw units)** is much looser than it looks like
it should be, and that is the point. The room is only ~17 raw units across, so a
tight box is tempting. Measured, it is wrong:

| half-box | removed | consequence |
|---|---|---|
| ±12 | 145,346 | the view through the windows disappears |
| ±16 | 108,510 | right-hand window goes visibly black in an A/B |
| ±45 | 13,966 | only the genuine floaters |

The windows look out onto real reconstructed foliage 12–40 units away. What the
crop is actually for is the far tail: 384 gaussians past r=100 with a median
max-axis scale of 6.9 units, against 0.036 inside the room. They cost real fill,
and because the resource AABB is taken from the extremes they stretch the depth
sort's quantisation range over ~±570 units for a room occupying ~30. Cropping at
±45 tightens the AABB more than 12×, which sharpens the sort key for *every*
splat, and costs 0.55% of the count.

**The fog cut** deletes gaussians that are faint AND large (default: opacity
≤ 0.08 and max-axis scale ≥ 0.2 raw units) — about 103,000 of them, ~4% of the
cloud, carrying roughly a third of all projected screen area. These are the
classic 3DGS haze splats: individually invisible, collectively the single
largest block of fragment work in the scene. This cannot be done in
`splat-transform`, for two independent reasons — chained `-V` filters AND
together so they cannot express the complement of an AND, and `-V scale_0` tests
only the first scale axis rather than the max.

**The decimation** is `--decimate-adaptive`, and the "adaptive" matters more
than the target does. It MERGES neighbouring gaussians (818K merges at the 1.6M
target) so survivors inherit the extent of what they replace. Plain deletion at
this rate does not work — see the next section.

### Measured dead end: significance pruning

`mobile_asset.py --target N` implements the idea that looks best on paper and
does not survive contact. Because this viewer has no free flight, the reachable
camera set is small and enumerable, so each splat can be scored at its worst
case — `opacity * (max_scale / nearest_reachable_distance)²` — and the top N
kept. That should beat LightGaussian/RadSplat-style scoring, which only has
training views to work with.

At N = 1,000,000 the scene developed **dark blotches across the ceiling, the
floor and the rug**, obvious against the full asset. The ranking is not the
problem; the deletion is. Flat surfaces reconstruct as a mat of small gaussians,
and removing half of them leaves holes that expose darker material behind. The
published 0.6+ pruning ratios all *fine-tune the remaining gaussians afterwards*,
which grows them back over the gaps — a step we cannot run.

So `--target` defaults to **0 (off)** and the decimation is handed to
`--decimate-adaptive`, which merges instead. The flag is kept because the
reachable-camera machinery is correct and is probably the right tool for
choosing what goes in a low LOD level, where holes at distance matter far less.

### Also measured, also negative: LOD / streamed SOG

`splat-transform … out/lod-meta.json` produces a chunked octree but reports
`lodLevels: 1` — it does **not** synthesise an LOD pyramid from one input. Real
levels need `--tag-lod` with a separately decimated file per level, and
`--decimate-adaptive` "must be the final action, with a `.ply` output", so that
is one full pass per level. Worth doing eventually — it is the mechanism
SuperSplat's own viewer uses, and it is the only thing that would unlock
`app.scene.gsplat.splatBudget`, which is otherwise a hard no-op on a flat SOGS
bundle. It was not worth it for the first pass.
