/* ============================================================================
   device.ts — create the GPU device with a WebGPU-first, WebGL2-fallback policy.
   ----------------------------------------------------------------------------
   WHY THIS MATTERS (the "black screen on the client's phone" problem)
   WebGPU is the fast, modern way a page talks to the GPU; WebGL2 is the older,
   near-universal one. A splat renders on either. If we asked for WebGPU ONLY,
   any device without it (older iPhones/Macs, most in-app browsers) would show a
   silent black canvas. So we ask for WebGPU first and let the engine fall back
   to WebGL2 automatically — reach goes from "modern devices only" to ~everyone.

   The modern engine renders splats on WebGPU with WGSL shaders directly, so no
   external shader-compiler helpers (glslang/twgsl) are needed — the SuperSplat
   starter passes none, and neither do we. We keep one improvement over the
   starter: a WebGL2 fallback, so devices without WebGPU still render instead of
   showing a black screen.
   ========================================================================== */

import {
  createGraphicsDevice,
  DEVICETYPE_WEBGPU,
  DEVICETYPE_WEBGL2,
  type GraphicsDevice,
} from 'playcanvas';
import { logTag } from './brand';

export interface DeviceResult {
  device: GraphicsDevice;
  renderer: 'webgpu' | 'webgl2';
}

export interface DeviceOptions {
  /**
   * Multiplier on the computed mobile pixel ratio. See `defaultPixelRatio()`.
   * The full-bleed page passes SuperSplat's own 0.5; the docked phone page
   * passes more, because its canvas is a third of the area.
   */
  perfScale?: number;
}

/* Physical pixels across the SHORT AXIS OF THE SCREEN that a phone is allowed
   to render, before the perf scale. This is SuperSplat's number and SuperSplat's
   model, adopted verbatim after reading its source:

     const maxPixelDim = platform.mobile ? 1080 : 2160;
     const pixelRatio = Math.min(maxPixelDim / Math.min(screen.width, screen.height),
                                 window.devicePixelRatio);
     const scale = pixelRatio * (performanceMode ? 0.5 : 1.0);

   A CAP ON PHYSICAL RESOLUTION IS A BETTER MODEL THAN A TARGET DPR, and the
   difference is not cosmetic. "Render at DPR 1" — what this file used to do —
   asks for one rendered pixel per CSS pixel, so it delivers a different
   PHYSICAL sharpness on every phone: a 320-wide SE and a 430-wide Pro Max both
   get "1.0", meaning 320 and 430 real pixels across, and the picture is
   visibly softer on the smaller phone for no reason anyone chose. A cap says
   "no more than 1080 real pixels across the short axis, and never more than
   the panel actually has", which is the same physical sharpness everywhere and
   degrades only where the panel is genuinely enormous. */
const MOBILE_MAX_SHORT_AXIS_PX = 1080;

/**
 * Target pixel ratio for the splat canvas.
 *
 * WHY THIS NUMBER MOVED, AND WHY IT WAS THE PHOTOREAL COMPLAINT
 *
 * The previous pass capped phones at a flat 1.0 on the finding that SuperSplat
 * halves its canvas on mobile. That finding was right and the implementation
 * overshot it by about 2x, because a 0.5 multiplier there is applied to a
 * ratio that is itself near the device DPR, not to 1.0. Worked through on a
 * 390x844 DPR-3 phone:
 *
 *   SuperSplat:  min(1080/390, 3) = 2.769,  x 0.5 (its mobile default) = 1.385
 *   here, was:   1.000
 *
 * So the shipped mobile build rendered at HALF SuperSplat's linear resolution —
 * a quarter of the pixels — while ALSO shipping half the splats and clipping
 * alpha 7.6x harder than stock. Three independent cuts stacked on a benchmark
 * that makes none of them. That is the "resolution dropped much too
 * drastically, lost the photoreal characteristics" report, and this is the line
 * that caused it.
 *
 * `perfScale` is where the two pages differ, and the reason is area rather than
 * taste. The full-bleed page paints the whole screen, so it takes SuperSplat's
 * 0.5. The docked phone page paints a 4:3 window that is ~35% of the screen
 * area, so the SAME frame cost buys ~1.7x the linear sharpness — which is the
 * entire performance argument for the docked layout, and why it can afford 0.75.
 *
 * Deliberately NOT reusing `wantsTouchControls()` from joystick.ts even though
 * the tests look alike. That one answers "should thumb pads be on screen", is
 * re-evaluated on every resize, and is overridden by `?touch=` so a desktop can
 * be made to show pads for a layout check. Render resolution is fixed once at
 * device creation and must not follow a UI override — nobody asking to see the
 * pads on a laptop is also asking to render at half resolution.
 *
 * `?res=N` overrides the result outright; `?perf=N` overrides just the scale.
 */
