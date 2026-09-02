/* ============================================================================
   perfhud.ts — an on-screen frame-time readout you can read on a phone.
   ----------------------------------------------------------------------------
   WHY THIS EXISTS

   `TEMPLATE.md` -> "Performance" opens with "Nobody has profiled this viewer
   yet", and every performance number in the docs is arithmetic rather than
   measurement. That is not an oversight anyone could have fixed: the lag is on
   a phone, the phone is not the machine the code is written on, and the one
   trap already documented (a browser pane that is not displayed never fires
   requestAnimationFrame, so it reports nothing) makes remote profiling actively
   misleading. See "Gotchas" #13.

   So the readout has to be IN THE PAGE, legible at arm's length, and cheap
   enough that watching it does not change what it measures.

   WHAT IT REPORTS, AND WHY EACH LINE EARNS ITS ROW

     renderer   webgpu or webgl2. THE most important line. The two paths are not
                variations of each other: WebGPU sorts on the GPU, WebGL2 sorts
                2.53M splats on the CPU in a worker. Half the engine's tuning
                knobs (minContribution, foveationStrength) are WGSL-only and do
                nothing at all on the WebGL2 path. Every other number is only
                interpretable once you know which one you are on.
     fps        rolling mean over the sample window.
     worst      the slowest single frame in the window, in ms. Judge stutter on
                THIS, not on the mean — a 58 fps mean with one 90 ms frame per
                second reads as "laggy" to a person and as "fine" to an average.
     px         canvas BACKING STORE size and its megapixel total. This is the
                fill workload, and it is not the CSS size: it is CSS size times
                the effective device pixel ratio.
     dpr        the pixel ratio actually in effect, which is
                min(device.maxPixelRatio, window.devicePixelRatio) — the number
                resizeCanvas() multiplies by, not the one the phone advertises.
     splats     how many gaussians are resident. On the WebGL2 path the CPU sort
                is linear in this, so it is the number to attack.
     sort       worst depth-sort time in the window, in ms, taken straight from
                the engine's own `gsplat:sorted` event (it fires the worker's
                measured time — playcanvas.dbg.mjs:64828). This line separates
                the two mobile failure modes, which look identical from the
                outside and have OPPOSITE fixes:
                  sort small, fps bad  -> fill-bound. Cut resolution and
                                          overdraw; splat count is not the
                                          problem.
                  sort > one frame     -> the order is stale before it lands, so
                                          the image SWIMS while you move rather
                                          than merely running slow. Only cutting
                                          splat COUNT helps; the sort is linear
                                          in it and no pixel knob touches it.
                Shows "--" when nothing has sorted in the window, which is the
                normal reading for a still camera and for the WebGPU path.
     up         ADDED 2026-09-02. WebGL2 only: how many times this window the
                completed sort was uploaded to the GPU, and the mean time the
                main thread spent inside that texImage2D. Every completed sort
                re-specifies the WHOLE order texture — 11.67 MB at 2.53M — and
                this call is the one place in a frame where the main thread
                waits for the GPU queue, so its time is a GPU-load gauge as
                much as a copy cost: ~1 ms with the GPU idle, 5-18 ms with it
                saturated. The Firefox/Linux profile that prompted the pass
                showed 51% of all script time here. Reads "--" on WebGPU, where
                the order lives in a storage buffer and is never uploaded.
     bake       ADDED 2026-09-02, both paths: full colour re-bakes this window
                — the pass that re-evaluates view-dependent colour for EVERY
                resident splat, triggered by camera translation
                (colorUpdateAngle). The bake runs on the GPU, so its cost never
                shows in main-thread time; the count is the only thing the page
                can see, and it is the number that explains a dip during a
                fly-in that no sort or upload accounts for. Fly-ins hold this
                at 0 by design (main.ts) and fire one on arrival.

   COST OF THE HUD ITSELF

   Per frame it does one subtraction, one comparison and two increments — no
   allocation, no DOM touch, no layout read. The DOM is written 4x/second from
   the accumulated window, so the text node churn cannot show up in the very
   frame times it is reporting. Hidden, it does nothing but an early return.
   ========================================================================== */

import type { AppBase } from 'playcanvas';
import { hookBakeCounters, type BakeCounters } from '../core/gsplatinternals';

/** How long a sample window is, in ms. 250 = four text updates a second. */
const WINDOW_MS = 250;

/* Only uploads at least this big are timed. The order texture is 4 bytes per
   texel over textureSize² (7.4 MB at 1.6M, 11.67 MB at 2.53M); everything else
   the engine puts through texImage2D at runtime is kilobytes. */
