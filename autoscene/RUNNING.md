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
