WEB-READY SPLATS (already in place)
===================================

The three scenes are exported from SuperSplat as SOGS bundles — a folder per
scene containing meta.json + several .webp textures:

    public/splat/synths/meta.json        (+ .webp)   Demo 1 — five synthesizers (~9 MB)
    public/splat/studio-e/meta.json      (+ .webp)   Demo 2 — Studio E          (~12 MB)
    public/splat/common-room/meta.json   (+ .webp)   Demo 3 — common room       (~30 MB)

src/demos.ts points each demo's `src` at its meta.json. The viewer loads that,
and the engine fetches the sibling .webp files automatically.

TO REPLACE / RE-EXPORT A SCENE
  In SuperSplat: File → Export → SOGS (the multi-file .webp bundle, NOT the
  single-file .sog). Drop the resulting files into the matching folder above,
  keeping meta.json + all .webp files together.

  Total payload here is ~50 MB — well under GitHub Pages' 100 MB per-file limit
  and its ~1 GB repo guidance, so all three ship directly from the repo. No
  external asset host (R2/CDN) is needed at these sizes. If a future scene is
  much larger, remember `src` can also be a full URL (see src/demos.ts).

Keep the raw .ply / .psht captures OUT of this repo (see .gitignore) — only these
compressed bundles belong in git.