const BIG_UPLOAD_BYTES = 1e6;

/* How long without a RENDERED frame before the HUD calls itself idle.
   400 ms is comfortably longer than the 3-frame render hold in main.ts and than
   any single hitch, so a struggling device is never mislabelled as asleep. */
const IDLE_MS = 400;

export class PerfHud {
  private el: HTMLElement | null = null;
  private app: AppBase | null = null;

  // Sample-window accumulators. Deliberately plain numbers: a per-frame array
  // push would allocate, and allocation in the frame loop is exactly the kind
  // of thing this is supposed to be able to detect in other people's code.
  private frames = 0;
  private windowStart = 0;
  private worstMs = 0;
  private lastFrameAt = 0;
  /* Rate limit for the idle repaint, kept separate from `windowStart` so the
     two cannot reset each other and strand the HUD on one of them. */
  private lastIdlePaint = 0;
  // Depth-sort timings, accumulated from the engine event rather than sampled.
  private worstSortMs = 0;
  private sortsInWindow = 0;
  // Order-texture uploads (WebGL2), from the texImage2D hook below.
  private uploadsInWindow = 0;
  private uploadMs = 0;
  private uploadHooked = false;
  // Colour / geometry re-bakes, from gsplatinternals.hookBakeCounters. The
  // counters are cumulative; the window keeps the value they had at its start.
  private bakes: BakeCounters = { color: 0, geometry: 0 };
  private bakesAtWindowStart = 0;

  private enabled = false;
  private renderer = '?';
  private splats = 0;

  constructor(private host: HTMLElement) {}

  /** Called once the engine exists. `renderer` comes from createDevice(). */
  attach(app: AppBase, renderer: string): void {
    this.app = app;
    this.renderer = renderer;

    /* The engine already measures the depth sort and throws the number away
       unless someone listens. Subscribing costs nothing when the HUD is off —
       the handler is two comparisons — and it is the only way to see sort cost
       on a phone, where the worker's timing is otherwise invisible. */
    app.scene.on('gsplat:sorted', (sortMs: number) => {
      if (sortMs > this.worstSortMs) this.worstSortMs = sortMs;
      this.sortsInWindow++;
    });
  }

  /** Resident gaussian count, so the sort workload is on screen. */
  setSplatCount(n: number): void {
    this.splats = n;
    }

