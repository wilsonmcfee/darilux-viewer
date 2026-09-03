/* ============================================================================
   adaptive.ts — the frame-time governor: render resolution follows the device.
   ----------------------------------------------------------------------------
   THE GOAL, IN ONE LINE

   A floor of 30 fps on every device, WebGL2 or WebGPU, bought with resolution.

   WHY RESOLUTION IS THE RIGHT CURRENCY

   The 2026-09-02 pass (TEMPLATE.md → "Profiled 2026-09-02") ended on the
   finding that the desktop fullscreen ceiling is FILL: splat cost is pixels
   times overdraw, and `?res=0.7` fixed the frame rate outright where no sort
   or bake knob had. The render budget in device.ts caps the pixel count from
   the monitor's side; this file closes the loop from the FRAME's side, because
   no fixed budget can know what a given GPU can carry. A viewer is usually a
   window on a page rather than fullscreen, so a device that needs 0.7 of its
   window renders 0.7 of a modest canvas — a softness far below the point where
   a splat scene stops reading as a photograph (device.ts has the arithmetic).

   HOW IT MEASURES

   It samples the gap between consecutive RENDERED frames (main.ts feeds it
   from `frameend`), which under requestAnimationFrame is true frame pacing: a
   GPU that cannot finish in one vsync shows up as a 33 ms gap, not as a
   longer callback. Frames the on-demand renderer chose not to draw produce no
   event and are not counted; a gap over 500 ms restarts the window, so a
   visitor who stops and starts is judged only on stretches of continuous
   motion — which is exactly when the frame rate is felt.

   HOW IT DECIDES — and the three asymmetries that keep it from oscillating

   1. DOWN IS FAST, UP IS SLOW. A step down needs 40 consecutive frames whose
      mean is more than 5% over the target; a step up needs 120 (doubling
      after every bounce, up to 960) whose mean is under 55% of it. Between
      those two bands — 18 to 35 ms at a 30 fps floor — it holds, which is
      the hysteresis. The 5% matters because rAF paces in whole vsyncs: a
      device that has landed exactly on the two-vsync 33.3 ms line IS at the
      floor, and without the margin floating-point noise read it as over and
      took a pointless extra step (seen in simulation). On a 60 Hz display a
      healthy device sits at 16.7 ms, inside the "up" band, so it climbs back
      to full resolution when it can.
   2. THE STEP IS PROPORTIONAL. Pixels scale with ratio², so if the mean is
      `m` and the target is `t`, the ratio that would land on target (if the
      frame is all fill) is `× sqrt(t / m)`. It aims 5% under the target, and
      the factor is clamped to [0.6, 0.9] per step: a badly over-budget device
      gets most of the way in one move rather than six, and a marginal one
      moves gently.
   3. IT CHECKS THAT THE STEP WORKED. Not every slow device is fill-bound: a
      WebGL2 phone whose worker sort is the ceiling will not speed up when the
      canvas shrinks, and blurring its picture for nothing is worse than
      leaving it alone. So after each step down, the next window's mean is
      compared with the one that triggered it; if the frame is still over the
      floor AND did not improve by at least 8%, the step is REVERTED and the
      governor pauses — 15 s the first time, doubling on every repeat to two
      minutes, so a device that is never going to respond is not resized every
      quarter minute for the rest of the session. A step that worked resets
      the backoff. The HUD's `res` reading going down and coming straight back
      is that rule firing, and it means the bottleneck is not pixels — read
      `sort` and `up`.

   Every change is followed by a cooldown (20 rendered frames AND 600 ms),
   because a canvas resize reallocates the swapchain and the first frames after
   it are hitchy for reasons that have nothing to do with the new size. The
   same cooldown runs after a window resize or rotation, and a scene load holds
   the governor for 60 rendered frames — streaming, the first bake and the
   first sort make the opening seconds slow on every device and none of that is
   information about the GPU.

   WHAT IT DOES NOT DO

   It never raises the ratio above what device.ts decided (the mobile cap, the
   render budget, `?perf`); it only scales that down, to a floor of 0.4 (16% of
   the pixels). `?res=N` is an absolute override and turns it off, so the honest
   A/B stays honest. `?adapt=0` turns it off; `?minfps=N` moves the floor.

   It also does not resize the canvas itself. onChange only reports; main.ts
   applies the change at the top of the NEXT update, before that frame renders.
   Resizing where the decision is made — on frameend, after the frame was
   drawn — clears the freshly drawn buffer and presents a black frame, which is
   what the first phone test saw as flicker.
   ========================================================================== */