function defaultPixelRatio(perfScale: number): number {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const smallViewport = window.innerWidth <= 820;
  if (!(coarse || smallViewport)) return 2; // desktop: unchanged

  /* `screen`, not `window.inner*`: the cap is about the PANEL, and a phone's
     inner height changes as the address bar collapses. Falling back to
     innerWidth keeps a headless or unusual environment from dividing by zero. */
  const shortAxis = Math.min(screen?.width || 0, screen?.height || 0) || window.innerWidth;
  const capped = Math.min(MOBILE_MAX_SHORT_AXIS_PX / shortAxis, window.devicePixelRatio);
  /* Floor of 1.0: below that the canvas is being upscaled by the compositor and
     splats stop reading as photographs — which is the failure this whole change
     is undoing, so it must not be reachable by arithmetic. */
  return Math.max(1, capped * perfScale);
}

/**
 * The render pixel ratio a page should run at for a given mobile scale, with
 * the two URL overrides applied (see the note at the point of use in
 * createDevice for what each one is for). Exported because the docked phone
 * page has TWO canvases in one session — the square window, and the full
 * screen when the phone is turned sideways — and re-decides this on the
 * resize that flips between them (main.ts). The desktop answer is unaffected:
 * `defaultPixelRatio` returns 2 there regardless of the scale.
 */
export function targetPixelRatio(perfScale: number): number {
  const params = new URLSearchParams(window.location.search);

  const perfRaw = params.get('perf');
  const perfParam = Number(perfRaw);
  const scale =
    perfRaw !== null && Number.isFinite(perfParam) && perfParam > 0
      ? Math.min(perfParam, 2)
      : perfScale;

  const resRaw = params.get('res');
  const resParam = Number(resRaw);
  return resRaw !== null && Number.isFinite(resParam) && resParam > 0
    ? Math.min(resParam, 4)
    : defaultPixelRatio(scale);
}

