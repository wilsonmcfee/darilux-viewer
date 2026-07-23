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
import type { Pose } from './demos';

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

// Default auto-orbit feel (per-hero overrides can replace any of these).
const DEFAULT_ORBIT = { speed: 7.5, ease: 6, amplitude: 30 };

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

  // Tuning.
  private rotSpeed = 0.28;   // deg per pixel
  private zoomSpeed = 0.0016;
  private minDistance = 0.3;
  private maxDistance = 200;
  private pitchLimit = 88;   // degrees

  // Hero close-up mode: gentle auto-orbit around the subject + view constraints
  // so the visitor can look around a piece of gear but not wander off it.
  private heroMode = false;
  private heroSpin = false;      // true = continuous full 360° turntable (no sway, no yaw clamp)
  private heroMinDistance = 0.5;
  private heroMaxDistance = 6;
  private heroPitchMin = -35;
  private heroPitchMax = 85;
  private heroCenterYaw = 0;      // the hero's front-facing yaw (from its pose)
  private heroYawLimit = 60;      // manual orbit is clamped to ± this around center
  private autoOrbitAmplitude = 30; // sway ± this around center (< heroYawLimit)
  private autoOrbitDir = 1;        // current sway direction (+1 / -1)
  private autoOrbitSpeed = 7.5;  // degrees/second at mid-swing (eases at the ends)
  private autoOrbitEase = 6;     // degrees near each end over which speed eases down
  private autoOrbitDelay = 1500; // ms of no input before auto-orbit (re)starts
  private lastInteract = 0;      // performance.now() of the last user input

  // Pointer bookkeeping (supports mouse drag + touch orbit/pinch/pan).
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;

  // WASD/Q-E free-fly (authoring aid): translates the orbit target through the
  // scene so you can fly up to a piece of gear before capturing its pose.
  private pressedKeys = new Set<string>();
  private flySpeed = 0.9; // fraction of the current orbit distance travelled per second

  // Callback so the UI can react when the visitor takes over (e.g. show "Exit").
  onUserInteract?: () => void;

  constructor(cameraEntity: Entity, canvas: HTMLCanvasElement) {
    this.cam = cameraEntity;
    this.canvas = canvas;
    this.attachInput();
    this.apply();
    console.info(
      '[morisot] camera — drag: orbit · right-drag / Shift+wheel: pan · wheel: zoom · ' +
        'WASD + Q/E: fly (Shift = faster) · run __logPose() to capture a pose',
    );
  }

  /** Snap instantly to a pose (used when a new demo loads). */
  setPose(pose: Pose): void {
    this.flying = false;
    this.heroMode = false;
    this.heroSpin = false;
    this.s = this.stateFromPose(pose);
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
      mode?: 'sway' | 'spin';
      direction?: number;
      pivot?: [number, number, number];
      speed?: number;
      ease?: number;
      amplitude?: number;
    },
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
    this.autoOrbitDir = opts?.direction === -1 ? -1 : 1;
    // Per-hero auto-orbit feel (falls back to defaults).
    this.autoOrbitSpeed = opts?.speed ?? DEFAULT_ORBIT.speed;
    this.autoOrbitEase = opts?.ease ?? DEFAULT_ORBIT.ease;
    this.autoOrbitAmplitude = opts?.amplitude ?? DEFAULT_ORBIT.amplitude;
    this.heroMode = true;
    this.lastInteract = performance.now();
    this.flyTo(framePose, duration);
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
    this.apply();
  }

  /** Eased fly to a pose; control returns to the visitor on arrival. */
  flyTo(pose: Pose, duration = 1.4, onArrive?: () => void): void {
    this.flyFrom = this.cloneState(this.s);
    this.flyGoal = this.stateFromPose(pose);
    this.flyYawDelta = shortestAngle(this.flyFrom.yaw, this.flyGoal.yaw);
    this.flyDuration = duration;
    this.flyT = 0;
    this.flying = true;
    this.onArrive = onArrive;
  }

  get isFlying(): boolean {
    return this.flying;
  }

  /** Called every frame from the render loop. */
  update(dt: number): void {
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
    // Free-fly runs every frame (and interrupts any in-progress fly-in).
    this.handleMovement(dt);

    // Subtle auto-orbit in hero close-up mode, once the fly-in has landed and the
    // visitor has been idle for a moment. Any interaction pauses it (see lastInteract).
    if (
      this.heroMode &&
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
        if (offset >= this.autoOrbitAmplitude) this.autoOrbitDir = -1;
        else if (offset <= -this.autoOrbitAmplitude) this.autoOrbitDir = 1;
        // Ease speed down toward each turning point (smoothstep) so the reversal is
        // gentle, not abrupt — never fully stalls (15% floor) so it always comes back.
        const distToEdge = this.autoOrbitAmplitude - Math.abs(offset);
        const t = math.clamp(distToEdge / this.autoOrbitEase, 0, 1);
        const factor = 0.15 + 0.85 * (t * t * (3 - 2 * t));
        this.s.yaw += this.autoOrbitDir * this.autoOrbitSpeed * factor * dt;
      }
      this.apply();
    }
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

  private cloneState(s: OrbitState): OrbitState {
    return { target: s.target.clone(), distance: s.distance, yaw: s.yaw, pitch: s.pitch, fov: s.fov };
  }

  /** Write orbit params → camera transform + fov. */
  private apply(): void {
    const { target, distance, yaw, pitch, fov } = this.s;
    const cp = Math.cos(pitch * RAD);
    const x = target.x + distance * cp * Math.sin(yaw * RAD);
    const y = target.y + distance * Math.sin(pitch * RAD);
    const z = target.z + distance * cp * Math.cos(yaw * RAD);
    this.cam.setPosition(x, y, z);
    this.cam.lookAt(target);
    if (this.cam.camera) this.cam.camera.fov = fov;
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
    if (MOVE_KEYS.has(e.code) && !this.pressedKeys.has(e.code)) this.interrupt();
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
    if (this.heroMode) return; // fly is disabled in close-up so you can't leave the subject
    const k = this.pressedKeys;
    if (k.size === 0) return;
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const advance = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
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

    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    // Speed scales with orbit distance so it feels consistent at any zoom.
    const speed = Math.max(this.s.distance, 0.5) * this.flySpeed * (fast ? 3 : 1) * dt;

    const move = new Vec3();
    move.add(forward.mulScalar(advance));
    move.add(right.mulScalar(strafe));
    move.add(worldUp.mulScalar(lift));
    if (move.lengthSq() > 0) {
      this.lastInteract = performance.now();
      move.normalize().mulScalar(speed);
      this.s.target.add(move);
      this.apply();
    }
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
    this.interrupt();
    this.zoom(e.deltaY);
    e.preventDefault();
  };

  private orbit(dx: number, dy: number): void {
    this.lastInteract = performance.now();
    this.s.yaw -= dx * this.rotSpeed;
    // In close-up (sway mode only), clamp yaw to a front arc so the camera can't
    // swing behind the piece. Spin mode (central fixture) allows full 360°.
    if (this.heroMode && !this.heroSpin) {
      const offset = math.clamp(
        shortestAngle(this.heroCenterYaw, this.s.yaw),
        -this.heroYawLimit,
        this.heroYawLimit,
      );
      this.s.yaw = this.heroCenterYaw + offset;
    }
    // Tighter pitch limits in close-up keep a flattering view of the subject.
    const min = this.heroMode ? this.heroPitchMin : -this.pitchLimit;
    const max = this.heroMode ? this.heroPitchMax : this.pitchLimit;
    this.s.pitch = math.clamp(this.s.pitch + dy * this.rotSpeed, min, max);
    this.apply();
  }

  private zoom(delta: number): void {
    this.lastInteract = performance.now();
    // In close-up, clamp to a band around the subject; otherwise the full range.
    const lo = this.heroMode ? this.heroMinDistance : this.minDistance;
    const hi = this.heroMode ? this.heroMaxDistance : this.maxDistance;
    this.s.distance = math.clamp(this.s.distance * (1 + delta * this.zoomSpeed), lo, hi);
    this.apply();
  }

  private pan(dx: number, dy: number): void {
    // Panning is disabled in close-up — it would slide the pivot off the subject.
    if (this.heroMode) return;
    this.lastInteract = performance.now();
    // Move the target across the camera's local right/up plane, scaled by distance
    // so panning feels consistent whether you're close or far.
    const scale = (this.s.distance * this.s.fov * RAD) / this.canvas.clientHeight;
    const right = this.cam.right.clone().mulScalar(-dx * scale);
    const up = this.cam.up.clone().mulScalar(dy * scale);
    this.s.target.add(right).add(up);
    this.apply();
  }
}
