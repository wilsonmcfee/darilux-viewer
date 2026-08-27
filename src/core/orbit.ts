/* ============================================================================
   orbit.ts — the hero close-up state machine: arc limits and auto-orbit sway.
   ----------------------------------------------------------------------------
   Split out of camera.ts. A hero close-up constrains the view so the visitor
   can look around a piece of gear but not wander off it: a yaw arc measured
   from the landing yaw, a pitch band, a zoom band, and an idle sway (or full
   turntable spin) that starts once the visitor has been idle for a moment.

   This module owns the CONSTRAINTS and the sway; camera.ts still owns the
   heroMode flag, the idle timing, and every input path — the clamps here are
   called from the same places the inline code used to run.
   ========================================================================== */

import { math } from 'playcanvas';
import { shortestAngle, type OrbitState } from './flyto';

// Default auto-orbit feel (per-hero overrides can replace any of these).
const DEFAULT_ORBIT = { speed: 7.5, ease: 6, amplitude: 30, yawLimit: 60 };

export interface HeroOrbitOpts {
  mode?: 'sway' | 'spin' | 'none';
  direction?: number;
  speed?: number;
  ease?: number;
  amplitude?: number;
  yawLimit?: number;
  arc?: [number, number];
}

export class HeroOrbit {
  // Zoom band: allow a bit closer, but not far enough to lose the subject.
  minDistance = 0.5;
  maxDistance = 6;
  // Tighter pitch limits in close-up keep a flattering view of the subject.
  readonly pitchMin = -35;
  readonly pitchMax = 85;

  spin = false;  // true = continuous full 360° turntable (no sway, no yaw clamp)
  still = false; // true = no auto motion at all (mode 'none')

  private centerYaw = 0; // the hero's front-facing yaw (from its pose)
  // Yaw bounds are stored as an explicit RANGE relative to centerYaw, not a
  // ± half-width, because the useful arc is often not centred on where the
  // fly-in lands: a hero backed against a wall needs an arc that simply
  // excludes the wall. yawMin/Max bound manual dragging; sway* is the narrower
  // idle-motion window inside it.
  private yawMin = -60;
  private yawMax = 60;
  private swayMin = -30;
  private swayMax = 30;
  private dir = 1;       // current sway direction (+1 / -1)
  private speed = 7.5;   // degrees/second at mid-swing (eases at the ends)
  private ease = 6;      // degrees near each end over which speed eases down

  /** Configure for a hero, from its landing state and per-hero options. */
  configure(goal: OrbitState, opts?: HeroOrbitOpts): void {
    this.minDistance = Math.max(goal.distance * 0.4, 0.2);
    this.maxDistance = goal.distance * 1.8;
    this.centerYaw = goal.yaw; // sway + orbit limits are measured from here
    this.spin = opts?.mode === 'spin';
    this.still = opts?.mode === 'none';
    this.dir = opts?.direction === -1 ? -1 : 1;
    // Per-hero auto-orbit feel (falls back to defaults).
    this.speed = opts?.speed ?? DEFAULT_ORBIT.speed;
    this.ease = opts?.ease ?? DEFAULT_ORBIT.ease;
    // Arc model. `arc` is the authoritative yaw range for this hero, in degrees
    // relative to the landing yaw, and may be asymmetric. Without it, fall back
    // to the symmetric ±yawLimit shorthand. Both are recomputed on EVERY fly-in,
    // not only when overridden, or one tight hero would leak its arc onto the
    // next hero visited.
    const lim = opts?.yawLimit ?? DEFAULT_ORBIT.yawLimit;
    const raw = opts?.arc ?? ([-lim, lim] as [number, number]);
    const lo = Math.min(raw[0], raw[1]);
    const hi = Math.max(raw[0], raw[1]);
    this.yawMin = lo;
    this.yawMax = hi;
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
  }

  /** Drop the spin flag on exit (mode is re-configured on every fly-in). */
  reset(): void {
    this.spin = false;
  }

  /**
   * In close-up (sway mode only), clamp yaw to a front arc so the camera can't
   * swing behind the piece. Spin mode (central fixture) allows full 360° — the
   * caller guards on `spin`.
   */
  clampYaw(yaw: number): number {
    const offset = math.clamp(shortestAngle(this.centerYaw, yaw), this.yawMin, this.yawMax);
    return this.centerYaw + offset;
  }

  /**
   * Advance the idle motion by one frame. The caller has already decided the
   * visitor is idle (no flying, no keys, past the auto-orbit delay); mode
   * 'none' holds the framing — no auto motion.
   */
  tick(dt: number, s: OrbitState, apply: () => void): void {
    if (this.still) return;
    if (this.spin) {
      // Continuous full turntable — constant speed, no reversal, no clamp.
      s.yaw += this.dir * this.speed * dt;
    } else {
      // Pendulum sway: reverse direction at ±amplitude from the front-facing yaw.
      const offset = shortestAngle(this.centerYaw, s.yaw); // yaw − center, in [-180,180]
      if (offset >= this.swayMax) this.dir = -1;
      else if (offset <= this.swayMin) this.dir = 1;
      // Ease speed down toward each turning point (smoothstep) so the reversal is
      // gentle, not abrupt — never fully stalls (15% floor) so it always comes back.
      // A one-sided arc lands the camera OUTSIDE its sway window (offset 0 with a
      // window of, say, [-37.5, -12.5]); run at full speed until it arrives
      // rather than crawling in at the 15% floor.
      const inside = offset >= this.swayMin && offset <= this.swayMax;
      const distToEdge = inside
        ? Math.min(offset - this.swayMin, this.swayMax - offset)
        : Infinity;
      const t = math.clamp(distToEdge / this.ease, 0, 1);
      const factor = 0.15 + 0.85 * (t * t * (3 - 2 * t));
      s.yaw += this.dir * this.speed * factor * dt;
    }
    apply();
  }
}