/** Consecutive rendered frames whose mean must exceed the target to step down.
    40 rather than 24 after the first phone test: a burst of fast movement on a
    device whose ceiling is the sort, not fill, tripped a step every burst and
    each step (and its revert) is a visible change of sharpness. 40 frames is
    1.3 s of sustained slowness at the floor — a genuinely fill-bound device is
    slow for its whole session and still converges in a few seconds. */
const WINDOW_DOWN = 40;
/** Consecutive rendered frames whose mean must sit under the up-band to step up (base). */
const WINDOW_UP = 120;
/** The up-window doubles after every bounce (down after an up), to this ceiling. */
const WINDOW_UP_MAX = 960;
/** Step up when the mean is under this fraction of the target frame time. */
const UP_HEADROOM = 0.55;
/** Step down only when the mean is over the target by this factor (vsync-line margin). */
const DOWN_TOLERANCE = 1.05;
/** A step down aims this far under the target, so it lands inside the hold band. */
const DOWN_AIM = 0.95;
/** Per-step ratio factor bounds for a step down (pixels scale with the square). */
const DOWN_MIN_FACTOR = 0.6;
const DOWN_MAX_FACTOR = 0.9;
/** Ratio factor for a step up — small, so the climb back is gradual. */
const UP_FACTOR = 1 / 0.9;
/** Frames and wall time discarded after any change to the canvas size. */
const COOLDOWN_FRAMES = 20;
const COOLDOWN_MS = 600;
/** Rendered frames ignored after a scene load. */
const SETTLE_FRAMES = 60;
/** A step down must improve the mean by at least this fraction, or it is reverted... */
const MIN_IMPROVEMENT = 0.08;
/** ...and the governor rests before trying again: this long at first, doubling to the cap. */
const PAUSE_BASE_MS = 15_000;
const PAUSE_MAX_MS = 120_000;
/** A gap longer than this between rendered frames is a pause, not a slow frame. */
const GAP_MS = 500;

export interface AdaptiveOptions {
  /** The floor. Default 30. */
  targetFps?: number;
  /** Lowest scale the governor may reach. Default 0.4 — 16% of the pixels. */
  minScale?: number;
}

export interface AdaptiveReport {
  enabled: boolean;
  scale: number;
  targetMs: number;
  /** Mean of the current sample window, ms; 0 when empty. */
  windowMeanMs: number;
  windowFrames: number;
  /** Frames a step up currently requires (grows after bounces). */
  upWindow: number;
  /** ms until a paused governor resumes; 0 when not paused. */
  pausedForMs: number;
  /** How long the NEXT revert would pause for (the backoff), ms. */
  nextPauseMs: number;
  /** Why the last change happened, for the console. */
  lastChange: string;
}

export class AdaptiveResolution {
  /** Multiplier on the device-decided pixel ratio, in (minScale, 1]. */
  scale = 1;
  enabled = true;
  /** Called after every change; main.ts re-decides the ratio and resizes. */
  onChange?: (scale: number, reason: string) => void;

  private readonly targetMs: number;
  private readonly minScale: number;
  private deltas: number[] = [];
  private lastAt = 0;
  private settleFrames = SETTLE_FRAMES;
  private cooldownFrames = 0;
  private cooldownUntil = 0;
  private pausedUntil = 0;
  private pauseMs = PAUSE_BASE_MS;
  private upWindow = WINDOW_UP;
  private lastWasUp = false;
  // The effectiveness check for the most recent step down.
  private pendingCheck = false;
  private meanBeforeDown = 0;
  private scaleBeforeDown = 1;
  private lastChange = 'none';

  constructor(opts: AdaptiveOptions = {}) {
    const fps = opts.targetFps && opts.targetFps > 0 ? opts.targetFps : 30;
    this.targetMs = 1000 / fps;
    this.minScale = Math.min(1, Math.max(0.1, opts.minScale ?? 0.4));
  }

  /**
   * A scene is loading. The SCALE is kept — a device that needed 0.7 in the
   * last room needs it in the next — but the samples are dropped and the
   * opening frames are ignored while the splat streams, bakes and sorts in.
   */
  reset(): void {
    this.deltas.length = 0;
    this.settleFrames = SETTLE_FRAMES;
    this.pendingCheck = false;
    this.lastAt = 0;
  }

