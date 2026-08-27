/* ============================================================================
   demos.ts — THE ONE FILE YOU EDIT to tune the demo reel.
   ----------------------------------------------------------------------------
   This is the equivalent of the SuperSplat starter's `splat-config.ts`, extended
   for three scenes and their hero points. Everything the viewer shows (scene
   files, camera framing, copy, hero-point positions) is declared here as data.
   No rendering logic lives in this file.

   HOW POSES WORK
   --------------
   A pose describes where the camera sits and what it looks at:
     position  — [x, y, z] world coordinates of the camera
     target    — [x, y, z] world point the camera aims at (also the orbit pivot)
     fov       — vertical field of view in degrees (lower = more "zoomed in")

   You cannot guess these numbers — they only make sense against the rendered
   scene. Author them the same way as the pilot rig: run `npm run dev`, free-fly
   to a framing you like, open the browser console and run  __logPose()  — it
   prints a ready-to-paste pose. Drop it into `initialPose` (the opening shot) or
   a hero point's `pose` (where the fly-in lands). The `anchor` is the 3D point
   the floating label pins to; if omitted it defaults to the pose's target.

   All coordinate values below are PLACEHOLDERS marked TODO. They will be wrong
   until authored against your real .sog scenes.
   ========================================================================== */

/* ---- Brand -----------------------------------------------------------------
   The deployment's identity — console log prefix and disclaimer signature.
   Data, like everything else in this file; main.ts hands it to setBrand()
   at boot so no engine file carries a client string. */
export const BRAND = { name: 'Darilux Studio', tag: 'darilux' };

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface HeroPoint {
  id: string;
  label: string;          // short name shown in the drawer menu
  caption: string;        // floating label next to the 3D marker
  pose: Pose;             // where the fly-in lands
  anchor?: [number, number, number]; // 3D point the marker pins to (default: pose.target)
  /**
   * Marker style. 'info' renders a slightly larger circle with an enclosed
   * question mark — for explanatory notes about the capture itself rather
   * than featured gear. Behaves exactly like a normal hero point otherwise.
   */
  variant?: 'info';

  // ---- Description card (shown when the dot or the menu item is clicked) ----
  icon?: string;          // small glyph beside the card title (e.g. 'speaker')
  subtitle?: string;      // e.g. "Analog synthesizer · 1981"
  description?: string;   // paragraph of copy
  specs?: { label: string; value: string }[]; // optional spec rows, e.g. { label: 'Voices', value: '6' }

  // ---- Auto-orbit behavior once the fly-in lands (optional) ----
  //   mode 'sway' (default) = gentle pendulum around the front arc
  //   mode 'spin'           = continuous full 360° turntable (central fixtures)
  //   mode 'none'           = hold still — no auto motion (visitor can still orbit)
  //   direction -1          = start the sway / spin in the opposite direction
  //   pivot 'anchor'        = orbit around the dot's 3D point (default 'view' = the pose target)
  //   arc [lo, hi]  = the yaw range the camera may occupy, in degrees relative
  //     to the landing yaw. May be asymmetric — use it to keep a hero from
  //     swinging into a wall. Defaults to ±60.
  //   speed / ease / amplitude = optional per-hero overrides of the sway feel
  //     (defaults: speed 7.5°/s, ease 6°, sway = middle half of the arc).
  //     Lower speed + higher ease = smoother, gentler turnaround.
  autoOrbit?: {
    mode?: 'sway' | 'spin' | 'none';
    /**
     * Which way the orbit SETS OFF after the fly-in lands.
     *   'right' / 1    the rig's default — the way every hero moved before
     *                  this parameter existed
     *   'left'  / -1   the other way
     *   'random'       drawn per click, so repeat visits differ
     *
     * NOTE this is the STARTING direction, not a side. In mode 'sway' (the
     * default) the camera is a pendulum, so it visits both ends of its window
     * whatever this is set to. To keep a hero off one side entirely, restrict
     * `arc` — and note that a one-sided arc makes this parameter moot, since
     * only one direction is then available.
     */
    direction?: 1 | -1 | 'left' | 'right' | 'random';
    pivot?: 'anchor' | 'view';
    speed?: number;
    ease?: number;
    /**
     * ORBIT ARC — the yaw range this hero may occupy, in degrees relative to
     * where the fly-in lands. `[left, right]`, and it may be ASYMMETRIC: that is
     * the point. A hero backed against a wall on its right gets an arc that
     * simply excludes the wall.
     *
     * SIGN, measured rather than assumed: dragging the mouse RIGHT moves the
     * offset NEGATIVE (a full drag clamps at -60 on the default arc). So:
     *
     *   arc: [-50, 0]     only the side you reach by dragging RIGHT
     *   arc: [0, 40]      only the side you reach by dragging LEFT
     *   arc: [-25, 25]    both ways, tighter than default
     *   (omitted)         ±60, the default
     *
     * Careful: `direction: 'right'` is +1, i.e. the POSITIVE side, so its sense
     * of "right" is the opposite of a rightward mouse drag. If you are unsure
     * which physical side you want for a given hero, set a one-sided arc, click
     * the hero, and drag — you will only be able to go one way, and you will see
     * immediately whether it is the safe side.
     *
     * Bounds manual dragging. Idle sway is a quarter of the arc wide, centred on
     * the LANDING yaw so the authored framing is always part of the resting
     * motion — for the default ±60 that is exactly ±30. On a one-sided arc the
     * window is shifted inward rather than shrunk, so [0, 40] sways over [0, 20].
     * Set `amplitude` to override the width. Ignored by mode 'spin', which is a
     * deliberate full 360.
     */
    arc?: [number, number];
    /** Idle sway half-width, degrees. Defaults to a quarter of the arc. */
    amplitude?: number;
    /** Symmetric shorthand for `arc: [-n, n]`. Ignored when `arc` is set. */
    yawLimit?: number;
  };
}

