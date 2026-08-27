/* ============================================================================
   camera.ts — orbit + fly camera with eased hero-point fly-ins.
   ----------------------------------------------------------------------------
   Interaction model (the "hybrid" from the pilot rig):
     • Free orbit / zoom / pan at all times (mouse + touch).
     • flyTo(pose) eases the camera to a framing, then hands control back so the
       visitor can orbit the thing they just flew to.
     • ANY drag / wheel / touch during a fly-in interrupts it — the visitor is
       never trapped in an animation.

   The camera is stored as orbit parameters (target, distance, yaw, pitch, fov)
   rather than a raw matrix, because that's what makes both orbiting AND smooth
   fly-ins easy: a fly-in is just an eased interpolation of these five numbers.

   AUTHORING HELPER
   Call  __logPose()  in the browser console to print the current framing as a
   ready-to-paste Pose. This is how you author initialPose and hero-point poses
   in demos.ts. (Registered on window in main.ts.)
   ========================================================================== */

import { Entity, Vec3, math } from 'playcanvas';
import { logTag } from './brand';
import type { Pose, WalkConfig } from './demos';
import { WalkConstraint } from './walk';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Shortest signed angular delta (degrees) so a fly-in never spins the long way.
const shortestAngle = (from: number, to: number): number =>
  ((((to - from) % 360) + 540) % 360) - 180;

// WASD + Q/E free-fly keys (authoring aid). Shift = move faster.
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
const TRACKED_KEYS = new Set([...MOVE_KEYS, 'ShiftLeft', 'ShiftRight']);
// Walk mode has no vertical freedom, so Q/E are not movement keys there — and
// must not COUNT as movement keys either, or pressing one would cancel a hero
// fly-in and then do nothing.
const WALK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);

/** Shift on either side = hurry. There is no touch equivalent on purpose: an
    analog stick already covers the whole speed range a body has. */
const fastKeys = (k: Set<string>): boolean => k.has('ShiftLeft') || k.has('ShiftRight');

// Walk-mode defaults; a demo's WalkConfig overrides any of them.
const DEFAULT_WALK = {
  speed: 1.25,        // m/s — an unhurried indoor walk
  runMultiplier: 2,   // Shift: brisk, deliberately not a sprint
  accel: 0.11,        // seconds; the ramp that reads as a body rather than a cursor
  settle: 1.1,        // seconds to ease from the opening shot onto the plane
};
// How fast the eye plane re-asserts itself, seconds. Normally this corrects
// nothing (no input moves the eye off the plane); it exists for the one case
// that can — a return-home fly-in interrupted mid-descent — which a hard clamp
// would turn into a jolt. Arrival snaps exactly below WALK_PIN_EPS.
const WALK_PIN_TAU = 0.12;
const WALK_PIN_EPS = 1e-3;

// How fast the hero framing lift fades in and out, seconds. Slow enough to read
// as the camera composing rather than twitching, fast enough to be finished well
// inside the 1.6s fly-in that triggers it.
const HERO_LIFT_TAU = 0.35;

// Default auto-orbit feel (per-hero overrides can replace any of these).
const DEFAULT_ORBIT = { speed: 7.5, ease: 6, amplitude: 30, yawLimit: 60 };

/* Thresholds below which a change in the camera does not count as motion, used
   only by the movedThisFrame signal that drives on-demand rendering. Sized to
   clear float residue rather than to be perceptually just-noticeable — see the
   long note on movedThisFrame for the ulp arithmetic. 1e-4 world units is
   0.03 mm at Bluedio's 3 units per metre; 1e-3 degrees is far under a pixel of
   yaw at any resolution this viewer will ever render. */
const MOVE_EPS = 1e-4;
const ANGLE_EPS = 1e-3;

/**
 * A WalkConfig with defaults resolved. `look` stays nullable because free look
 * is the default the brief asks for; `region` is dropped, because the camera
 * holds the compiled WalkConstraint rather than the raw polygon.
 */
type WalkState = Omit<Required<WalkConfig>, 'look' | 'region'> & {
  look: { down: number; up: number } | null;
};

interface OrbitState {
  target: Vec3;
  distance: number;
  yaw: number;   // degrees, around world +Y
  pitch: number; // degrees, clamped away from the poles
  fov: number;   // vertical degrees
}

export class OrbitFlyCamera {
  private cam: Entity;
  private canvas: HTMLCanvasElement;

  private s: OrbitState = {
    target: new Vec3(),
    distance: 4,
    yaw: 0,
    pitch: 10,
    fov: 55,
  };

  // Fly-in animation state.
  private flying = false;
  private flyT = 0;
  private flyDuration = 1;
  private flyFrom!: OrbitState;
  private flyGoal!: OrbitState;
  private flyYawDelta = 0;
  private onArrive?: () => void;

  // Aspect compensation. Pose fov values are VERTICAL degrees, authored in a
  // window of this aspect (width / height, set per demo from demos.ts). When
  // the live canvas is NARROWER than this (e.g. the 16:9 windows becoming 4:3
  // on mobile), the same vertical fov crops the sides of the authored framing.
  // apply() widens the effective vertical fov so the HORIZONTAL coverage stays
  // what was authored. Wider-than-reference viewports are left alone (extra
  // side coverage is harmless). s.fov itself is never mutated, so __logPose()
  // and authored poses stay in the reference space.
  private refAspect = 16 / 9;
  /* Vertical-degree CEILING on that compensation, and the number that decides
     whether a portrait phone reads as a room or as a fisheye.

     Preserving horizontal coverage is right for a MILD aspect change: 16:9 ->
     4:3 takes Bluedio's authored fov 42 to 54, which nobody notices. It is
     pathological for PORTRAIT. Full-bleed on a 375x812 phone is aspect 0.46,
     and holding the authored 68.6° horizontal there costs a VERTICAL fov of
     112°: floor and ceiling swallow the frame, verticals bow, and the gear you
     came to look at is a smudge in the middle. The old 115 ceiling never bound,
     so 112° was the shipped mobile behaviour.

     80° is the compromise, and being a ceiling it binds only once the viewport
     is roughly square or taller — every landscape window is untouched:

       16:9  (1.778)  ->  v 42, h 68.6    unchanged (at reference)
       4:3   (1.333)  ->  v 54, h 68.6    unchanged (ceiling not reached)
       9:16  (0.5625) ->  v 80, h 50.6    was v 101, h 68.6
       375x812 (0.46) ->  v 80, h 42.4    was v 112, h 68.6

     Horizontal coverage is what gets given up, and on a phone that is the right
     thing to give up: the look stick turns your head in a fraction of a second,
     whereas nothing recovers a frame that is already distorted. Retune live with
     __maxFov(n); __maxFov(115) restores the old behaviour exactly. */
  private maxEffectiveFov = 80;

  // Tuning.
  private rotSpeed = 0.28;   // deg per pixel
  private zoomSpeed = 0.0016;
  // No free-mode distance clamp any more: free rotation is eye-centred and the
  // free-mode wheel translates instead of shrinking the orbit radius, so
  // `distance` is fixed outside hero mode (hero mode has its own band).
  private pitchLimit = 88;   // degrees

