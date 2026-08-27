/* ============================================================================
   flyto.ts — the eased fly-in, and the orbit-state vocabulary it animates.
   ----------------------------------------------------------------------------
   Split out of camera.ts. The camera is stored as orbit parameters (target,
   distance, yaw, pitch, fov) rather than a raw matrix, because that's what
   makes both orbiting AND smooth fly-ins easy: a fly-in is just an eased
   interpolation of these five numbers. This module owns that interpolation;
   camera.ts owns what the numbers mean and builds/adjusts the goal state
   (e.g. landing a walking visitor back on the eye plane) BEFORE start().

   The state object is shared BY REFERENCE with the camera — tick() writes the
   same OrbitState every other motion source writes, which is what keeps the
   camera's movedThisFrame snapshot exhaustive by construction.
   ========================================================================== */

import { Vec3, math } from 'playcanvas';
import type { Pose } from '../types';

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Shortest signed angular delta (degrees) so a fly-in never spins the long way.
export const shortestAngle = (from: number, to: number): number =>
  ((((to - from) % 360) + 540) % 360) - 180;

export interface OrbitState {
  target: Vec3;
  distance: number;
  yaw: number;   // degrees, around world +Y
  pitch: number; // degrees, clamped away from the poles
  fov: number;   // vertical degrees
}

export const cloneState = (s: OrbitState): OrbitState => ({
  target: s.target.clone(),
  distance: s.distance,
  yaw: s.yaw,
  pitch: s.pitch,
  fov: s.fov,
});

export const stateFromPose = (pose: Pose): OrbitState => {
  const target = new Vec3(pose.target[0], pose.target[1], pose.target[2]);
  const pos = new Vec3(pose.position[0], pose.position[1], pose.position[2]);
  const dir = new Vec3().sub2(pos, target);
  const distance = Math.max(dir.length(), 1e-4);
  const pitch = Math.asin(math.clamp(dir.y / distance, -1, 1)) * DEG;
  const yaw = Math.atan2(dir.x, dir.z) * DEG;
  return { target, distance, yaw, pitch, fov: pose.fov };
};

export class FlyAnimation {
  private flying = false;
  private t = 0;
  private duration = 1;
  private from!: OrbitState;
  private goal!: OrbitState;
  private yawDelta = 0;
  private onArrive?: () => void;

  get isFlying(): boolean {
    return this.flying;
  }

  /**
   * Begin an eased fly from `from` to `goal`. The caller finishes adjusting
   * `goal` (walk-plane landing, region clamp) before calling; the yaw delta is
   * taken here so the camera never spins the long way round.
   */
  start(from: OrbitState, goal: OrbitState, duration: number, onArrive?: () => void): void {
    this.from = from;
    this.goal = goal;
    this.yawDelta = shortestAngle(from.yaw, goal.yaw);
    this.duration = duration;
    this.t = 0;
    this.flying = true;
    this.onArrive = onArrive;
  }

  /**
   * Advance the animation, writing the interpolated framing into `s` and
   * calling `apply()` — exactly the write pattern the camera's own update had.
   * No-op when not flying.
   */
  tick(dt: number, s: OrbitState, apply: () => void): void {
    if (!this.flying) return;
    this.t += dt / this.duration;
    const k = easeInOutCubic(Math.min(this.t, 1));
    const a = this.from;
    const b = this.goal;
    s.target.lerp(a.target, b.target, k);
    s.distance = math.lerp(a.distance, b.distance, k);
    s.yaw = a.yaw + this.yawDelta * k;
    s.pitch = math.lerp(a.pitch, b.pitch, k);
    s.fov = math.lerp(a.fov, b.fov, k);
    if (this.t >= 1) {
      this.flying = false;
      this.onArrive?.();
      this.onArrive = undefined;
    }
    apply();
  }

  /**
   * Interrupt the animation. onArrive is DROPPED, exactly as before the split —
   * callers that must run either way also hook onUserInteract.
   */
  cancel(): void {
    this.flying = false;
    this.onArrive = undefined;
  }
}
