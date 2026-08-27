/* ============================================================================
   locomotion.ts — walk-mode movement: the eye plane, the settle, the region.
   ----------------------------------------------------------------------------
   Split out of camera.ts; the constraint field itself lives next door in
   walk.ts. A fixed standing eye height is held as an INVARIANT rather than as
   a rule every input has to remember: the camera is stored as orbit params, so
   "the eye is at height H" is just  target.y = H - distance * sin(pitch),
   re-solved after anything moves. Mouselook, WASD, wheel and pan therefore
   all inherit the constraint for free, and so does whatever gets added next.

   The camera owns the INPUTS (keys, sticks, gestures) and hands this module
   resolved axis values; this module owns what a walking body does with them.
   State is shared by reference through the host: state() returns the SAME
   OrbitState every other motion source writes (a function, not a captured
   object, because setPose() replaces the object), and apply()/touch() are the
   camera's own.
   ========================================================================== */

import { Vec3 } from 'playcanvas';
import { logTag } from '../core/brand';
import type { WalkConfig } from '../types';
import { WalkConstraint } from './walk';
import { RAD, easeInOutCubic, type OrbitState } from '../core/flyto';

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

/**
 * A WalkConfig with defaults resolved. `look` stays nullable because free look
 * is the default the brief asks for; `region` is dropped, because this module
 * holds the compiled WalkConstraint rather than the raw polygon.
 */
type WalkState = Omit<Required<WalkConfig>, 'look' | 'region'> & {
  look: { down: number; up: number } | null;
};

export interface WalkHost {
  /** The live orbit state — a function because setPose() replaces the object. */
  state(): OrbitState;
  /** Current eye position, derived from orbit params. */
  eye(): Vec3;
  /** Write orbit params → camera transform + fov. */
  apply(): void;
  /** Register user input (pauses auto-orbit, wakes on-demand rendering). */
  touch(): void;
}

export class WalkLocomotion {
  private walk: WalkState | null = null; // this demo's config, resolved, or null
  private suppressed = false;      // ?author, or __walk(0)
  /** True when this demo is height-locked AND walk mode is not suppressed. */
  enabled = false;
  /** World y of the eye plane (flyTo's landing block reads it). */
  walkY = 0;
  /** True once the opening-shot descent is done. */
  settled = false;
  private settling = false;        // true while the descent is running
  private settleT = 0;
  private settleFromY = 0;
  // The descent also walks the visitor IN, because an opening shot authored for
  // its framing is usually outside the region (Bluedio's is 2.4 m clear of it).
  // Held as a total delta plus the fraction already paid, not as an absolute
  // target, so it composes with the visitor walking during the same descent.
  private settleDX = 0;
  private settleDZ = 0;
  private settlePaid = 0;
  private vel = new Vec3();        // horizontal velocity, world units/sec
  private region: WalkConstraint | null = null; // compiled walkable region
  private moveTmp = { x: 0, z: 0 };             // scratch — walking allocates nothing

  constructor(private host: WalkHost) {}

  /** This demo's optional look clamp (null = free look, the documented default). */
  get look(): { down: number; up: number } | null {
    return this.walk?.look ?? null;
  }

  /** The compiled region, for flyTo's land-inside clamp. */
  get regionRef(): WalkConstraint | null {
    return this.region;
  }