export async function createDevice(
  canvas: HTMLCanvasElement,
  opts: DeviceOptions = {},
): Promise<DeviceResult> {
  /* ?gl — force the WebGL2 fallback on a machine that has WebGPU.

     This exists because the two paths are not close relatives. On WebGPU the
     engine sorts splats on the GPU; on WebGL2 it ships the centers to a worker
     and counting-sorts all of them on the CPU, and several of the engine's
     culling knobs (minContribution, foveationStrength) are WGSL-only and do
     nothing whatsoever. A phone that falls back — an older device, or any
     in-app browser wrapping WKWebView — is therefore running a pipeline that a
     modern laptop NEVER exercises, so a developer testing on the laptop is
     testing the one path that was not the problem.

     With ?gl the slow pipeline is reproducible at a desk. Pair it with ?stats
     to read frame times off the same page. It is a diagnostic only: nothing in
     the shipped experience reads it, and without it the preference order below
     is unchanged. */
  const forceGl = /(^|[?&#])gl(=1|[&#]|$)/i.test(
    window.location.search + window.location.hash,
  );

  /* The engine defaults BOTH `alpha` and `stencil` to true, and this scene uses
     neither.

     `alpha: false` — an alpha-backed canvas is composited SRC_OVER against the
     page every frame, and can never be promoted to an opaque layer that the
     compositor may scan out directly or use to occlude what is behind it.
     Nothing here needs it: the camera clears to an opaque colour, and on
     bluedio.html the canvas covers the whole viewport over a body painted the
     same shade. Turning it off removes a full-frame blend of the entire canvas
     from the compositor's work — a whole-frame saving from one word, worth most
     on exactly the tile-based mobile GPUs that are struggling.

     `stencil: false` — splat rendering never reads a stencil buffer, but the
     default allocates a packed depth-stencil attachment across the whole
     surface regardless. Dead VRAM and dead bandwidth on a device short of both.

     BOTH ARE HONOURED AT RUNTIME ON BOTH PATHS, and only `stencil` is in the
     published type. WebGPU reads `alpha` into the canvas configuration —
     `alphaMode: this.initOptions.alpha ? 'premultiplied' : 'opaque'`
     (playcanvas.dbg.mjs:22679, defaulted at :22458). WebGL2 forwards the whole
     options object to `canvas.getContext('webgl2', options)` (:26205), where
     `alpha` is a standard context attribute. So the cast below works around a
     gap in the engine's .d.ts, not a gap in the engine — which is why it is a
     cast and not a redesign. Re-check it on an engine upgrade. */
  const deviceOptions = {
    // Order = preference. Engine tries WebGPU, silently falls back to WebGL2.
    deviceTypes: forceGl ? [DEVICETYPE_WEBGL2] : [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
    antialias: false, // splats do their own edge softening; MSAA just costs memory
    alpha: false,
    stencil: false,
  };

  const device = await createGraphicsDevice(
    canvas,
    deviceOptions as Parameters<typeof createGraphicsDevice>[1],
  );

  /* ---- Render resolution -------------------------------------------------
     THE single biggest mobile lever, and the one thing SuperSplat's viewer does
     that this one did not.

     `resizeCanvas(cssW, cssH)` sizes the backing store to
     `cssW * min(maxPixelRatio, devicePixelRatio)`, so this one number decides
     the entire fill workload. It used to be capped at 2 for everyone.

     SuperSplat's published viewer defaults `performanceMode` to `platform.mobile`
     and halves the canvas in each axis on any phone — a 4x cut in rasterised
     pixels — and lets the visitor opt back IN to sharpness. That default is why
     the same scan feels smooth there and laggy here; it is not a better engine
     (it pins the same 2.21.x) and not a better asset.

     The IMPLEMENTATION of that finding was wrong for a year of one session:
     it was expressed as a flat target of 1.0 on the reasoning that a 0.5
     multiplier "drifts with the device". It does drift, but SuperSplat applies
     it to a ratio already capped at 1080 physical pixels — so 0.5 there means
     ~1.385 on a typical phone, not 1.0. Rendering at 1.0 was half SuperSplat's
     linear resolution, i.e. a QUARTER of its pixels. See defaultPixelRatio().

     Splats tolerate downsampling far better than polygon edges do — they are
     already soft ellipses, so it reads as less fine detail rather than as
     aliasing — but that tolerance is not infinite, and past roughly one device
     pixel per CSS pixel the scene stops reading as a photograph, which is
     exactly what came back from the phone. Only the CANVAS softens either way:
     the hero card, the captions and the dots are DOM and stay pixel-crisp.

     Desktop keeps the old cap of 2. */
  /* Two overrides, and they are not the same knob:

       ?res=N   the final ratio, outright. `?res=1` reproduces what shipped
                before this change; `?res=2` reproduces what shipped before the
                mobile pass. The A/B for "is it sharp enough".
       ?perf=N  the mobile SCALE only, so the 1080 cap still applies on top.
                `?perf=0.5` is SuperSplat's own default; `?perf=1` is
                SuperSplat with performance mode switched off. The A/B for
                "how does this compare to the viewer I benchmarked against".

     Both read NaN-safely and clamped: a typo must not produce a zero-sized
     swapchain (see the ResizeObserver note in main.ts about what a 0x0 surface
     does to WebGPU). */
  device.maxPixelRatio = Math.min(window.devicePixelRatio, targetPixelRatio(opts.perfScale ?? 0.5));

  const renderer: DeviceResult['renderer'] = device.isWebGPU ? 'webgpu' : 'webgl2';
  // Decided behavior: fall back SILENTLY (no "compatibility mode" label to the
  // client) but LOG the active renderer so we can confirm which path ran in testing.
  // The pixel ratio rides along: it is the number most likely to explain a frame
  // time, and ?stats puts the same figure on screen for a device with no console.
  console.info(
    `${logTag()} active renderer: ${renderer} · render pixel ratio ${device.maxPixelRatio} ` +
      `(device reports ${window.devicePixelRatio})`,
  );

  return { device, renderer };
}

/**
 * Backstop check used before we even try to create a device. If neither WebGL2
 * nor WebGPU exists (ancient device, stripped-down in-app browser), we show a
 * clean "needs a modern browser" overlay instead of a silent black screen.
 */
export function canRender(): boolean {
  try {
    const c = document.createElement('canvas');
    const hasWebGL2 = !!c.getContext('webgl2');
    const hasWebGPU = 'gpu' in navigator;
    return hasWebGL2 || hasWebGPU;
  } catch {
    return false;
  }
}
