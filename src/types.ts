/* ============================================================================
   types.ts — the shared vocabulary: every interface the viewer's config speaks.
   ----------------------------------------------------------------------------
   Engine files import their types from HERE, never from demos.ts — demos.ts is
   one deployment's data, and a compile-time dependency on it would weld the
   engine to a client. demos.ts itself imports these types and stays data-only.
   ========================================================================== */

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

/* ---- Walk region geometry (consumed by walk.ts's WalkConstraint) ---------- */

/** An island: an oriented rectangle subtracted from the region, plus its pad. */
export interface WalkHole {
  /** Centre in world units, (x, z). */
  centre: [number, number];
  /** Half-width / half-depth in world units, along the rect's own axes. */
  halfExtent: [number, number];
  /** Rotation of the rect's local +x axis, degrees CCW in the (x, z) plane. */
  angleDeg?: number;
  /**
   * Standoff in METRES, inflating the hole outward. The two standoffs exist for
   * different reasons: tall gear (rack, console, meterbridge) wants an OPTICAL
   * pad of ~0.5 m, because close contact fills the frame with the least
   * reconstructed geometry in the scene. Low furniture only wants ~0.15-0.20 m,
   * for plausibility — it never enters the render badly, it is just implausible
   * to stand inside a couch.
   */
  pad?: number;
}

/**
 * A local override of the boundary falloff, over an axis-aligned box.
 *
 * The falloff is a compromise: wide enough that a wall never feels like a stop,
 * narrow enough that a corridor still has a full-speed core. In a room with both
 * open floor and a thin connecting channel there is no single value that suits
 * both — 0.25 m is right in the open and swallows a 0.35 m channel whole. So the
 * channel gets its own.
 */
export interface WalkFalloffZone {
  /** Box corner in WORLD units, (x, z). Order does not matter. */
  min: [number, number];
  max: [number, number];
  /** Falloff to use inside the box, METRES. */
  falloff: number;
  /** Free-text; ignored. Say why the zone exists. */
  note?: string;
}

/** A walkable region: an outer ring, minus any inner rings and island rects. */
export interface WalkRegion {
  /** Outer boundary, world (x, z). Winding does not matter — see pointInRing. */
  outer: [number, number][];
  /** Interior boundaries from plan-fill: architecture, alcoves. */
  innerRings?: [number, number][][];
  /** Island furniture as oriented rects. */
  holes?: WalkHole[];
  /**
   * Boundary softening distance in METRES. Movement INTO the boundary scales by
   * smoothstep(0, falloff, d). Larger reads as gentler, but starts damping
   * further out — which in a tight room means most of the floor. Default 0.25.
   */
  falloff?: number;
  /**
   * Local falloff overrides. The effective falloff at a point is the SMALLEST of
   * the global value and every zone containing it, so zones may overlap and the
   * tightest wins. A hard switch at a zone edge is deliberate and unnoticeable
   * in practice: a zone exists because the space inside it is thin, and just
   * outside one the visitor is in open floor where the smoothstep is saturated
   * at 1 either way, so there is no speed to jump.
   */
  falloffZones?: WalkFalloffZone[];
  /**
   * How far inside to place a camera that has to be brought in from outside —
   * the opening shot, or the return from a hero close-up, both of which are
   * authored outside the region by design. METRES. Landing exactly on the
   * boundary (d = 0) would drop the visitor somewhere fully damped.
   */
  spawnMargin?: number;
}

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