  /**
   * Install this demo's walk configuration, or null for the legacy free-fly.
   * Call on every scene load — passing null is what keeps the three older demos
   * behaving exactly as they did before walk mode existed.
   */
  setConfig(cfg: WalkConfig | null): void {
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
    this.refreshState();
    this.armSettle();
    if (this.enabled) {
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
  setEnabled(on: boolean): void {
    if (this.suppressed === !on) return;
    this.suppressed = !on;
    this.refreshState();
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
    this.recomputePlane();
    return metres;
  }

  /**
   * Where the visitor stands relative to the boundary — for the brief's §8
   * checks. `backstops` should stay 0 in normal play; if it climbs every frame
   * the falloff is mistuned.
   */
  get debug(): {
    distance: number; inside: boolean; falloff: number; backstops: number; eyeHeight: number | null;
  } | null {
    if (!this.region) return null;
    const eye = this.host.eye();
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
    return (this.host.eye().y - this.walk.floorY) / this.walk.unitsPerMetre;
  }

  /** Zero the walk velocity (don't carry momentum into or out of a close-up). */
  haltVelocity(): void {
    this.vel.set(0, 0, 0);
  }

  /**
   * A close-up requested mid-descent COMPLETES the descent rather than
   * freezing it: the visitor asked to be somewhere else, and marking it
   * settled is what makes flyTo() land them back on the plane on exit.
   * Freezing it instead would resume the lerp later from a stale start height.
   */
  completeSettle(): void {
    if (this.settling) {
      this.settling = false;
      this.settled = true;
    }
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
   *
   * The camera resolves the axes (keys vs stick, whichever is pushed further)
   * and passes them here; `anyInput` is "a key is down or a stick is deflected".
   */
  move(dt: number, strafe: number, advance: number, anyInput: boolean, fast: boolean): void {
    const w = this.walk!;
    if (!anyInput && this.vel.lengthSq() === 0) return;

    // Desired velocity for this frame, world units/sec, on the horizontal plane.
    const wish = new Vec3();
    if (strafe !== 0 || advance !== 0) {
      const yaw = this.host.state().yaw * RAD;
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
      wish.mulScalar(w.speed * (fast ? w.runMultiplier : 1) * w.unitsPerMetre);
      this.host.touch();
      this.beginSettle();
    }

    // Exponential approach to the wish velocity: frame-rate independent, and it
    // gives the same shaped ramp starting and stopping.
    this.vel.lerp(this.vel, wish, 1 - Math.exp(-dt / Math.max(w.accel, 1e-3)));

    // Under a millimetre per second the ramp is asymptotic noise — stop, so a
    // released key really does mean standing still.
    if (this.vel.length() < 0.001 * w.unitsPerMetre) {
      this.vel.set(0, 0, 0);
      return;
    }
    // Only x and z. target.y is owned by the eye-plane pin in tick().
    const applied = this.translate(this.vel.x * dt, this.vel.z * dt);
    // Write the ALLOWED motion back as velocity. Without this, momentum keeps
    // accumulating into a wall the visitor is already being damped against, and
    // the moment they turn away it releases as a lurch.
    if (dt > 0) {
      this.vel.x = applied.x / dt;
      this.vel.z = applied.z / dt;
    }
    this.host.apply();
  }

  /**
   * Advance the opening-shot descent, then re-assert the eye plane. Runs every
   * frame AFTER movement (so it sees this frame's translation); the camera
   * skips it during a fly-in, which lands on the plane by itself — see flyTo().
   */
  tick(dt: number): void {
    if (this.settling) {
      this.settleT += dt / Math.max(this.walk!.settle, 1e-3);
      const k = easeInOutCubic(Math.min(this.settleT, 1));
      this.pinEyeTo(this.settleFromY + (this.walkY - this.settleFromY) * k);
      // Pay the horizontal correction as a DELTA, so a visitor already
      // walking during the descent keeps their own motion on top of it.
      const step = k - this.settlePaid;
      this.settlePaid = k;
      const s = this.host.state();
      s.target.x += this.settleDX * step;
      s.target.z += this.settleDZ * step;
      if (this.settleT >= 1) {
        this.settling = false;
        this.settled = true;
      }
      this.host.apply();
    } else if (this.settled) {
      const drift = this.host.eye().y - this.walkY;
      if (Math.abs(drift) > WALK_PIN_EPS) {
        // Ease, don't clamp. See WALK_PIN_TAU.
        this.pinEyeTo(this.walkY + drift * Math.exp(-dt / WALK_PIN_TAU));
        this.host.apply();
      } else if (drift !== 0) {
        this.pinEyeTo(this.walkY);
        this.host.apply();
      }
    }
  }

  /* ---- internals --------------------------------------------------------- */

  private recomputePlane(): void {
    if (this.walk) this.walkY = this.walk.floorY + this.walk.eyeHeight * this.walk.unitsPerMetre;
  }

  private refreshState(): void {
    this.enabled = this.walk !== null && !this.suppressed;
    this.recomputePlane();
  }

  /** Arm (but do not perform) the descent onto the walk plane. */
  armSettle(): void {
    this.settling = false;
    this.settleT = 0;
    this.vel.set(0, 0, 0);
    // settle: 0 means "start standing" — no establishing shot to preserve.
    this.settled = this.enabled && this.walk!.settle <= 0;
    if (this.settled) this.pinEyeTo(this.walkY);
  }

  /**
   * First translation input of a scene: begin easing down onto the plane, and
   * in from wherever the opening shot was authored. Both together read as
   * arriving in the room; the height alone would read as sinking through it.
   */
  beginSettle(): void {
    if (!this.enabled || this.settled || this.settling) return;
    const eye = this.host.eye();
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
      this.settled = true; // already standing inside; nothing to do
      return;
    }
    this.settleT = 0;
    this.settling = true;
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
  translate(dx: number, dz: number): { x: number; z: number } {
    const m = this.moveTmp;
    m.x = dx;
    m.z = dz;
    if (this.region) {
      const eye = this.host.eye();
      this.region.applyMove(eye.x, eye.z, m);
    }
    const s = this.host.state();
    s.target.x += m.x;
    s.target.z += m.z;
    return m;
  }

  /**
   * Put the eye on world height `eyeY` by solving the pivot for it. This is the
   * whole constraint: eye.y = target.y + distance * sin(pitch), so
   * target.y = eyeY - distance * sin(pitch). Nothing else needs to know.
   */
  private pinEyeTo(eyeY: number): void {
    const s = this.host.state();
    s.target.y = eyeY - s.distance * Math.sin(s.pitch * RAD);
  }
}