import type { WalkRegion } from './walk';
export type { WalkRegion, WalkHole, WalkFalloffZone } from './walk';

/**
 * WALK MODE — constrained movement at a fixed standing eye height.
 * ----------------------------------------------------------------------------
 * Per the navigation model in RESTYLE_HANDOFF: a visitor experiences a scene as
 * an authored hero fly-in OR a walk at fixed eye height. Never a free fly. The
 * point is not to restrict the visitor — it is that a splat is only trustworthy
 * where the capture rig actually went. A camera that can rise above the top ring
 * or sink to the floorboards is a camera aimed at unreconstructed haze.
 *
 * Set this on a demo to height-lock its free movement. Omit it and that demo
 * keeps the old free-fly behaviour untouched. `?author` also disables walk mode
 * wholesale, because authoring a hero pose 2.4 m up needs the free fly; use
 * `__walk(1)` in the console to force it back on while authoring.
 *
 * WHERE THE NUMBERS COME FROM (Bluedio, and the shape of it for any scene):
 * `floorY` and `unitsPerMetre` are properties of the SCENE, derived once — for
 * Bluedio, from the density plane the autoscene pipeline found plus Will's
 * 1.40 m anchor. `eyeHeight` is a design choice layered on top of them. They
 * are kept separate so retuning the eye height never means touching the scale.
 */
export interface WalkConfig {
  /**
   * Standing eye height in METRES above `floorY`. 1.55 per the spec: it sits
   * between the 1.4 m and 1.9 m capture rings, so every horizontal look
   * direction is bracketed above and below by a covered height rather than
   * extrapolating off the top one. Tune live with `__eyeHeight(1.6)`.
   */
  eyeHeight: number;
  /** World-space y of the floor plane (Bluedio: -4.20, after the 180° Z roll). */
  floorY: number;
  /** World units per metre in this scene (Bluedio: 3, i.e. 1 unit = 1/3 m). */
  unitsPerMetre: number;
  /** Walking speed, metres per second. Default 1.25 — an unhurried indoor walk. */
  speed?: number;
  /** Shift multiplier. Default 2: a brisk walk, deliberately not a sprint. */
  runMultiplier?: number;
  /**
   * Acceleration time constant, seconds. Default 0.11. This is the difference
   * between feeling like a body and feeling like a cursor — instant on/off is
   * the single biggest tell that you are driving a camera rather than walking.
   */
  accel?: number;
  /**
   * OPTIONAL soft look limits, degrees from level. Omit — the default — and the
   * look is FREE, per WALK_IMPLEMENTATION_BRIEF §5: "Being unable to turn your
   * head reads as claustrophobic; being unable to walk somewhere reads as
   * furniture." Reach for this only if ceiling coverage proves thin in review,
   * which is the one case the brief allows it for.
   */
  look?: { down: number; up: number };
  /**
   * Seconds to ease from the opening shot down onto the walk plane, the first
   * time the visitor moves. Default 1.1. Set 0 to start on the plane instead.
   */
  settle?: number;
  /**
   * The walkable region (see walk.ts). Omit it and movement is height-locked
   * but otherwise unbounded — the right state for authoring a new scan, before
   * its envelope has been derived. Polygons are in VIEWER WORLD units; every
   * distance INSIDE the region (falloff, pads, margins) is in METRES.
   */
  region?: WalkRegion;
}

/**
 * The navigation help behind the stage's i button.
 *
 * It lives here rather than in markup because the page copy under a viewer is
 * unreachable while a scene is open — the page is frozen — so this is the only
 * place a visitor can find out how to move. Per demo, because a demo with no
 * walk block is flown rather than walked and wants different words.
 */
