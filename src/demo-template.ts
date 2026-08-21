/* ============================================================================
   demo-template.ts — the shape a new scene should take.
   ----------------------------------------------------------------------------
   Copy TEMPLATE below into the DEMOS array in `demos.ts`, rename the id, and
   fill in the numbers. Every value here is the setting the Bluedio room settled
   on after tuning against real WebGPU frames, so it is a working starting point
   rather than a blank form.

   This file is deliberately NOT imported anywhere. Vite bundles only what is
   reachable from the entry, so it adds nothing to the shipped app — but
   `tsc --noEmit` runs over all of `src/` as the first half of `npm run build`,
   so the template is typechecked on every build and cannot quietly drift out of
   date with the Demo / HeroPoint types.

   The companion prose walkthrough is TEMPLATE.md in the repo root.
   ========================================================================== */

import type { Demo } from './demos';

/* ---------------------------------------------------------------------------
   THE COORDINATE CONTRACT — the thing that wastes the most time if missed.

   main.ts rolls every splat entity 180 degrees about Z:

       entity.setLocalEulerAngles(0, 0, 180);

   so a raw point (x, y, z) in the .sog lands in WORLD space at (-x, -y, z).
   That roll is what turns a Y-down capture into a Y-up world, and every pose in
   demos.ts is in WORLD space.

   Consequence: numbers taken from an offline pipeline that reads the .sog
   directly (e.g. autoscene's scene.json) are in RAW coordinates and need x and
   y NEGATED before they belong in this file.

   Poses captured in the browser with __logPose() are already world-space and
   need no conversion. That is the path to prefer — it is also the only one that
   lets you judge the framing while you choose it.
   --------------------------------------------------------------------------- */

export const TEMPLATE: Demo = {
  /* id must match the data-demo attribute on the .viewer-window in index.html.
     Lowercase, hyphenated, and also the folder name under public/splat/. */
  id: 'my-room',
  title: 'My Room',
  scale: 'Medium scale', // "Small scale" | "Medium scale" | "Large scale"
  blurb:
    'One or two lines describing the capture. Shown in the info drawer, not on ' +
    'the card.',

  /* The unpacked SOGS bundle: public/splat/<id>/meta.json plus its .webp
     siblings. Produce it by unzipping the .sog export:
         unzip -o MyRoom.sog -d public/splat/my-room
     A full https:// URL also works for assets too large to commit, provided the
     host sends a permissive Access-Control-Allow-Origin. */
  src: 'splat/my-room/meta.json',

  /* 'hud-bottom' is the right default for a gear-focused room: a bottom bar
     leaves the object unobstructed, and it is the placement the prev/next
     stepper is styled for. 'hud' puts the same panel on the left. 'anchored'
     pins a small callout to the 3D point instead — good for architectural
     notes, cramped for paragraphs, and it gets no stepper. */
  cardStyle: 'hud-bottom',

  /* The window aspect these poses were AUTHORED at. Pose fov is vertical, so on
     a narrower viewport the same fov silently crops the sides; the camera widens
     the vertical fov to preserve the authored horizontal coverage. Keep this in
     sync with the .ratio-* class used on the window in index.html. */
  refAspect: 16 / 9,

  /* The opening shot. Stand where the room reads best and run __logPose().
     Set to null to auto-frame from the splat's bounding box — usable only as a
     stopgap, and unreliable on scenes with distant floater gaussians, which
     inflate the bounds and aim the camera at empty space.

     fov 42 is tighter than the 55-75 the older demos use. It suits a room where
     the subject matter is individual pieces of gear rather than architecture. */
  initialPose: {
    position: [0, 0, 0],
    target: [0, 0, 0],
    fov: 42,
  },

  /* --------------------------------------------------------------------------
     HERO POINTS. Array order is authoring order, and it is load-bearing: the
     card's prev/next stepper walks this array, so put them in the order a
     visitor should tour the room.
     -------------------------------------------------------------------------- */
  heroPoints: [
    {
      /* Unique across the whole file (ids are not namespaced per demo). */
      id: 'example-piece',

      /* label is the CARD HEADING — use the full display name. */
      label: 'Manufacturer Model Name',

      /* caption is the small label that floats beside the dot in 3D on hover.
         Keep it SHORT: a long caption becomes a wide overlay hanging in the
         scene. It does not have to match the label. */
      caption: 'Model Name',

      /* One line under the heading. A bare year reads well against the
         uppercase letterspaced style. */
      subtitle: '1983',

      /* Injected as innerHTML, so inline markup works. The .hero-card-link
         class is available for anchors:
             <a class="hero-card-link" href="..." target="_blank"
                rel="noopener">link text</a>
         Backticks let apostrophes and quotes through untouched. */
      description: `Two to four sentences. Aim for what a visitor could not work
        out by looking: the year, why the piece mattered, one concrete detail.`,

      /* Where the fly-in lands. Straight from __logPose(). */
      pose: { position: [0, 0, 0], target: [0, 0, 0], fov: 42 },

      /* THE DOT'S 3D POSITION — and NOT the same thing as pose.target.

         __logPose() reports target as a look-at point a fixed ~0.6 m ahead of
         the camera, which is empty air. Omitting `anchor` falls back to it, and
         the dot then parallaxes across the object as the camera dollies: it is
         pinned correctly in world space, just to nothing.

         Put the anchor ON the object's surface. Add ?author to the URL, aim the
         crosshair at the piece, and run __logAnchor(). */
      anchor: [0, 0, 0],

      /* Close-up behaviour once the fly-in lands.

         pivot 'anchor'  orbit the object, not the look-at point. Without this
                         the pivot is pose.target ~0.6 m out, and dragging reads
                         as looking side to side rather than circling the piece.
                         main.ts additionally pushes the pivot past the anchor by
                         HERO_PIVOT_PUSH so it sits nearer the object's middle
                         than its front face.

         direction       'left' | 'right' | 'random' | 1 | -1. Which way the
                         orbit SETS OFF, not which side it stays on — in sway
                         mode the camera is a pendulum and visits both ends of
                         its window. 'random' is drawn per click.

         arc [lo, hi]    degrees relative to the landing yaw that the camera may
                         occupy, asymmetric allowed. This is the knob for a piece
                         backed against a wall. Omit for the default +/-60.
                         Measured sign: dragging RIGHT moves the offset NEGATIVE,
                         so [-50, 0] is the side you reach by dragging right.
                         Idle sway takes a quarter of the arc, centred on the
                         landing yaw so the authored framing is always in shot.

         mode            'sway' (default) | 'spin' (full 360 turntable, ignores
                         arc) | 'none' (hold the framing still).

         amplitude       override the idle sway half-width. Useful with a wide
                         arc: plenty of room to drag, calm when left alone.
         speed / ease    sway feel; defaults 7.5 deg/s and 6 deg of easing. */
      autoOrbit: { pivot: 'anchor', direction: 'random' },
    },
  ],
};