  // Hero close-up mode: gentle auto-orbit around the subject + view constraints
  // so the visitor can look around a piece of gear but not wander off it.
  private heroMode = false;
  private heroSpin = false;      // true = continuous full 360° turntable (no sway, no yaw clamp)
  private heroStill = false;     // true = no auto motion at all (mode 'none')
  private heroMinDistance = 0.5;
  private heroMaxDistance = 6;
  private heroPitchMin = -35;
  private heroPitchMax = 85;
  private heroCenterYaw = 0;      // the hero's front-facing yaw (from its pose)
  // Yaw bounds are stored as an explicit RANGE relative to heroCenterYaw, not a
  // ± half-width, because the useful arc is often not centred on where the
  // fly-in lands: a hero backed against a wall needs an arc that simply
  // excludes the wall. heroYaw* bounds manual dragging; sway* is the narrower
  // idle-motion window inside it.
  private heroYawMin = -60;
  private heroYawMax = 60;
  private swayMin = -30;
  private swayMax = 30;
  private autoOrbitDir = 1;        // current sway direction (+1 / -1)
  private autoOrbitSpeed = 7.5;  // degrees/second at mid-swing (eases at the ends)
  private autoOrbitEase = 6;     // degrees near each end over which speed eases down
  private autoOrbitDelay = 1500; // ms of no input before auto-orbit (re)starts
  private lastInteract = 0;      // performance.now() of the last user input

  /* ---- Hero framing lift -------------------------------------------------
     Fraction of the FRAME HEIGHT by which a close-up's subject is raised above
     centre, so a card sitting across the bottom of the frame cannot cover the
     very object it describes. 0 disables it entirely, which is the desktop
     setting — main.ts installs a value only for the mobile card layout.

     `liftNow` is the eased 0..1 follower, not a duplicate of the setting: the
     lift has to fade IN as a close-up is entered and OUT as it is left, or the
     aim would snap the instant heroMode flipped and every fly-in would start
     with a jolt. Eased in both directions by one exponential, which also means
     interrupting a fly-in mid-fade cannot leave it stranded. */
  private heroFrameLift = 0;
  private liftNow = 0;
  private aimTmp = new Vec3(); // scratch for the lifted look-at point

  /* ---- Walk mode ---------------------------------------------------------
     A fixed standing eye height, held as an INVARIANT rather than as a rule
     every input has to remember: the camera is stored as orbit params, so
     "the eye is at height H" is just  target.y = H - distance * sin(pitch),
     re-solved after anything moves. Mouselook, WASD, wheel and pan therefore
     all inherit the constraint for free, and so does whatever gets added next.

     Mouselook needed no change at all: free rotation is already eye-centred
     (it holds the eye and re-derives the pivot), so turning your head has never
     moved you. What DID need changing is everything that translates — see
     handleWalk(), zoom() and pan().
     --------------------------------------------------------------------- */
  private walk: WalkState | null = null; // this demo's config, resolved, or null
  private walkSuppressed = false;  // ?author, or __walk(0)
  private walkEnabled = false;     // config present AND not suppressed
  private walkY = 0;               // world y of the eye plane
  private walkSettled = false;     // true once the opening-shot descent is done
  private walkSettling = false;    // true while it is running
  private settleT = 0;
  private settleFromY = 0;
  // The descent also walks the visitor IN, because an opening shot authored for
  // its framing is usually outside the region (Bluedio's is 2.4 m clear of it).
  // Held as a total delta plus the fraction already paid, not as an absolute
  // target, so it composes with the visitor walking during the same descent.
  private settleDX = 0;
  private settleDZ = 0;
  private settlePaid = 0;
  private walkVel = new Vec3();    // horizontal velocity, world units/sec
  private region: WalkConstraint | null = null; // compiled walkable region
  private moveTmp = { x: 0, z: 0 };             // scratch — walking allocates nothing

  // Pointer bookkeeping (supports mouse drag + touch orbit/pinch/pan).
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;

  /* ---- Analog touch sticks (joystick.ts) ---------------------------------
     Both axes are held in SCREEN space — x right, y down — so they are the same
     quantity a drag already produces, and the look stick can go through the very
     same applyLook() a drag does. Anything the mouse path clamps (hero yaw arcs,
     the walk region, the eye plane) is therefore inherited rather than reimplemented.

     Magnitude is meaningful: unlike a key, a stick can be half-pressed, and a
     half-pressed stick walks at half speed. Kept as plain objects rather than
     Vec3 because they are written every pointermove and read every frame. */
  private moveAxis = { x: 0, y: 0 }; // left stick — strafe / advance
  private lookAxis = { x: 0, y: 0 }; // right stick — yaw / pitch
  /* Degrees per second at FULL deflection.

     Was 105, which read as "much too sensitive" on a real phone — a full sweep
     of the room in barely three seconds, and impossible to stop on a hero dot.
     75 is a 29% cut, the deep end of the 25-30% Will asked for. The estimate 105
     came from was that a stick should match a drag's throughput; that was the
     wrong target, because a drag ENDS when the finger lifts whereas a stick
     keeps turning, so the same rate that feels brisk for 60px of drag feels
     uncontrollable held for a second.

     Tune from the phone with ?look=N, or __lookRate(n) in a console. The expo
     curve in update() is a separate lever and shapes the small deflections; this
     number only sets the top speed. */
  private lookRate = 75;

  // WASD/Q-E free-fly (authoring aid): translates the orbit target through the
  // scene so you can fly up to a piece of gear before capturing its pose.
  private pressedKeys = new Set<string>();
  private flySpeed = 0.9; // fraction of moveReference travelled per second
  // Movement speed is keyed to the demo's AUTHORED framing distance, captured
  // once, not to the live orbit distance. Keying it to the live distance meant
  // zooming in throttled WASD to a crawl; keying it to a hard constant would
  // feel wrong in scenes of different scale. This keeps "normal speed" normal
  // at every zoom level while still adapting per scene.
  private moveReference = 4;

  // Callback so the UI can react when the visitor takes over (e.g. show "Exit").
  onUserInteract?: () => void;

  constructor(cameraEntity: Entity, canvas: HTMLCanvasElement) {
    this.cam = cameraEntity;
    this.canvas = canvas;
    this.attachInput();
    this.apply();
    console.info(
      logTag() + ' camera — drag: orbit · right-drag / Shift+wheel: pan · wheel: zoom · ' +
        'WASD + Q/E: fly (Shift = faster) · run __logPose() to capture a pose',
    );
  }

  /** Set the aspect the current demo's poses were authored at (see refAspect). */
  setReferenceAspect(aspect: number): void {
    this.refAspect = aspect > 0 ? aspect : 16 / 9;
    this.apply();
  }

  /**
   * How far a hero close-up lifts its subject above centre, as a fraction of the
   * frame height. 0 turns it off.
   *
   * WHY IT EXISTS: on a phone the hero card is centred across the bottom third,
   * and a hero whose copy runs long grows the card to its 46% cap — which puts
   * the card's top edge at ~47% of the frame, i.e. across dead centre, exactly
   * where the fly-in parks the object. The card then hides the thing it is
   * describing.
   *
   * Implemented as a look-at offset rather than by moving the pose, so authored
   * hero poses stay the single source of truth for where the camera stands; see
   * apply(). Clamped at 0.45 because beyond that the subject leaves the frame
   * through the top. Tune from the phone with ?lift=N or __heroLift(n).
   */
  setHeroFrameLift(fraction: number): number {
    const f = Number(fraction);
    this.heroFrameLift = Number.isFinite(f) ? math.clamp(f, 0, 0.45) : 0;
    // Turning it off should read as off immediately, not fade out over a third
    // of a second — this is a tuning control, not part of the experience.
    if (this.heroFrameLift === 0) this.liftNow = 0;
    this.apply();
    return this.heroFrameLift;
  }

  /** Look-stick top speed, degrees/second at full deflection. Returns it. */
  setLookRate(degPerSec: number): number {
    const v = Number(degPerSec);
    if (Number.isFinite(v) && v > 0) this.lookRate = v;
    return this.lookRate;
  }

  /** Retune the portrait fov ceiling live (see maxEffectiveFov). Returns it. */
  setMaxFov(deg: number): number {
    const v = Number(deg);
    if (Number.isFinite(v) && v > 20) this.maxEffectiveFov = v;
    this.apply();
    return this.maxEffectiveFov;
  }