  /** The canvas changed size for a reason that was not us (resize, rotation). */
  notifyResize(now = performance.now()): void {
    this.deltas.length = 0;
    this.cooldownFrames = COOLDOWN_FRAMES;
    this.cooldownUntil = now + COOLDOWN_MS;
  }

  /** Call once per RENDERED frame, from `frameend`. */
  sample(now: number): void {
    if (!this.enabled) return;
    const delta = this.lastAt > 0 ? now - this.lastAt : 0;
    this.lastAt = now;
    if (delta <= 0 || delta > GAP_MS) {
      // A pause (or the first frame): judge only continuous motion.
      this.deltas.length = 0;
      return;
    }
    if (this.settleFrames > 0) {
      this.settleFrames--;
      return;
    }
    if (this.cooldownFrames > 0 || now < this.cooldownUntil) {
      if (this.cooldownFrames > 0) this.cooldownFrames--;
      return;
    }
    if (now < this.pausedUntil) return;

    this.deltas.push(delta);
    if (this.deltas.length > this.upWindow) this.deltas.shift();

    if (this.deltas.length >= WINDOW_DOWN) {
      const recent = this.mean(WINDOW_DOWN);

      const overFloor = recent > this.targetMs * DOWN_TOLERANCE;

      if (this.pendingCheck) {
        this.pendingCheck = false;
        if (overFloor && recent > this.meanBeforeDown * (1 - MIN_IMPROVEMENT)) {
          // Shrinking the canvas did not shorten the frame: the ceiling is not
          // fill. Give the pixels back and stop trying for a while — longer
          // each time it happens, so a device that will never respond is not
          // resized every quarter minute for the rest of the session.
          this.scale = this.scaleBeforeDown;
          this.pausedUntil = now + this.pauseMs;
          const paused = this.pauseMs / 1000;
          this.pauseMs = Math.min(PAUSE_MAX_MS, this.pauseMs * 2);
          this.apply(now, `revert (${recent.toFixed(1)}ms vs ${this.meanBeforeDown.toFixed(1)}ms: not fill-bound), paused ${paused}s`);
          return;
        }
        // A step that worked — reached the floor, or moved the needle — resets
        // the backoff.
        this.pauseMs = PAUSE_BASE_MS;
      }

      if (overFloor && this.scale > this.minScale) {
        const factor = Math.min(
          DOWN_MAX_FACTOR,
          Math.max(DOWN_MIN_FACTOR, Math.sqrt((this.targetMs * DOWN_AIM) / recent)),
        );
        this.scaleBeforeDown = this.scale;
        this.meanBeforeDown = recent;
        this.scale = Math.max(this.minScale, this.scale * factor);
        this.pendingCheck = true;
        if (this.lastWasUp) this.upWindow = Math.min(WINDOW_UP_MAX, this.upWindow * 2);
        this.lastWasUp = false;
        this.apply(now, `down ×${factor.toFixed(2)} (${recent.toFixed(1)}ms > ${this.targetMs.toFixed(1)}ms)`);
        return;
      }
    }

    if (this.deltas.length >= this.upWindow && this.scale < 1) {
      const all = this.mean(this.deltas.length);
      if (all < this.targetMs * UP_HEADROOM) {
        this.scale = Math.min(1, this.scale * UP_FACTOR);
        this.lastWasUp = true;
        this.apply(now, `up (${all.toFixed(1)}ms over ${this.deltas.length} frames)`);
      }
    }
  }

  report(now = performance.now()): AdaptiveReport {
    return {
      enabled: this.enabled,
      scale: Math.round(this.scale * 1000) / 1000,
      targetMs: Math.round(this.targetMs * 10) / 10,
      windowMeanMs: this.deltas.length ? Math.round(this.mean(this.deltas.length) * 10) / 10 : 0,
      windowFrames: this.deltas.length,
      upWindow: this.upWindow,
      pausedForMs: Math.max(0, Math.round(this.pausedUntil - now)),
      nextPauseMs: this.pauseMs,
      lastChange: this.lastChange,
    };
  }

  /** Mean of the most recent `n` deltas. */
  private mean(n: number): number {
    const d = this.deltas;
    const count = Math.min(n, d.length);
    let sum = 0;
    for (let i = d.length - count; i < d.length; i++) sum += d[i];
    return count ? sum / count : 0;
  }

  private apply(now: number, reason: string): void {
    this.lastChange = reason;
    this.deltas.length = 0;
    this.cooldownFrames = COOLDOWN_FRAMES;
    this.cooldownUntil = now + COOLDOWN_MS;
    this.onChange?.(this.scale, reason);
  }
}