  /**
   * Time the big texImage2D calls on THIS device's context. Installed on the
   * first enable, never on the prototype: an instance property shadows the
   * prototype method for the engine's `gl.texImage2D(...)` calls and nothing
   * else on the page. A disabled HUD therefore never even pays the byte-length
   * comparison. Skipped entirely on WebGPU, which has no gl.
   */
  private hookUploads(): void {
    if (this.uploadHooked || !this.app) return;
    this.uploadHooked = true;
    const gl = (this.app.graphicsDevice as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (!gl || typeof gl.texImage2D !== 'function') return;
    const orig = gl.texImage2D as (...args: unknown[]) => void;
    const hud = this;
    (gl as unknown as { texImage2D: (...args: unknown[]) => void }).texImage2D = function (
      this: WebGL2RenderingContext,
      ...args: unknown[]
    ): void {
      const data = args[args.length - 1] as { byteLength?: number } | null;
      if (!data || typeof data.byteLength !== 'number' || data.byteLength < BIG_UPLOAD_BYTES) {
        orig.apply(this, args);
        return;
      }
      const t = performance.now();
      orig.apply(this, args);
      hud.uploadsInWindow++;
      hud.uploadMs += performance.now() - t;
    };
  }

  /** Show or hide. Returns the new state so `__stats()` can report it. */
  setEnabled(on: boolean): boolean {
    this.enabled = on;
    if (on) this.hookUploads();
    if (on && !this.el) {
      this.el = document.createElement('div');
      this.el.className = 'perf-hud';
      this.host.appendChild(this.el);
      // Reset the window so the first reading is not polluted by however long
      // the page sat idle before someone switched the HUD on.
      this.windowStart = performance.now();
      this.lastFrameAt = this.windowStart;
      this.frames = 0;
      this.worstMs = 0;
    }
    if (this.el) this.el.style.display = on ? 'block' : 'none';
    return this.enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Call every frame, INCLUDING frames the app chose not to render.
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT PART OF sample()
   *
   * `sample()` hangs off `frameend`, which only fires on frames that were
   * actually drawn. Once on-demand rendering landed (main.ts), a stationary
   * visitor stops producing those events entirely — so the HUD would freeze
   * mid-reading and go on displaying "60 fps" from whenever they last moved.
   * That is worse than a wrong number: it is a stale number that looks live,
   * on the one instrument whose whole job is to be trusted.
   *
   * So this runs off `update`, which fires whether or not anything was drawn,
   * and says plainly that nothing is being drawn. Reading `idle` while standing
   * still is the CORRECT reading of a healthy on-demand viewer — it is the
   * thermal headroom being banked, and it is what to look for when checking
   * that the feature is working at all.
   */
  tick(): void {
    if (!this.enabled || !this.el) return;
    /* The engine's work buffer is created lazily and recreated on a renderer
       change, so the bake hook is (re)attached every frame — a two-level Map
       walk that skips anything already hooked. */
    if (this.app) hookBakeCounters(this.app, this.bakes);
    const now = performance.now();
    if (now - this.lastFrameAt < IDLE_MS) return; // frames are still arriving
    if (now - this.lastIdlePaint < WINDOW_MS) return; // same 4/s DOM budget
    this.lastIdlePaint = now;

    const canvas = this.app?.graphicsDevice?.canvas;
    const w = canvas?.width ?? 0;
    const h = canvas?.height ?? 0;
    const dpr = canvas && canvas.clientWidth > 0 ? w / canvas.clientWidth : 0;
    this.el.textContent =
      `${this.renderer}  idle · not drawing\n` +
      `${w}x${h}  ${((w * h) / 1e6).toFixed(2)} Mpx  dpr ${dpr.toFixed(2)}\n` +
      `${(this.splats / 1e6).toFixed(2)}M splats  sort --\n` +
      `up --  bake --`;

    /* Start the next moving window from here, so the first reading after the
       visitor moves again measures motion rather than however long they sat
       still — the same reasoning as the `delta < 500` guard in sample(). */
    this.windowStart = now;
    this.frames = 0;
    this.worstMs = 0;
    this.resetWindowCounters();
  }

  private resetWindowCounters(): void {
    this.worstSortMs = 0;
    this.sortsInWindow = 0;
    this.uploadsInWindow = 0;
    this.uploadMs = 0;
    this.bakesAtWindowStart = this.bakes.color;
  }

  /**
   * Call once per RENDERED frame. Cheap by construction — see the header note.
   * The early return means a disabled HUD costs one property read per frame.
   */
  sample(): void {
    if (!this.enabled || !this.el) return;

    const now = performance.now();
    const delta = now - this.lastFrameAt;
    this.lastFrameAt = now;

    // Skip the first frame after a gap (tab restore, scene load, HUD enable):
    // its delta is the length of the gap, not a frame time, and it would pin
    // `worst` to a meaningless number for the rest of the window.
    if (delta < 500) {
      this.frames++;
      if (delta > this.worstMs) this.worstMs = delta;
    }

    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return;

    const fps = this.frames > 0 ? (this.frames * 1000) / elapsed : 0;
    const canvas = this.app?.graphicsDevice?.canvas;
    const w = canvas?.width ?? 0;
    const h = canvas?.height ?? 0;
    const mp = (w * h) / 1e6;
    // The ratio actually in effect, which is what resizeCanvas() applies — not
    // window.devicePixelRatio, which is what the phone would like to have.
    const dpr = canvas && canvas.clientWidth > 0 ? w / canvas.clientWidth : 0;

    // "--" rather than "0" when nothing sorted: a still camera legitimately
    // does not re-sort, and printing 0 ms would read as "the sort is free".
    const sort =
      this.sortsInWindow > 0 ? `${this.worstSortMs.toFixed(0)}ms x${this.sortsInWindow}` : '--';
    // Same "--" convention: no upload and no bake this window are both healthy
    // readings, and 0 would read as "free".
    const up =
      this.uploadsInWindow > 0
        ? `x${this.uploadsInWindow} ${(this.uploadMs / this.uploadsInWindow).toFixed(1)}ms`
        : '--';
    const bakes = this.bakes.color - this.bakesAtWindowStart;
    const bake = bakes > 0 ? `x${bakes}` : '--';

    this.el.textContent =
      `${this.renderer}  ${fps.toFixed(0)} fps  worst ${this.worstMs.toFixed(0)}ms\n` +
      `${w}x${h}  ${mp.toFixed(2)} Mpx  dpr ${dpr.toFixed(2)}\n` +
      `${(this.splats / 1e6).toFixed(2)}M splats  sort ${sort}\n` +
      `up ${up}  bake ${bake}`;

    this.windowStart = now;
    this.frames = 0;
    this.worstMs = 0;
    this.resetWindowCounters();
  }
}
