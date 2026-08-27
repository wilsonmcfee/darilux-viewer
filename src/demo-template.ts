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

import type { Demo } from './types';

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

  /* The i in the stage's bottom-left corner opens this. Omit it and the i is
     hidden.

     Worth having even though the same copy sits under the viewer in index.html:
     the page is FROZEN while a scene is open (see UI.lockPageScroll), so the
     copy below the window is unreachable exactly when a visitor wants it. The
     two are read at different times — one sells the room to someone scrolling
     past, one answers "how do I move" mid-scene. Keep them in step.

     Plain text; it is escaped, not injected, so no markup here. */
  guide: {
    title: 'Moving around',
    keys: [
      { key: 'Drag', action: 'Look around, as if turning your head' },
      { key: 'W A S D', action: 'Walk through the room' },
      { key: 'Shift', action: 'Walk faster' },
      { key: 'Click a point', action: 'Fly in for a closer look' },
      { key: 'Esc', action: 'Leave a close-up' },
      { key: 'Toggle', action: 'Show or hide the points' },
    ],
    note:
      'You stay at standing height throughout, so the room is seen the way you ' +
      'would see it standing in it.',
  },

  /* --------------------------------------------------------------------------
     WALK MODE — optional, and off entirely if this block is absent.

     With it, the visitor is locked to a standing eye height and confined to a
     derived region; without it they free-fly as every demo did before walk mode
     existed. The point is not to restrict anyone: a splat is only trustworthy
     where the capture rig actually went, so a camera that can rise above the top
     ring or sink to the floorboards is a camera aimed at unreconstructed haze.
     Every frame a visitor can reach is then a frame that was engineered to look
     good, which is a selling point rather than an apology.

     THE THREE SCENE NUMBERS. floorY and unitsPerMetre are facts about the SCENE;
     eyeHeight is a design choice on top of them. Kept separate so retuning the
     eye height never means touching the scale.

     Only fill this in for a scene whose floor you have actually DERIVED. A
     guessed floor puts the visitor's eyeline in the wrong place, and then every
     framing in the room reads subtly wrong — which is exactly the failure that
     is hard to diagnose later, because nothing looks broken.

     The Bluedio values below: floor from the one sharp density plane autoscene
     finds (raw .sog y +4.20, so world y -4.20 after the 180-degree roll); scale
     from the LichtFeld anchor (raw y 0 is 1.40 m up, so 1.40 / 4.20 = 1/3 m per
     unit); eye height 1.55 m, which sits BETWEEN the 1.4 and 1.9 m capture rings
     so a horizontal look is bracketed by two covered heights instead of
     extrapolating off the top one. Retune live with __eyeHeight(1.6).
     -------------------------------------------------------------------------- */
  walk: {
    eyeHeight: 1.55,
    floorY: -4.2,
    unitsPerMetre: 3,

    /* Optional, with sensible defaults:
         speed 1.25          m/s. An unhurried indoor walk
         runMultiplier 2     Shift. Brisk, deliberately not a sprint
         accel 0.11          s of ramp. The difference between feeling like a
                             body and feeling like a cursor — instant on/off is
                             the single biggest tell that you are driving a camera
         settle 1.1          s to ease from the opening shot down onto the plane
                             AND in from wherever it was authored, on the first
                             step. 0 starts the visitor already standing
         look                a { down, up } pitch clamp in degrees. Omitted, and
                             the look is FREE — leave it that way unless ceiling
                             coverage proves thin. Being unable to turn your head
                             reads as claustrophobic; being unable to walk
                             somewhere reads as furniture */

    /* THE WALKABLE REGION. Derive it, do not hand-write it:

           cd autoscene
           python envelope.py --xyz ./xyz.npy --sh0 ./sh0.npy

       That prints a paste-ready block and an envelope.png to judge it by. Read
       its LONGEST WALK number rather than its area — area counts a wide dead end
       the same as a route. Correct it by eye with --edits (see TEMPLATE.md 8c).

       Omit the region field entirely and movement is height-locked but unbounded,
       which is the right state while a new scan's envelope is still being worked out.

       UNITS: the polygon is in WORLD units, matching the poses in this file.
       falloff and spawnMargin are in METRES. walk.ts converts the ring once at
       construction, so a hand-written region is the only place the two can get
       mixed — and that is the likeliest bug in the whole feature. */
    region: {
      falloff: 0.25,      // m of boundary softening; only INWARD motion decays
      spawnMargin: 0.3,   // m inside the region to place a camera brought in
      outer: [
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    },
  },

  /* The opening shot. Stand where the room reads best and run __logPose().
     Set to null to auto-frame from the splat's bounding box — usable only as a
     stopgap, and unreliable on scenes with distant floater gaussians, which
     inflate the bounds and aim the camera at empty space.

     fov 42 is tighter than the 55-75 the older demos use. It suits a room where
     the subject matter is individual pieces of gear rather than architecture.

     It does NOT have to be somewhere a body could stand. Bluedio's opening shot
     is 2.14 m up and 0.42 m outside its own walk region, because that is where
     the room reads best on arrival — walk mode eases the visitor down and in on
     their first step. Frame it for the shot, not for the constraint. */
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