export interface DemoGuide {
  /** Small uppercase heading. Defaults to 'Moving around'. */
  title?: string;
  /** Rendered as a definition list: the key or gesture, and what it does. */
  keys: { key: string; action: string }[];
  /** Optional closing line, set off by a rule. Say what the mode guarantees. */
  note?: string;
}

export interface Demo {
  id: string;
  title: string;
  scale: string;          // "Small scale", "Medium scale", "Large scale"
  blurb: string;          // one/two lines shown in the info drawer
  /**
   * The WEB-READY compressed splat. Two forms are accepted:
   *   • Local path  — 'splat/<name>.sog' (file in public/splat/, served from Pages)
   *   • Full URL    — 'https://…/<name>.sog' (e.g. Cloudflare R2 / a CDN for large
   *                   scenes that exceed a host's per-file limit)
   * Mix and match per demo. For a cross-origin URL, the bucket/CDN must send an
   * Access-Control-Allow-Origin header that permits this site.
   * See public/splat/README.txt for how to produce these from your .ply files.
   */
  src: string;
  /**
   * OPTIONAL reduced bundle, loaded instead of `src` on a phone. Same format,
   * same coordinates, fewer gaussians — so every authored pose, hero anchor and
   * walk polygon keeps working untouched. Omit it and phones load `src`.
   *
   * This exists because splat COUNT is the one cost a phone cannot be talked out
   * of. A device that falls back to WebGL2 — an older phone, or any in-app
   * browser wrapping WKWebView — sorts the whole cloud on the CPU every time the
   * camera moves, and that sort is LINEAR in the count. No resolution or fill
   * setting touches it. When a sort overruns a frame the depth order lands stale
   * and the picture swims rather than merely running slow.
   *
   * Bluedio's is built by `autoscene/mobile_asset.py` — see autoscene/RUNNING.md.
   * It is deliberately NOT a uniform decimation: it crops the capture floaters,
   * deletes the big-and-faint haze gaussians that carry about a third of all
   * fill, and then keeps the top million by how much screen area they could ever
   * occupy from anywhere a visitor can actually stand. Regenerate it whenever
   * the walk region, the hero poses, or the source scan change.
   */
  srcMobile?: string;
  /**
   * The opening shot when this demo loads. Set to null to auto-frame the scene
   * from its bounding box (used until a pose is authored with __logPose).
   */
  initialPose: Pose | null;
  heroPoints: HeroPoint[];
  /**
   * Hero description card style:
   *   'hud'      — fixed glass panel on the left (default)
   *   'anchored' — small callout pinned to the hero's 3D point, tracking the camera
   */
  cardStyle?: 'hud' | 'hud-bottom' | 'anchored';
  /**
   * The viewer-window aspect ratio (width / height) this demo's poses were
   * AUTHORED at — i.e. the window's desktop CSS aspect. Pose `fov` is vertical,
   * so on a narrower viewport (e.g. the 16:9 windows becoming 4:3 on mobile)
   * the same fov silently crops the sides. The camera compensates: whenever the
   * live aspect is narrower than this reference, it widens the vertical fov to
   * preserve the authored HORIZONTAL coverage. Defaults to 16/9.
   */
  refAspect?: number;
  /** Navigation help shown by the stage's i button. Omit and the i is hidden. */
  guide?: DemoGuide;
  /**
   * The same help, rewritten for touch. Shown instead of `guide` on a phone.
   *
   * This is not a nicety. `guide` names W A S D, Shift and Esc — three things a
   * phone does not have — so on the one device where the i button is the ONLY
   * reachable explanation, the old copy described controls the visitor could not
   * use. Falls back to `guide` when omitted, so a demo need only write this once
   * it has touch controls worth describing.
   */
  guideTouch?: DemoGuide;
  /**
   * Height-locked walk movement for this demo (see WalkConfig). Omit for the
   * legacy free-fly. Only a scene with a KNOWN floor plane and metre scale can
   * honestly have one — a guessed floor puts the visitor's eyeline in the wrong
   * place, and then every framing in the room reads subtly wrong.
   */
  walk?: WalkConfig;
}