  /** The fov actually being rendered, and the authored one it came from. */
  get fovDebug(): { authored: number; effective: number; aspect: number; ceiling: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      authored: Math.round(this.s.fov * 10) / 10,
      effective: Math.round(this.effectiveFov(this.s.fov) * 10) / 10,
      aspect: h ? Math.round((w / h) * 1000) / 1000 : 0,
      ceiling: this.maxEffectiveFov,
    };
  }

  /** True when this demo is height-locked AND walk mode is not suppressed. */
  get walkActive(): boolean {
    return this.walkEnabled;
  }

  /* ---- Analog touch sticks ----------------------------------------------
     joystick.ts owns the widgets and the gesture; the camera owns what they
     MEAN. Both take a screen-space vector already clamped to the unit disc.
     --------------------------------------------------------------------- */

  /**
   * Left stick: translate. x right, y DOWN — so pushing the stick away from the
   * visitor (negative y) walks forward, which is what handleWalk() negates.
   *
   * Deflecting from rest counts as taking control, exactly like the first WASD
   * keypress: it cancels an in-progress fly-in so the visitor is never fighting
   * an animation for the stick.
   */
  setMoveAxis(x: number, y: number): void {
    const wasIdle = this.moveAxis.x === 0 && this.moveAxis.y === 0;
    this.moveAxis.x = x;
    this.moveAxis.y = y;
    if (wasIdle && (x !== 0 || y !== 0)) this.interrupt();
  }

  /** Right stick: look. Integrated per frame in update(), not here. */
  setLookAxis(x: number, y: number): void {
    const wasIdle = this.lookAxis.x === 0 && this.lookAxis.y === 0;
    this.lookAxis.x = x;
    this.lookAxis.y = y;
    if (wasIdle && (x !== 0 || y !== 0)) this.interrupt();
  }

  /**
   * Drop both sticks to rest. Called whenever the pads are taken away rather
   * than released — entering a hero close-up, leaving the scene — because a pad
   * that is hidden mid-push would otherwise leave its last vector installed and
   * the visitor would walk into a wall for the rest of the session.
   */
  releaseSticks(): void {
    this.moveAxis.x = 0;
    this.moveAxis.y = 0;
    this.lookAxis.x = 0;
    this.lookAxis.y = 0;
  }

  /** Re-apply the camera (call after the canvas resizes or is reparented, so
      the aspect-compensated fov tracks the new viewport shape). */
  refresh(): void {
    this.apply();
  }

  /**
   * Install this demo's walk configuration, or null for the legacy free-fly.
   * Call on every scene load — passing null is what keeps the three older demos
   * behaving exactly as they did before walk mode existed.
   */
  setWalk(cfg: WalkConfig | null): void {
    if (!cfg) {
      this.walk = null;
      this.region = null;
    } else {
      const { region, look, ...rest } = cfg;
      this.walk = {
        speed: DEFAULT_WALK.speed,
        runMultiplier: DEFAULT_WALK.runMultiplier,
        accel: DEFAULT_WALK.accel,
        settle: DEFAULT_WALK.settle,
        ...rest,
        look: look ?? null, // null = free look, the documented default
      };
      // Compiled once per scene load — the polygon is converted to metres in
      // there and never again. A demo may declare walk with NO region while its
      // envelope is still being derived; movement is then height-locked but
      // unbounded, which is the right state for authoring a new scan.
      this.region = region ? new WalkConstraint(region, cfg.unitsPerMetre) : null;
    }
    this.refreshWalkState();
    this.armSettle();
    if (this.walkEnabled) {
      console.info(
        `${logTag()} walk mode — eye height ${this.walk!.eyeHeight} m (world y ${this.walkY.toFixed(2)}) · ` +
          'WASD to walk, Shift to hurry · no vertical freedom · wheel scrolls the page · ' +
          '__eyeHeight(m) to retune, __walk(0) for the free fly',
      );
    }
  }

  /**
   * Master on/off for walk mode, independent of whether a demo configures it.
   * Off in ?author, because you cannot author a hero pose 2.4 m up from a body
   * that cannot leave the floor. `__walk(1)` turns it back on mid-session.
   */
  setWalkEnabled(on: boolean): void {
    if (this.walkSuppressed === !on) return;
    this.walkSuppressed = !on;
    this.refreshWalkState();
    // Re-arm rather than snap: switching walk on from a free-fly framing should
    // ease you down on the next step, exactly like arriving in a scene does.
    this.armSettle();
  }

  /**
   * Retune the eye height live, in metres above the scene floor — the whole
   * point of the walk numbers being three separate fields. Eases, never snaps.
   * Returns the value actually applied (null if this demo has no walk config).
   */
  setEyeHeight(metres: number): number | null {
    if (!this.walk) return null;
    this.walk.eyeHeight = metres;
    this.recomputeWalkPlane();
    return metres;
  }

  /**
   * Where the visitor stands relative to the boundary — for the brief's §8
   * checks. `backstops` should stay 0 in normal play; if it climbs every frame
   * the falloff is mistuned.
   */
  get walkDebug(): {
    distance: number; inside: boolean; falloff: number; backstops: number; eyeHeight: number | null;
  } | null {
    if (!this.region) return null;
    const eye = this.eyePosition();
    const d = this.region.distanceAt(eye.x, eye.z);
    return {
      distance: Math.round(d * 1000) / 1000,
      inside: d >= 0,
      falloff: this.region.falloffAtWorld(eye.x, eye.z),
      backstops: this.region.backstops,
      eyeHeight: this.eyeHeightMetres,
    };
  }

  /** Eye height in metres above the scene floor, or null on a non-walk demo. */
  get eyeHeightMetres(): number | null {
    if (!this.walk) return null;
    return (this.eyePosition().y - this.walk.floorY) / this.walk.unitsPerMetre;
  }

  /** Snap instantly to a pose (used when a new demo loads). */
  setPose(pose: Pose): void {
    this.flying = false;
    this.heroMode = false;
    this.heroSpin = false;
    this.s = this.stateFromPose(pose);
    this.moveReference = this.s.distance;
    // A scene whose opening shot was authored above the walk plane starts there
    // and STAYS there: the descent is armed, not performed, so the establishing
    // frame survives until the visitor actually takes a step.
    this.armSettle();
    this.apply();
  }

  /**
   * Fly to a hero pose, then enter constrained close-up mode.
   * opts.mode: 'sway' (default) pendulum around the front, or 'spin' for a
   *            continuous full 360° turntable (used for central fixtures).
   * opts.direction: initial sway / spin direction (+1 default, -1 to invert).
   */
  flyToHero(
    pose: Pose,
    duration = 1.6,
    opts?: {
      mode?: 'sway' | 'spin' | 'none';
      direction?: number;
      pivot?: [number, number, number];
      speed?: number;
      ease?: number;
      amplitude?: number;
      yawLimit?: number;
      arc?: [number, number];
    },
    onArrive?: () => void,
  ): void {
    // If a pivot is given (e.g. the dot's anchor), orbit around THAT point: keep
    // the authored camera position but aim/orbit at the pivot for fuller coverage.
    const framePose: Pose = opts?.pivot
      ? { position: pose.position, target: opts.pivot, fov: pose.fov }
      : pose;
    const goal = this.stateFromPose(framePose);
    // Zoom band: allow a bit closer, but not far enough to lose the subject.
    this.heroMinDistance = Math.max(goal.distance * 0.4, 0.2);
    this.heroMaxDistance = goal.distance * 1.8;
    this.heroCenterYaw = goal.yaw; // sway + orbit limits are measured from here
    this.heroSpin = opts?.mode === 'spin';
    this.heroStill = opts?.mode === 'none';
    this.autoOrbitDir = opts?.direction === -1 ? -1 : 1;
    // Per-hero auto-orbit feel (falls back to defaults).
    this.autoOrbitSpeed = opts?.speed ?? DEFAULT_ORBIT.speed;
    this.autoOrbitEase = opts?.ease ?? DEFAULT_ORBIT.ease;
    // Arc model. `arc` is the authoritative yaw range for this hero, in degrees
    // relative to the landing yaw, and may be asymmetric. Without it, fall back
    // to the symmetric ±yawLimit shorthand. Both are recomputed on EVERY fly-in,
    // not only when overridden, or one tight hero would leak its arc onto the
    // next hero visited.
    const lim = opts?.yawLimit ?? DEFAULT_ORBIT.yawLimit;
    const raw = opts?.arc ?? [-lim, lim];
    const lo = Math.min(raw[0], raw[1]);
    const hi = Math.max(raw[0], raw[1]);
    this.heroYawMin = lo;
    this.heroYawMax = hi;
    // Idle sway is a quarter of the arc wide by default, keeping resting motion
    // subtler than what dragging allows — the split the rig always had. For the
    // default ±60 arc that lands on exactly ±30, identical to the amplitude it
    // replaces. An explicit `amplitude` overrides the width.
    const half =
      opts?.amplitude !== undefined
        ? Math.min(opts.amplitude, (hi - lo) / 2)
        : (hi - lo) / 4;
    // The window is centred on the LANDING yaw (offset 0), not on the middle of
    // the arc, so the authored framing is always part of the idle motion. An
    // earlier version centred it on the arc, which on a one-sided arc such as
    // [0, 40] produced a window of [10, 30] that excluded the landing point: the
    // camera ran full-speed from 0 to 10, then pendulumed 10<->30 and never came
    // back — reading as two separate arcs. When the window would fall outside the
    // arc, SHIFT it in rather than shrinking it, so it keeps its intended width.
    let sLo = -half;
    let sHi = half;
    if (sLo < lo) { sHi += lo - sLo; sLo = lo; }
    if (sHi > hi) { sLo -= sHi - hi; sHi = hi; }
    this.swayMin = Math.max(sLo, lo);
    this.swayMax = Math.min(sHi, hi);
    // A close-up requested mid-descent COMPLETES the descent rather than
    // freezing it: the visitor asked to be somewhere else, and marking it
    // settled is what makes flyTo() land them back on the plane on exit.
    // Freezing it instead would resume the lerp later from a stale start height.
    if (this.walkSettling) {
      this.walkSettling = false;
      this.walkSettled = true;
    }
    this.heroMode = true;
    this.lastInteract = performance.now();
    // NOTE onArrive is dropped by interrupt() if the visitor drags mid-flight, so
    // callers that must run either way should also hook onUserInteract.
    this.flyTo(framePose, duration, onArrive);
  }

  /** Leave close-up mode: restore free orbit / pan / zoom / fly. */
  exitHero(): void {
    this.heroMode = false;
    this.heroSpin = false;
  }

  /**
   * Auto-frame a scene from its bounding sphere when no pose is authored.
   * Mirrors the SuperSplat starter's framing: a 3/4 view backed off far enough
   * to fit the whole scene in view.
   */
  frameBounds(center: Vec3, radius: number, fov = 60): void {
    this.flying = false;
    this.heroMode = false;
    const dir = new Vec3(2, 1, 2).normalize();
    const yaw = Math.atan2(dir.x, dir.z) * DEG;
    const pitch = Math.asin(dir.y) * DEG;
    const distance = Math.max(radius, 0.5) / Math.sin((fov * RAD) / 2);
    this.s = { target: center.clone(), distance, yaw, pitch, fov };
    this.moveReference = distance;
    this.armSettle();
    this.apply();
  }

  /** Eased fly to a pose; control returns to the visitor on arrival. */
  flyTo(pose: Pose, duration = 1.4, onArrive?: () => void): void {
    this.flyFrom = this.cloneState(this.s);
    this.flyGoal = this.stateFromPose(pose);
    // Once the visitor is walking, a fly-in that is NOT a hero close-up — in
    // practice the "exit close-up" return home, whose pose was authored well
    // above head height — has to LAND on the walk plane, or the pin would jerk
    // the eye down the instant the animation ended. flyToHero() sets heroMode
    // before calling through here, so authored hero framings keep their own
    // deliberate heights.
    if (this.walkEnabled && this.walkSettled && !this.heroMode) {
      const look = this.walk!.look;
      if (look) this.flyGoal.pitch = math.clamp(this.flyGoal.pitch, -look.up, look.down);
      this.flyGoal.target.y =
        this.walkY - this.flyGoal.distance * Math.sin(this.flyGoal.pitch * RAD);
      // ...and land INSIDE the region. Brief §6: on hero exit, ease to the
      // nearest point where d >= 0. The home pose is the opening shot, which is
      // authored for its framing and sits outside — flying back to it verbatim
      // would drop the visitor out of bounds and let the backstop shove them.
      if (this.region) {
        const g = this.flyGoal;
        const cp = Math.cos(g.pitch * RAD);
        const ex = g.target.x + g.distance * cp * Math.sin(g.yaw * RAD);
        const ez = g.target.z + g.distance * cp * Math.cos(g.yaw * RAD);
        this.region.nearestInside(ex, ez, this.moveTmp);
        g.target.x += this.moveTmp.x - ex;
        g.target.z += this.moveTmp.z - ez;
      }
    }
    this.flyYawDelta = shortestAngle(this.flyFrom.yaw, this.flyGoal.yaw);
    this.flyDuration = duration;
    this.flyT = 0;
    this.flying = true;
    this.onArrive = onArrive;
  }

  get isFlying(): boolean {
    return this.flying;
  }

  /* ---- Motion signal, for on-demand rendering ----------------------------
     `movedThisFrame` answers the ONE question a render-on-demand loop has, and
     it is computed here rather than in main.ts because every source of camera
     motion already funnels through `this.s`: fly-ins, walk input, mouselook,
     the walk-plane settle, the eye pin and auto-orbit all write the same five
     numbers. Comparing a snapshot of those numbers is therefore exhaustive by
     construction — a motion source added later cannot forget to report itself,
     which an enumerate-the-flags approach absolutely would.

     THE EPSILONS ARE THE WHOLE POINT, and TEMPLATE.md -> "Still on the table"
     names the trap they exist to dodge: pinEyeTo()'s `drift !== 0` branch fires
     on roughly a quarter of genuinely idle frames from a 1-ulp float residue,
     so an exact `!==` here would report motion forever and the page would never
     idle. At this scene's coordinate magnitudes (~5 world units) one ulp is
     ~5e-7, so 1e-4 clears the residue by ~200x while staying far below anything
     an eye could see: 1e-4 world units is 0.03 mm at 3 units per metre.

     `liftNow` is compared separately because the hero framing lift moves the
     LOOK-AT point without touching `s` — it is the one motion the five-number
     comparison cannot see. (The docked phone layout sets the lift to 0, so
     there it is permanently cold; it still matters on the full-bleed page.)
     -------------------------------------------------------------------- */
  private moved = true; // start true so the very first frame always draws
  private prevTarget = new Vec3();
  private prevYaw = NaN;
  private prevPitch = NaN;
  private prevDistance = NaN;
  private prevFov = NaN;
  private prevLift = NaN;

  /**
   * Did the camera actually change this frame? Valid once `update()` has run.
   * A render-on-demand loop draws when this is true and sleeps when it is not.
   */
  get movedThisFrame(): boolean {
    return this.moved;
  }

  /**
   * Force the next frame to count as moved.
   *
   * For everything OUTSIDE the camera that still needs a redraw: a splat
   * landing, a depth sort completing on the worker, the canvas being resized.
   * Without this an on-demand loop would show a stale picture after any of
   * them, because none of the three touches the camera.
   */
  wake(): void {
    this.moved = true;
  }

  /** Called every frame from the render loop. */
  update(dt: number): void {
    /* Snapshot the camera BEFORE anything below can write it — see the
       movedThisFrame note above for why this is a snapshot rather than a set
       of flags. */
    this.prevTarget.copy(this.s.target);
    this.prevYaw = this.s.yaw;
    this.prevPitch = this.s.pitch;
    this.prevDistance = this.s.distance;
    this.prevFov = this.s.fov;
    this.prevLift = this.liftNow;

    /* Ease the hero framing lift toward wherever heroMode now is. Runs FIRST so
       everything below writes the camera with this frame's value, and applies
       once itself for the case where nothing else this frame would — a visitor
       sitting still in a close-up before auto-orbit wakes up. */
    if (this.heroFrameLift > 0) {
      const want = this.heroMode ? 1 : 0;
      if (Math.abs(want - this.liftNow) > 1e-4) {
        this.liftNow += (want - this.liftNow) * (1 - Math.exp(-dt / HERO_LIFT_TAU));
        this.apply();
      } else if (this.liftNow !== want) {
        this.liftNow = want; // settle exactly, so `lift > 1e-4` can go fully cold
        this.apply();
      }
    }

    if (this.flying) {
      this.flyT += dt / this.flyDuration;
      const k = easeInOutCubic(Math.min(this.flyT, 1));
      const a = this.flyFrom;
      const b = this.flyGoal;
      this.s.target.lerp(a.target, b.target, k);
      this.s.distance = math.lerp(a.distance, b.distance, k);
      this.s.yaw = a.yaw + this.flyYawDelta * k;
      this.s.pitch = math.lerp(a.pitch, b.pitch, k);
      this.s.fov = math.lerp(a.fov, b.fov, k);
      if (this.flyT >= 1) {
        this.flying = false;
        this.onArrive?.();
        this.onArrive = undefined;
      }
      this.apply();
    }
    /* Right stick: look. A held stick is a rate, so unlike a drag it has to be
       integrated per frame rather than applied per event.

       Guarded on !flying so a stick still held as a fly-in begins cannot fight
       the animation. setLookAxis() already interrupts a fly-in on the first
       deflection, so this only catches the reverse order.

       EXPO: the deflection is shaped |v|-weighted before becoming a rate, which
       buys fine control near centre without lowering the top speed. Linear at a
       rate high enough to cross the room feels twitchy at the small deflections
       used to settle onto a hero dot; the 0.35 floor keeps a gentle push from
       feeling dead altogether. */
    if (!this.flying && (this.lookAxis.x !== 0 || this.lookAxis.y !== 0)) {
      const expo = (v: number): number => v * (0.35 + 0.65 * Math.abs(v));
      const r = this.lookRate * dt;
      // Signs match a DRAG exactly (see orbit()): stick right turns right, and
      // stick away-from-you looks up.
      this.applyLook(-expo(this.lookAxis.x) * r, expo(this.lookAxis.y) * r);
    }

    // Free-fly / walk runs every frame (and interrupts any in-progress fly-in).
    this.handleMovement(dt);

    // Walk mode: advance the opening-shot descent, then re-assert the eye plane.
    // Both run AFTER movement (so they see this frame's translation) and are
    // skipped during a fly-in, which lands on the plane by itself — see flyTo().
    if (this.walkEnabled && !this.heroMode && !this.flying) {
      if (this.walkSettling) {
        this.settleT += dt / Math.max(this.walk!.settle, 1e-3);
        const k = easeInOutCubic(Math.min(this.settleT, 1));
        this.pinEyeTo(math.lerp(this.settleFromY, this.walkY, k));
        // Pay the horizontal correction as a DELTA, so a visitor already
        // walking during the descent keeps their own motion on top of it.
        const step = k - this.settlePaid;
        this.settlePaid = k;
        this.s.target.x += this.settleDX * step;
        this.s.target.z += this.settleDZ * step;
        if (this.settleT >= 1) {
          this.walkSettling = false;
          this.walkSettled = true;
        }
        this.apply();
      } else if (this.walkSettled) {
        const drift = this.eyePosition().y - this.walkY;
        if (Math.abs(drift) > WALK_PIN_EPS) {
          // Ease, don't clamp. See WALK_PIN_TAU.
          this.pinEyeTo(this.walkY + drift * Math.exp(-dt / WALK_PIN_TAU));
          this.apply();
        } else if (drift !== 0) {
          this.pinEyeTo(this.walkY);
          this.apply();
        }
      }
    }

    // Subtle auto-orbit in hero close-up mode, once the fly-in has landed and the
    // visitor has been idle for a moment. Any interaction pauses it (see lastInteract).
    if (
      this.heroMode &&
      !this.heroStill && // mode 'none': hold the framing — no auto motion
      !this.flying &&
      this.pressedKeys.size === 0 &&
      performance.now() - this.lastInteract > this.autoOrbitDelay
    ) {
      if (this.heroSpin) {
        // Continuous full turntable — constant speed, no reversal, no clamp.
        this.s.yaw += this.autoOrbitDir * this.autoOrbitSpeed * dt;
      } else {
        // Pendulum sway: reverse direction at ±amplitude from the front-facing yaw.
        const offset = shortestAngle(this.heroCenterYaw, this.s.yaw); // yaw − center, in [-180,180]
        if (offset >= this.swayMax) this.autoOrbitDir = -1;
        else if (offset <= this.swayMin) this.autoOrbitDir = 1;
        // Ease speed down toward each turning point (smoothstep) so the reversal is
        // gentle, not abrupt — never fully stalls (15% floor) so it always comes back.
        // A one-sided arc lands the camera OUTSIDE its sway window (offset 0 with a
        // window of, say, [-37.5, -12.5]); run at full speed until it arrives
        // rather than crawling in at the 15% floor.
        const inside = offset >= this.swayMin && offset <= this.swayMax;
        const distToEdge = inside
          ? Math.min(offset - this.swayMin, this.swayMax - offset)
          : Infinity;
        const t = math.clamp(distToEdge / this.autoOrbitEase, 0, 1);
        const factor = 0.15 + 0.85 * (t * t * (3 - 2 * t));
        this.s.yaw += this.autoOrbitDir * this.autoOrbitSpeed * factor * dt;
      }
      this.apply();
    }

    /* Did any of that actually move the camera? `moved` may already be true
       from an out-of-band wake() this frame, so OR rather than assign — a
       scene landing must not be cancelled by a still camera. */
    this.moved =
      this.moved ||
      Math.abs(this.s.target.x - this.prevTarget.x) > MOVE_EPS ||
      Math.abs(this.s.target.y - this.prevTarget.y) > MOVE_EPS ||
      Math.abs(this.s.target.z - this.prevTarget.z) > MOVE_EPS ||
      Math.abs(this.s.distance - this.prevDistance) > MOVE_EPS ||
      Math.abs(this.s.yaw - this.prevYaw) > ANGLE_EPS ||
      Math.abs(this.s.pitch - this.prevPitch) > ANGLE_EPS ||
      Math.abs(this.s.fov - this.prevFov) > ANGLE_EPS ||
      Math.abs(this.liftNow - this.prevLift) > 1e-5;
  }

  /**
   * Clear the moved flag. Called by the render loop AFTER it has decided
   * whether to draw, so the next frame starts from a clean slate.
   *
   * Separate from reading `movedThisFrame` because the flag is set from two
   * places — this update() and any out-of-band wake() — and a getter with a
   * side effect would make the order of those two reads matter.
   */
  clearMoved(): void {
    this.moved = false;
  }

  /** Current framing as a Pose (no side effects). */
  getPose(): Pose {
    const p = this.cam.getPosition();
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      position: [round(p.x), round(p.y), round(p.z)],
      target: [round(this.s.target.x), round(this.s.target.y), round(this.s.target.z)],
      fov: Math.round(this.s.fov),
    };
  }

  /** Prints the current framing as a pasteable Pose (authoring workflow). */
  logPose(): Pose {
    const pose = this.getPose();
    // eslint-disable-next-line no-console
    console.log(
      '%c[pose] %c' + JSON.stringify(pose),
      'color:#c6a15b;font-weight:bold',
      'color:inherit',
    );
    return pose;
  }

  /**
   * Prints the current look-point (the orbit target) as a pasteable `anchor`
   * for a hero point's dot. The target projects to screen-center, so whatever is
   * under the authoring crosshair is what gets captured. Paste into a hero's
   * `anchor: [x, y, z]` field to place the dot independently of the fly-in pose.
   */
  logAnchor(): [number, number, number] {
    const t = this.s.target;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const anchor: [number, number, number] = [round(t.x), round(t.y), round(t.z)];
    // eslint-disable-next-line no-console
    console.log(
      '%c[anchor] %c' + JSON.stringify(anchor),
      'color:#c6a15b;font-weight:bold',
      'color:inherit',
    );
    return anchor;
  }

  // ---- internals ---------------------------------------------------------

  private stateFromPose(pose: Pose): OrbitState {
    const target = new Vec3(pose.target[0], pose.target[1], pose.target[2]);
    const pos = new Vec3(pose.position[0], pose.position[1], pose.position[2]);
    const dir = new Vec3().sub2(pos, target);
    const distance = Math.max(dir.length(), 1e-4);
    const pitch = Math.asin(math.clamp(dir.y / distance, -1, 1)) * DEG;
    const yaw = Math.atan2(dir.x, dir.z) * DEG;
    return { target, distance, yaw, pitch, fov: pose.fov };
  }

  /** Unit vector pointing from the pivot toward the eye (matches apply()). */
  private dirFrom(yaw: number, pitch: number): Vec3 {
    const cp = Math.cos(pitch * RAD);
    return new Vec3(cp * Math.sin(yaw * RAD), Math.sin(pitch * RAD), cp * Math.cos(yaw * RAD));
  }

  /** Current eye position, derived from orbit params rather than the entity. */
  private eyePosition(): Vec3 {
    return this.dirFrom(this.s.yaw, this.s.pitch).mulScalar(this.s.distance).add(this.s.target);
  }

  private cloneState(s: OrbitState): OrbitState {
    return { target: s.target.clone(), distance: s.distance, yaw: s.yaw, pitch: s.pitch, fov: s.fov };
  }

  /** Write orbit params → camera transform + fov. */
  private apply(): void {
    const { target, distance, yaw, pitch, fov } = this.s;
    const sy = Math.sin(yaw * RAD);
    const cy = Math.cos(yaw * RAD);
    const cp = Math.cos(pitch * RAD);
    const sp = Math.sin(pitch * RAD);
    this.cam.setPosition(
      target.x + distance * cp * sy,
      target.y + distance * sp,
      target.z + distance * cp * cy,
    );
    const vFov = this.effectiveFov(fov);
    /* HERO FRAMING LIFT — aim BELOW the pivot so the subject rides high in the
       frame, clear of the card. See setHeroFrameLift() for why, and note what
       this deliberately does NOT touch: the eye position above is already
       written, and `distance`/`yaw`/`pitch`/`target` are untouched. Only the
       LOOK-AT POINT moves. So the authored camera position is preserved exactly,
       the orbit pivot stays on the object (auto-orbit still circles the gear,
       not a point under it), and getPose()/logPose() keep reporting the authored
       framing rather than a lifted one.

       Geometry: with the aim point `shift` below the pivot along the camera's
       local up, the pivot lands at NDC y = (shift/distance) / tan(vFov/2). Set
       that to 2f and the pivot sits exactly f of the FULL frame height above
       centre — hence the 2. Local up is dirFrom(yaw, pitch + 90), which reduces
       to (-sp·sy, cp, -sp·cy); aim = target − up·shift. */
    const lift = this.heroFrameLift * this.liftNow;
    if (lift > 1e-4) {
      const shift = 2 * lift * distance * Math.tan((vFov * RAD) / 2);
      this.aimTmp.set(
        target.x + sp * sy * shift,
        target.y - cp * shift,
        target.z + sp * cy * shift,
      );
      this.cam.lookAt(this.aimTmp);
    } else {
      this.cam.lookAt(target);
    }
    if (this.cam.camera) this.cam.camera.fov = vFov;
  }

  /**
   * Aspect-compensated vertical fov. On viewports narrower than the reference
   * aspect, widen the vertical fov so the horizontal field matches what the
   * authored (reference-aspect) framing showed:
   *   hFov/2 = atan(tan(vFov/2) · refAspect)      — authored horizontal half-angle
   *   vFov'/2 = atan(tan(hFov/2) / liveAspect)    — vertical that reproduces it
   */
  private effectiveFov(fov: number): number {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return fov;
    const aspect = w / h;
    if (aspect >= this.refAspect) return fov;
    const hHalf = Math.atan(Math.tan((fov * RAD) / 2) * this.refAspect);
    return Math.min(2 * Math.atan(Math.tan(hHalf) / aspect) * DEG, this.maxEffectiveFov);
  }

  private interrupt(): void {
    this.lastInteract = performance.now(); // pauses auto-orbit
    if (this.flying) {
      this.flying = false;
      this.onArrive = undefined;
    }
    this.onUserInteract?.();
  }

  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    c.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Leave browser/DevTools shortcuts (Ctrl/Cmd/Alt combos) alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!TRACKED_KEYS.has(e.code)) return;
    // First movement key cancels an in-progress fly-in so you take control.
    const moveKeys = this.walkEnabled ? WALK_KEYS : MOVE_KEYS;
    if (moveKeys.has(e.code) && !this.pressedKeys.has(e.code)) this.interrupt();
    this.pressedKeys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressedKeys.delete(e.code);
  };

  // Dropping focus (Alt-Tab, clicking the console) must not leave keys "stuck".
  private onWindowBlur = (): void => {
    this.pressedKeys.clear();
  };

  /** WASD + Q/E free-fly: translate the orbit target along the view basis. */
  private handleMovement(dt: number): void {
    if (this.heroMode) {
      this.walkVel.set(0, 0, 0); // don't carry momentum into (or out of) a close-up
      return; // fly is disabled in close-up so you can't leave the subject
    }
    if (this.walkEnabled) {
      this.handleWalk(dt);
      return;
    }
    const k = this.pressedKeys;
    const stick = this.moveAxis.x !== 0 || this.moveAxis.y !== 0;
    if (k.size === 0 && !stick) return;
    const strafe = this.axisOr(this.moveAxis.x, (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0));
    const advance = this.axisOr(-this.moveAxis.y, (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0));
    const lift = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (strafe === 0 && advance === 0 && lift === 0) return;

    const yaw = this.s.yaw * RAD;
    const pitch = this.s.pitch * RAD;
    const cp = Math.cos(pitch);
    // forward = camera → target (the view direction, including pitch);
    // right = horizontal; lift uses world-up so Q/E always go straight down/up.
    const forward = new Vec3(-Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp);
    const right = new Vec3(Math.cos(yaw), 0, -Math.sin(yaw));
    const worldUp = new Vec3(0, 1, 0);

    const speed = Math.max(this.moveReference, 0.5) * this.flySpeed * (fastKeys(k) ? 3 : 1) * dt;

    const move = new Vec3();
    move.add(forward.mulScalar(advance));
    move.add(right.mulScalar(strafe));
    move.add(worldUp.mulScalar(lift));
    if (move.lengthSq() > 0) {
      this.lastInteract = performance.now();
      /* Normalize the DIRECTION, then scale by the intended magnitude — rather
         than clamping the summed vector, which is what handleWalk() can safely
         do. The difference is that this basis is not orthonormal: `worldUp` is
         not perpendicular to a pitched `forward`, so |forward + worldUp| is
         2 - 2·sin(pitch) under the root, i.e. 1.41 when level but only 0.77 at
         45° down. Clamping would therefore have quietly slowed W+E to 77% while
         pitched, changing a keyboard behaviour this pass has no business
         touching. Scaling by min(1, hypot(axes)) leaves every key combination
         bit-identical to the old normalize() and still honours a half-pushed
         stick. */
      const mag = Math.min(1, Math.hypot(strafe, advance, lift));
      move.normalize().mulScalar(speed * mag);
      this.s.target.add(move);
      this.apply();
    }
  }

  /**
   * Reconcile one analog axis with its keyboard equivalent: whichever is pushed
   * FURTHER wins. Keys are all-or-nothing, a stick is fractional, and taking the
   * larger magnitude means neither input can cancel or halve the other when both
   * happen to be live — which on a touch laptop is a real case, not a hypothetical.
   */
  private axisOr(analog: number, keys: number): number {
    return Math.abs(analog) > Math.abs(keys) ? analog : keys;
  }

  /**
   * WASD at a fixed eye height. Three things separate this from the free fly:
   *
   *   • `forward` is HORIZONTAL. The free fly folds pitch into it, so walking
   *     while looking down would sink you through the floor — the single most
   *     obvious way a "walk" gives itself away as a flying camera.
   *   • Q/E do nothing. No vertical freedom, no crouch, no head bob: that is
   *     both the coverage-honest choice (the capture rings bracket one height)
   *     and the comfortable one on a mouse-look walk.
   *   • Speed is ABSOLUTE — metres/second through the scene's own unitsPerMetre,
   *     not a fraction of the authored framing distance — and it ramps in and
   *     out. Instant on/off is the biggest tell that you are driving a camera
   *     rather than walking, and the old free-fly speed worked out to ~2.7 m/s,
   *     which is a jog.
   *
   * The LEFT TOUCH STICK enters here too, and deliberately by the same door: it
   * is just a fractional WASD. Everything downstream of `wish` — the accel ramp,
   * the region constraint, the applied-velocity writeback — is shared, so a
   * finger and a keyboard cannot end up with different physics.
   */
  private handleWalk(dt: number): void {
    const w = this.walk!;
    const k = this.pressedKeys;
    const stick = this.moveAxis.x !== 0 || this.moveAxis.y !== 0;
    if (k.size === 0 && !stick && this.walkVel.lengthSq() === 0) return;

    const strafe = this.axisOr(this.moveAxis.x, (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0));
    const advance = this.axisOr(-this.moveAxis.y, (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0));

    // Desired velocity for this frame, world units/sec, on the horizontal plane.
    const wish = new Vec3();
    if (strafe !== 0 || advance !== 0) {
      const yaw = this.s.yaw * RAD;
      // forward = eye -> pivot with the pitch term dropped; right is already
      // horizontal. Both are taken UNSCALED by cos(pitch) so a near-vertical
      // look cannot collapse them to a degenerate normalize().
      wish.add(new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)).mulScalar(advance));
      wish.add(new Vec3(Math.cos(yaw), 0, -Math.sin(yaw)).mulScalar(strafe));
      // CLAMP, don't normalize. Normalizing is right for keys — it stops W+D
      // being 1.41x faster than W — but it would also drag a gently-pushed stick
      // back out to full walking speed, throwing away the one thing an analog
      // control has over a key. A stick at 40% walks at 40%; a diagonal key pair
      // still cannot exceed 1.
      const len = wish.length();
      if (len > 1) wish.mulScalar(1 / len);
      wish.mulScalar(w.speed * (fastKeys(k) ? w.runMultiplier : 1) * w.unitsPerMetre);
      this.lastInteract = performance.now();
      this.beginSettle();
    }

    // Exponential approach to the wish velocity: frame-rate independent, and it
    // gives the same shaped ramp starting and stopping.
    this.walkVel.lerp(this.walkVel, wish, 1 - Math.exp(-dt / Math.max(w.accel, 1e-3)));

    // Under a millimetre per second the ramp is asymptotic noise — stop, so a
    // released key really does mean standing still.
    if (this.walkVel.length() < 0.001 * w.unitsPerMetre) {
      this.walkVel.set(0, 0, 0);
      return;
    }
    // Only x and z. target.y is owned by the eye-plane pin in update().
    const applied = this.walkTranslate(this.walkVel.x * dt, this.walkVel.z * dt);
    // Write the ALLOWED motion back as velocity. Without this, momentum keeps
    // accumulating into a wall the visitor is already being damped against, and
    // the moment they turn away it releases as a lurch.
    if (dt > 0) {
      this.walkVel.x = applied.x / dt;
      this.walkVel.z = applied.z / dt;
    }
    this.apply();
  }

  /* ---- walk-mode internals ---------------------------------------------- */

  private recomputeWalkPlane(): void {
    if (this.walk) this.walkY = this.walk.floorY + this.walk.eyeHeight * this.walk.unitsPerMetre;
  }

  private refreshWalkState(): void {
    this.walkEnabled = this.walk !== null && !this.walkSuppressed;
    this.recomputeWalkPlane();
  }

  /** Arm (but do not perform) the descent onto the walk plane. */
  private armSettle(): void {
    this.walkSettling = false;
    this.settleT = 0;
    this.walkVel.set(0, 0, 0);
    // settle: 0 means "start standing" — no establishing shot to preserve.
    this.walkSettled = this.walkEnabled && this.walk!.settle <= 0;
    if (this.walkSettled) this.pinEyeTo(this.walkY);
  }

  /**
   * First translation input of a scene: begin easing down onto the plane, and
   * in from wherever the opening shot was authored. Both together read as
   * arriving in the room; the height alone would read as sinking through it.
   */
  private beginSettle(): void {
    if (!this.walkEnabled || this.walkSettled || this.walkSettling) return;
    const eye = this.eyePosition();
    this.settleFromY = eye.y;
    this.settleDX = 0;
    this.settleDZ = 0;
    this.settlePaid = 0;
    if (this.region) {
      this.region.nearestInside(eye.x, eye.z, this.moveTmp);
      this.settleDX = this.moveTmp.x - eye.x;
      this.settleDZ = this.moveTmp.z - eye.z;
    }
    const drop = Math.abs(this.settleFromY - this.walkY);
    const slide = Math.hypot(this.settleDX, this.settleDZ);
    if (drop < WALK_PIN_EPS && slide < WALK_PIN_EPS) {
      this.walkSettled = true; // already standing inside; nothing to do
      return;
    }
    this.settleT = 0;
    this.walkSettling = true;
  }

  /**
   * The ONE place a walking camera translates. Every walk input — WASD, wheel,
   * two-finger drag — comes through here, so the region constraint is applied
   * once rather than three times, and a fourth input added later inherits it.
   *
   * The constraint is evaluated at the EYE, not at the orbit pivot: the pivot
   * sits ~3 m ahead and spends most of its life inside furniture. Translating
   * the pivot moves the eye by exactly the same delta (the view direction does
   * not change), so solving at the eye and applying to the pivot is equivalent.
   *
   * Returns the delta actually applied, in world units.
   */
  private walkTranslate(dx: number, dz: number): { x: number; z: number } {
    const m = this.moveTmp;
    m.x = dx;
    m.z = dz;
    if (this.region) {
      const eye = this.eyePosition();
      this.region.applyMove(eye.x, eye.z, m);
    }
    this.s.target.x += m.x;
    this.s.target.z += m.z;
    return m;
  }

  /**
   * Put the eye on world height `eyeY` by solving the pivot for it. This is the
   * whole constraint: eye.y = target.y + distance * sin(pitch), so
   * target.y = eyeY - distance * sin(pitch). Nothing else needs to know.
   */
  private pinEyeTo(eyeY: number): void {
    this.s.target.y = eyeY - this.s.distance * Math.sin(this.s.pitch * RAD);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.interrupt();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastPinchDist = 0;
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      // Two fingers → pinch to zoom + drag to pan.
      const pts = [...this.pointers.values()];
      const pd = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.lastPinchDist > 0) {
        const delta = this.lastPinchDist - pd;
        this.zoom(delta * 2.2);
      }
      this.lastPinchDist = pd;
      this.pan(dx * 0.5, dy * 0.5);
      return;
    }

    // Right / middle mouse button → pan; otherwise orbit.
    if (e.pointerType === 'mouse' && (e.buttons & 2 || e.buttons & 4)) {
      this.pan(dx, dy);
    } else {
      this.orbit(dx, dy);
    }
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    // WALK MODE: the wheel does nothing. It used to dolly the eye along the
    // floor, and at a fixed standing height that reads as a phantom step the
    // visitor never took — the body slides without the walk. There is no honest
    // wheel gesture for a walking camera: zooming would be a lens change rather
    // than a move, and dollying IS the move.
    //
    // The event is left unprevented, but NOT so the page can scroll — ui.ts
    // freezes the page for as long as a scene is live. It is unprevented so that
    // a nested scroller under the cursor still works, which in practice means a
    // hero card whose copy overflows.
    //
    // Deliberately NOT skipped in hero close-up, where the wheel still zooms the
    // subject: that is a modal inspection state with its own card up, and the
    // gesture is a real affordance there.
    if (this.walkEnabled && !this.heroMode) return;
    this.interrupt();
    this.zoom(e.deltaY);
    e.preventDefault();
  };

  /**
   * A drag, in pixels. Converted straight to degrees and handed to applyLook, so
   * the mouse/finger path and the look stick cannot drift apart: whatever the
   * drag clamps, the stick clamps too.
   */
  private orbit(dx: number, dy: number): void {
    this.applyLook(-dx * this.rotSpeed, dy * this.rotSpeed);
  }

  /**
   * Turn the view by explicit DEGREE deltas. dYaw adds to yaw; dPitch adds to
   * pitch, and POSITIVE pitch looks DOWN (see the sign note below), so a gesture
   * that should look down passes a positive dPitch.
   */
  private applyLook(dYaw: number, dPitch: number): void {
    this.lastInteract = performance.now();
    // FREE mode is mouselook: the eye stays put and the view swings around it,
    // like turning your head. Orbiting a pivot metres ahead instead swung the
    // whole body on an arc, which is why navigation felt unmoored until you
    // zoomed all the way in (which collapsed the pivot onto the eye). Capture
    // the eye now, move the angles, then re-derive the pivot to put it back.
    // HERO mode deliberately keeps true orbit — there the pivot is the point.
    const eye = this.heroMode ? null : this.eyePosition();
    this.s.yaw += dYaw;
    // In close-up (sway mode only), clamp yaw to a front arc so the camera can't
    // swing behind the piece. Spin mode (central fixture) allows full 360°.
    if (this.heroMode && !this.heroSpin) {
      const offset = math.clamp(
        shortestAngle(this.heroCenterYaw, this.s.yaw),
        this.heroYawMin,
        this.heroYawMax,
      );
      this.s.yaw = this.heroCenterYaw + offset;
    }
    // Pitch sign, since three sets of limits now depend on it: POSITIVE pitch
    // puts the eye ABOVE the pivot, i.e. looking DOWN.
    let min = -this.pitchLimit;
    let max = this.pitchLimit;
    if (this.heroMode) {
      // Tighter pitch limits in close-up keep a flattering view of the subject.
      min = this.heroPitchMin;
      max = this.heroPitchMax;
    } else if (this.walkEnabled && this.walk!.look) {
      // Only if this demo asks for it. WALK_IMPLEMENTATION_BRIEF §5 is explicit:
      // look is FREE. "Being unable to turn your head reads as claustrophobic;
      // being unable to walk somewhere reads as furniture." Soft limits are for
      // the case where ceiling coverage proves thin in review — not a default.
      min = -this.walk!.look.up;
      max = this.walk!.look.down;
    }
    this.s.pitch = math.clamp(this.s.pitch + dPitch, min, max);
    if (eye) {
      // target = eye - distance * dir, so the eye lands exactly where it was.
      this.s.target.copy(eye).sub(this.dirFrom(this.s.yaw, this.s.pitch).mulScalar(this.s.distance));
    }
    this.apply();
  }

  private zoom(delta: number): void {
    this.lastInteract = performance.now();
    if (!this.heroMode) {
      // Now that free rotation is eye-centred, `distance` no longer sets the
      // rotation feel — it only scales pan. So the wheel dollies BOTH eye and
      // pivot along the view axis, holding distance constant. That keeps pan
      // feel stable and means the wheel never bottoms out against minDistance
      // the way shrinking the orbit radius did.
      const step = delta * this.zoomSpeed * Math.max(this.moveReference, 0.5);
      if (this.walkEnabled) {
        // Reachable only from a two-finger PINCH now — the wheel returns early
        // in walk mode (see onWheel). Kept because pinch is the only forward
        // gesture touch has until a real mobile control exists. A step forward
        // or back, not a dolly: the free-fly version travels the PITCHED view
        // axis, which at a fixed eye height would push you through the floor.
        // Signs match: dirFrom points pivot -> eye, so a positive step backs away.
        const yaw = this.s.yaw * RAD;
        this.beginSettle();
        this.walkTranslate(Math.sin(yaw) * step, Math.cos(yaw) * step);
      } else {
        this.s.target.add(this.dirFrom(this.s.yaw, this.s.pitch).mulScalar(step));
      }
      this.apply();
      return;
    }
    this.s.distance = math.clamp(
      this.s.distance * (1 + delta * this.zoomSpeed),
      this.heroMinDistance,
      this.heroMaxDistance,
    );
    this.apply();
  }

  private pan(dx: number, dy: number): void {
    // Panning is disabled in close-up — it would slide the pivot off the subject.
    if (this.heroMode) return;
    this.lastInteract = performance.now();
    // Move the target across the camera's local right/up plane, scaled by distance
    // so panning feels consistent whether you're close or far.
    const scale = (this.s.distance * this.s.fov * RAD) / this.canvas.clientHeight;
    if (this.walkEnabled) {
      // Same gesture and same signs, moved onto the horizontal plane: the
      // free-fly version slides along the camera's UP vector, which is the main
      // way a touch visitor would otherwise leave the eye plane (two-finger drag
      // is the only translation gesture touch has today — a real mobile control
      // is its own pass). Dragging the floor DOWN walks you forward, matching
      // how floor texture flows on screen when you actually take a step.
      const yaw = this.s.yaw * RAD;
      this.beginSettle();
      const move = new Vec3(Math.cos(yaw), 0, -Math.sin(yaw)).mulScalar(-dx * scale);
      move.add(new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)).mulScalar(dy * scale));
      this.walkTranslate(move.x, move.z);
      this.apply();
      return;
    }
    const right = this.cam.right.clone().mulScalar(-dx * scale);
    const up = this.cam.up.clone().mulScalar(dy * scale);
    this.s.target.add(right).add(up);
    this.apply();
  }
}