export const DEMOS: Demo[] = [
  /* ---------------------------------------------------------------------- */
  {
    id: 'synths',
    title: 'Legendary Synthesizers',
    scale: 'Small scale',
    blurb:
      'A tight capture of five synthesizers. Tap a hero point to fly in and read ' +
      'each instrument close-up — the level of detail a single object can hold.',
    src: 'splat/synths/meta.json', // SOGS bundle ("Synth Heroes Rev" export)
    cardStyle: 'hud-bottom', // stationary HUD card, bottom-center
    refAspect: 3.4 / 5.5, // keep in sync with .ratio-tall in style.css
    // Real pose authored in SuperSplat and carried over from the starter.
    // Depth illusion: rest wide-ish at 80, then every hero fly-in eases the fov
    // out to 120 while the camera moves in — a dolly-zoom feel. Closing the
    // card flies home and reverses it. (flyTo lerps fov, so no code needed.)
    initialPose: {
      position: [0.432,0.536,-4.077],
      target: [0.237,0.385,-1.769],
      fov: 80,
    },
    heroPoints: [
      // Authored in SuperSplat via __logPose(). Each target sits on the instrument,
      // so it doubles as the floating label's anchor.
      {
        id: 'moog-sub-phatty',
        label: 'Moog Sub Phatty',
        caption: 'Moog Sub Phatty',
        pose: { position: [0.136, 2, -1.546], target: [-0.081, 2.282, 0.535], fov: 120 },
        anchor: [0.3,2.22,0],
        description:
          'A modern Moog monosynth with a Multidrive circuit and dedicated sub ' +
          'oscillator, built for weighty, growling low-end.',
        specs: [
          { label: 'Released', value: '2013' },
          { label: 'Sound', value: 'Gritty, punchy' },
        ],
      },
      {
        id: 'moog-minimoog',
        label: 'Moog Minimoog',
        caption: 'Moog Minimoog',
        pose: { position: [0.127, 1.6, -1.643], target: [-0.061, 1.264, 0.35], fov: 120 },
        anchor: [0.555, 1.4,0],
        subtitle: 'Model D',
        description:
          'The first portable synth to leave the lab for the stage, and the fat, ' +
          'singing voice behind five decades of bass and lead lines.',
        specs: [
          { label: 'Released', value: '1970' },
          { label: 'Sound', value: 'Warm, muscular' },
        ],
      },
      {
        id: 'sequential-prophet-10',
        label: 'Sequential Prophet 10',
        caption: 'Sequential Prophet 10',
        pose: { position: [0.215, 0.85, -1.87], target: [-0.052, 0.406, 0.123], fov: 120 },
        anchor: [0.5,0.658,0],
        description:
          'Ten voices of programmable analog — two Prophet-5s in one chassis — ' +
          'made for dense pads and orchestral swells.',
        specs: [
          { label: 'Released', value: '1980' },
          { label: 'Sound', value: 'Thick, cinematic' },
        ],
      },
      {
        id: 'roland-juno-60',
        label: 'Roland Juno-60',
        caption: 'Roland Juno-60',
        pose: { position: [0.122, 0.276, -1.864], target: [-0.06, -0.164, 0.173], fov: 120 },
        anchor: [0.78,-0.2,0],
        description:
          "One oscillator wrapped in Roland's unmistakable chorus, and arguably " +
          'the defining polysynth sound of the 1980s.',
        specs: [
          { label: 'Released', value: '1982' },
          { label: 'Sound', value: 'Shimmering, lush' },
        ],
      },
      {
        id: 'hohner-pianet-m',
        label: 'Hohner Pianet M',
        caption: 'Hohner Pianet M',
        pose: { position: [0.104, -0.67, -1.887], target: [-0.058, -0.846, 0.143], fov: 120 },
        anchor: [0.55,-0.87,0],
        description:
          "Hohner's reed-driven electric piano, carrying the warm, plaintive " +
          "Pianet voice woven through the fabric of '60s and '70s pop.",
        specs: [
          { label: 'Released', value: 'c. 1977' },
          { label: 'Sound', value: 'Warm, reedy' },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'studio-e',
    title: 'Studio E',
    scale: 'Medium scale',
    blurb:
      'Full-room coverage of Studio E. Move freely through the space, or fly to a ' +
      'hero point to inspect the featured gear at capture-grade fidelity.',
    src: 'splat/studio-e/meta.json', // SOGS bundle ("best Studio E yet" export)
    cardStyle: 'hud-bottom', // demo-1 style HUD card, anchored to the bottom of the screen
    refAspect: 16 / 9, // poses authored in the desktop .ratio-16x9 window (4:3 on mobile)
    // Authored opening pose carried over from the new (half) scan's starter.
    initialPose: {
      position: [-0.81,5.653,-7.861],
      target: [-0.742,4.881,-4.484],
      fov: 75,
    },
    heroPoints: [
      {
        id: 'atmos-monitors',
        label: 'Dolby Atmos Monitors',
        caption: 'PMC 6-2 · Immersive monitoring',
        icon: 'speaker',
        pose: { position: [-0.573, 5.828, -0.402], target: [-0.54, 4.666, 2.862], fov: 75 },
       anchor: [-0.409, 1.72, 6.852],
        description: `Studio E's Atmos bed runs on PMC 6-2 monitors — a three-way active design PMC released in 2021, purpose-built for rooms where immersive mixes have to translate exactly. Twin 6" woofers, a 2" midrange, and a 1" tweeter are each driven by their own 400W Class-D amplifier, with PMC's ATL bass-loading holding tonal balance steady from quiet reference levels up to 109dB. The result: what you hear at the desk is what ships.`,
      },
      {
        id: 'capture-quality',
        label: 'Why does it look like that?',
        caption: 'Why does it look like that?',
        variant: 'info',
        pose: { position: [-1.535, 4.29, 2.127], target: [1.418, 5.373, 0.672], fov: 75 },
        anchor: [9.543, 5.104, -4.374],
        autoOrbit: { mode: 'none' }, // hold the framing still — this one's for reading
        description:
          `The biggest advantage of Gaussian Splatting is also in some ways its biggest issue. It all hinges upon method of capture. If an iPhone is capturing a space in low light, due to hardware constraints (such as size of lens and FOV) details can become soft and fuzzy, which the compiler translates exactly as they're presented — creating soft floating gaussians and inconsistencies in some walls and angles.<br><br>` +
          `The fix? A higher quality method of capture. Final captures will be done with a Sony ZV-E1 using a 20mm lens, meaning impeccable capture of details even at low light, with a much wider field of view to gather more visual information. That way you preserve details even after compiling/compression. While there may still be some minor gaussian artifacts, they will be hardly noticeable compared to the iPhone capture. ` +
          `<a class="hero-card-link" href="https://superspl.at/scene/b149b2b0" target="_blank" rel="noopener">Here is an example using a similar camera setup</a>.`,
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'common-room',
    title: 'Common Room',
    scale: 'Large scale',
    blurb:
      'The common room — a composite of two captures stitched into one scene to ' +
      'show how fidelity holds across a larger space. Roam the whole room.',
    src: 'splat/common-room/meta.json', // SOGS bundle (composite of two captures)
    cardStyle: 'anchored', // callouts pinned to the 3D point rather than a HUD panel
    refAspect: 16 / 9, // poses authored in the desktop .ratio-16x9 window (4:3 on mobile)
    // Rough starting pose aimed at the scene's actual (offset) center. Bounds are
    // floater-inflated (~31 units) so auto-framing fails; explicit pose instead.
    // REFINE with __logPose() for the real shot.
    initialPose: {
     position: [17.423, 1.43, -3.132], 
     target: [9.492, 1.44, -3.887],
     fov: 60
    },
    heroPoints: [
      // TODO: author each — fly + __logPose() for `pose`, crosshair (?author) +
      // __logAnchor() for `anchor`, then add subtitle/description/specs copy.
      {
        id: 'common-hero-1',
        label: 'Meeting Space',
        caption: 'Meeting Space',
        pose: { position: [-0.439, 2.163, -15.634], target: [-1.161, 1.963, -11.403], fov: 55 },
        anchor: [-2.5,0,-5],
        autoOrbit: { mode: 'spin', pivot: 'anchor' }, // full 360° turntable around the fixture
        description: 'The perfect place to unwind or discuss the next big idea with your team.',
      },
      {
        id: 'common-hero-2',
        label: 'Lounge Area',
        caption: 'Lounge Area',
        pose: { position: [-7.847, 1.005, -20.128], target: [-12.085, 0.91, -20.827], fov: 55 },
        anchor: [-16.395,0.558,-22.091],
        // Much gentler sway: ~30% speed with a wide ease zone for a soft turnaround.
        autoOrbit: { direction: -1, speed: 2.25, ease: 22 },
        description: 'Surround yourself with incredible gear and watch how easy it is to get inspired.',
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'bluedio',
    title: 'Bluedio',
    scale: 'Medium scale',
    blurb:
      'A dense live room - drum kit, synth wall, DJ booth, red drapes. Ten hero ' +
      'points, each flying to a piece of gear you can orbit and read about.',
    src: 'splat/bluedio/meta.json', // SOGS bundle ("Bluedio_optimized.sog", 2,534,528 gaussians)
    /* 1,200,000 gaussians / 18.0 MB, against the desktop bundle's 2,534,528 /
       34.4 MB. Measured on the WebGL2 path, the depth sort drops from 20 ms to
       8-10 ms — it is linear in the count, and that sort is what makes an older
       phone feel laggy rather than merely soft. Visually it is very close: the
       reduction MERGES neighbouring gaussians rather than deleting them, so
       surfaces stay sealed. Verified by A/B against the full asset at the
       opening pose and at a hero close-up.
       Built by autoscene/mobile_asset.py + splat-transform; the exact commands
       and the reasoning behind each stage are in autoscene/RUNNING.md. */
    srcMobile: 'splat/bluedio-mobile/meta.json',
    cardStyle: 'hud-bottom',
    refAspect: 16 / 9,

    /* The i in the bottom-left corner opens this. It repeats what the copy under
       the viewer says, and that is not redundant: the two are read at different
       times. The page copy sells the room to someone scrolling past; this is the
       only version reachable once a scene is open, because the page is frozen
       then. Keep them in step. */
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

    /* The phone version of the same card, and the ONLY navigation instructions a
       phone visitor can reach — the page copy is behind a frozen page, and the
       desktop list above named W A S D, Shift and Esc, none of which exist on a
       touch screen. Ordered by what a thumb finds first: the two sticks, then the
       points, then the housekeeping. Deliberately says LEFT and RIGHT rather than
       "the sticks", because at a glance both pads look identical and the whole
       question a first-time visitor has is which one walks. */
    guideTouch: {
      title: 'Moving around',
      keys: [
        { key: 'Left stick', action: 'Walk — push it the way you want to go' },
        { key: 'Right stick', action: 'Look around, as if turning your head' },
        { key: 'Tap a point', action: 'Fly in for a closer look' },
        { key: 'Arrows', action: 'Step to the next piece of gear' },
        { key: 'Close ×', action: 'Leave a close-up and get the sticks back' },
        { key: 'Toggle', action: 'Show or hide the points' },
      ],
      note:
        'Push a stick gently to move slowly. You stay at standing height ' +
        'throughout, so the room is seen the way you would see it standing in it.',
    },

    /* ---- WALK MODE -------------------------------------------------------
       Bluedio is the one scene whose floor and scale are DERIVED rather than
       guessed, so it is the one scene that can honestly be height-locked.

         floorY -4.20     the single sharp density plane autoscene found (103k
                          gaussians in a 4 cm band) at raw .sog y = +4.20,
                          negated by main.ts's 180° Z roll.
         unitsPerMetre 3  from Will's LichtFeld anchor: raw y = 0 is 1.40 m above
                          the floor, and 1.40 / 4.20 = 1/3 m per unit.
         eyeHeight 1.55   -> world y = -4.20 + 1.55 * 3 = +0.45.

       The 1.55-vs-1.40 tension is the one BLUEDIO_CONTEXT.md flags as needing a
       decision rather than a silent pick. Decided: 1.55, the spec's value. 1.40
       sits exactly on the mid capture ring, but 1.55 is BRACKETED by the 1.4 and
       1.9 m rings, which is the property that matters for a horizontal look.
       -------------------------------------------------------------------- */
    walk: {
      eyeHeight: 1.55,
      floorY: -4.2,
      unitsPerMetre: 3,

      /* ---- The walkable region -------------------------------------------
         Derived by `autoscene/envelope.py`, then hand-corrected against a
         marked-up copy of the figure it emits. Re-derive rather than editing
         these numbers:

             cd autoscene
             python envelope.py --edits edits_bluedio.json

         It starts from the same occupancy grid autoscene.py builds, but with
         three of its defaults changed — autoscene is tuned to decide WHETHER a
         room deserves walk mode, and this room has already been decided for:
         a 0.30 m wall inset (the plan boundary is already the gear FACE), a
         0.32 m pad off the tall console, and no 0.80 m corridor opening, since
         the falloff already makes a thin passage unattractive without deleting
         it. That alone takes the region from 2.93 m2 to 8.23 m2.

         Three hand edits then took it to 9.80 m2 (105 sq ft):
           - the north-east arm widened, which was too thin a sliver to move
             around in
           - the east corridor brought up to the console and its chair, whose
             0.32 m pad had pinched the corridor shut beside the chair. The
             chair itself stays solid: an `include` relaxes a standoff but is
             clipped to real free space, so the boundary stops at its surface
           - a channel south of the dub station, which CLOSES THE LOOP. That is
             what the single inner ring below is — the dub station can now be
             walked all the way around. The channel is thin, so it gets its own
             tighter falloff; see falloffZones.

         The ring is traced from a SMOOTHED distance field. Traced off the raw
         5 cm grid, its normal snaps 90 degrees every cell, and the falloff acts
         along that normal — so sliding along a wall would stutter.
         ------------------------------------------------------------------ */
      region: {
        falloff: 0.25,
        spawnMargin: 0.3,
        /* The channel south of the dub station is ~0.35 m wide, so the global
           0.25 m falloff would swallow it whole and there would be no
           full-speed core to walk down. Box is in WORLD units; falloff is in
           METRES, like every other distance in this block. */
        falloffZones: [
          {
            min: [-0.75, -4.65],
            max: [3.75, -2.85],
            falloff: 0.1,
            note: 'the thin channel that closes the loop around the dub station',
          },
        ],
        outer: [
          [-7.225, 5.629],
          [-7.225, 4.579],
          [-6.850, 4.204],
          [-3.850, 4.204],
          [-3.025, 3.829],
          [-3.025, -0.071],
          [-2.800, -0.296],
          [-2.200, -0.296],
          [-1.825, -0.671],
          [-1.825, -1.271],
          [-2.350, -1.796],
          [-2.800, -1.796],
          [-3.025, -2.021],
          [-3.025, -2.921],
          [-2.425, -3.521],
          [-1.975, -4.421],
          [-1.825, -4.871],
          [-1.975, -5.771],
          [-1.750, -5.996],
          [-1.450, -5.846],
          [0.650, -5.996],
          [1.175, -5.021],
          [3.200, -3.896],
          [3.650, -2.996],
          [5.150, -2.546],
          [5.600, -2.696],
          [7.100, -2.546],
          [7.550, -2.696],
          [8.600, -3.596],
          [9.125, -3.521],
          [9.275, -2.621],
          [9.575, -2.321],
          [9.725, 0.079],
          [9.425, 0.829],
          [9.575, 2.779],
          [9.050, 3.754],
          [7.850, 4.204],
          [7.700, 4.054],
          [7.100, 4.204],
          [6.500, 4.954],
          [5.300, 4.804],
          [4.400, 5.404],
          [3.350, 5.254],
          [1.250, 5.404],
          [0.350, 4.804],
          [-0.400, 4.654],
          [-0.850, 4.804],
          [-1.900, 5.854],
          [-7.000, 5.854],
        ],
        innerRings: [
          [
            [-0.400, 2.404],
            [-0.175, 2.929],
            [0.350, 3.304],
            [2.900, 3.154],
            [3.575, 2.479],
            [3.575, 1.729],
            [4.775, 0.829],
            [5.075, 0.229],
            [4.775, -0.671],
            [3.575, -1.571],
            [3.425, -2.621],
            [2.600, -3.296],
            [0.650, -3.296],
            [-0.475, -2.621],
          ],
        ],
      },
    },

    /* ---- COORDINATE NOTE - read before pasting anything from scene.json ----
       main.ts rolls every splat entity 180 deg about Z, so a raw .sog point
       (x, y, z) lands in WORLD space at (-x, -y, z). The autoscene pipeline in
       `autoscene/` emits raw .sog coordinates, so its numbers
       must have x and y NEGATED before they go in here. (That roll is also what
       turns the Y-down .sog into a Y-up world: raw floor y=+4.20 -> world
       y=-4.20, and the raw eye plane y=0 stays at world y=0, i.e. 4.20 units =
       1.40 m above the floor at 1 unit = 1/3 m.)

       Poses captured in-browser with __logPose() are ALREADY world-space and
       need no conversion - that is the path to use.
       -------------------------------------------------------------------- */

    // Opening shot from autoscene: the walk-region seat with the most saliency
    // in frame, 0.316 m clear of the walk boundary. Raw .sog was
    // position [-7.5497, 0, 2.1787] / target [-0.6553, 0.75, 7.9638], yaw 40.
    // fov 42 matches the vertical FOV the CPU contact sheet was rendered at, so
    // this frame is the one verified in autoscene/previews.png.
    initialPose: {
      position: [10.473, 2.213, -3.39],
      target: [3.111, -0.507, 1.079],
      fov: 42,
    },

    /* Authored by Will with __logPose(), in viewer WORLD space - no conversion
       needed or applied. Order here is the order the markers are created in.

       `anchor` is NOT pose.target, and must not be. __logPose() reports target
       as a look-at point a fixed ~0.6 m ahead of the camera, so falling back to
       it pins the marker to empty air 0.29-2.24 m in FRONT of the gear (2.24 m
       for the DJ booth). The dot is then perfectly fixed in world space but
       slides across the object behind it as you orbit - reads as drift.

       Each anchor below is instead the first visible surface along that pose's
       own view ray, found by marching the decoded point cloud. Because the
       anchor lies ON that ray, the dot still projects dead-centre from its own
       hero pose - only the off-axis views are corrected. Re-derive with
       ?author + __logAnchor() if a pose changes.

       TODO: subtitle / description / specs copy for each. Left blank on
       purpose rather than guessed at - the cards render a placeholder. */
    heroPoints: [
      {
        id: 'dub-station',
        label: 'Dub Station',
        caption: 'Dub Station',
        subtitle: 'Ongoing',
        description: `Equipped with analog delay pedals, an SSL X-Logic mixer and drum sequencers, this station is every live dub artist's dream come true.`,
        pose: { position: [6.552, 1.022, 0.198], target: [4.852, 0.357, 0.268], fov: 42 },
        anchor: [1.303, -1.031, 0.414],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'roland-space-echo',
        label: 'Roland RE-201 Space Echo',
        caption: 'Roland Space Echo',
        subtitle: '1974',
        description: `A loop of tape running freely past three playback heads, with spring reverb alongside. Push the intensity and it self-oscillates; ride the tape speed and the repeats bend in pitch.`,
        pose: { position: [6.872, -2.034, -2.087], target: [5.191, -2.403, -2.077], fov: 42 },
        anchor: [2.946, -2.896, -2.064],
        autoOrbit: { pivot: 'anchor', direction: 'random', arc: [-25,25] },
      },
      {
        id: 'juno-6',
        label: 'Roland Juno-6',
        caption: 'Juno 6',
        subtitle: '1982',
        description: `The first Juno, and the synth that introduced Roland's digitally controlled oscillators — six voices that finally stayed in tune. One oscillator per voice, made enormous by the most recognizable chorus circuit ever built.`,
        pose: { position: [5.035, 1.887, 3.418], target: [5.114, 0.984, 5.004], fov: 42 },
        anchor: [5.224, -0.278, 7.221],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'jupiter-6',
        label: 'Roland Jupiter-6',
        caption: 'Jupiter 6',
        subtitle: '1983',
        description: `Six voices, two oscillators apiece, and a true multimode filter — sharper and more aggressive than the Jupiter-8 it was priced beneath. It is also where MIDI began: the protocol was first demonstrated in public on a Jupiter-6 at NAMM in January 1983.`,
        pose: { position: [5.282, 0.804, 3.115], target: [5.361, -0.105, 4.698], fov: 42 },
        anchor: [5.479, -1.465, 7.066],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'access-virus',
        label: 'Access Virus TI2 WhiteOut',
        caption: 'Access Virus',
        subtitle: '2010',
        description: `The final revision of the line that defined virtual analog synthesis, with three oscillators and two independent filters per voice. The WhiteOut was a numbered limited edition — 100 desktops, 150 keyboards, each with an engraved serial plate.`,
        pose: { position: [-0.309, 0.866, 3.09], target: [-0.208, 0.08, 4.619], fov: 42 },
        anchor: [-0.017, -1.407, 7.511],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'ursa-major-sst-282',
        label: 'Ursa Major SST-282 Space Station',
        caption: 'Ursa Major SST 282 Space Station',
        subtitle: '1978',
        description: `Less a reverb than a machine for inventing space, built in a cellar by an engineer who had walked out of Lexicon. A single delay line with wandering taps gives it a shimmer no room model can imitate; fewer than 2,000 were made.`,
        pose: { position: [-3.051, -2.63, 3.738], target: [-2.925, -2.766, 5.449], fov: 42 },
        anchor: [-2.862, -2.834, 6.303],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'urei-la-3a',
        label: 'UREI LA-3A Compressors',
        caption: 'UREI LA-3A compressors',
        subtitle: '1969',
        description: `The solid-state answer to the tube LA-2A, designed by the man who invented the wah pedal. Same optical cell, faster response, and a midrange presence engineers have chased ever since.`,
        pose: { position: [-2.897, 1.045, 2.946], target: [-4.284, -0.144, 2.998], fov: 42 },
        anchor: [-5.424, -1.121, 3.041],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'pioneer-dj-station',
        label: 'Pioneer DJ Station',
        caption: 'Pioneer DJ Station',
        subtitle: 'Ongoing',
        description: `Outfitted with the AlphaTheta CDJ-3000X, this state-of-the-art setup gives you the versatility to spin classics and brand new tracks with ease.`,
        pose: { position: [-2.998, 2.964, -0.14], target: [-4.67, 2.233, -0.038], fov: 42 },
        anchor: [-10.82, -0.456, 0.337],
        autoOrbit: { pivot: 'anchor', direction: 'random', arc: [-40,40] },
      },
      {
        id: 'shelford-channel',
        label: 'Rupert Neve Designs Shelford Channel',
        caption: 'Rupert Neve Designs Shelford Channel',
        subtitle: '2016',
        description: `Rupert Neve's first new transformer-gain Class A preamp in over forty years, paired with 1073-style inductor EQ and a 2254-style diode bridge compressor. Named for the English village where he designed the circuits that changed recorded music.`,
        pose: { position: [-2.634, 0.432, -3.534], target: [-4.188, -0.527, -3.476], fov: 42 },
        anchor: [-5.39, -1.269, -3.431],
        autoOrbit: { pivot: 'anchor', direction: 'random' },
      },
      {
        id: 'dj-sandman-theory',
        label: 'DJ Sandman Theory',
        caption: 'DJ Sandman Theory',
        subtitle: 'Circa 2000s · Ongoing',
        description: `Sandman Theory is a DJ and producer from Seattle, Washington with a knack for electronica, house, downtempo and trip-hop. Apart from opening for some of the best DJs in the world, his collection of analog synthesizers and gear elevates his production to new heights. Listen to his latest album, “<a class="hero-card-link" href="https://sandmantheory.net/flsessions" target="_blank" rel="noopener">The Fuzzy Lounge Sessions</a>”.`,
        pose: { position: [-1.507, 3.825, -4.566], target: [0.293, 3.738, -4.865], fov: 42 },
        anchor: [4.701, 3.525, -5.597],
        autoOrbit: { pivot: 'anchor', direction: 'random', arc: [0,40] },
      },
    ],
  },
];
