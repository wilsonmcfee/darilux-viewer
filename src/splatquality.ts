/* ============================================================================
   splatquality.ts — the splat renderer's cost/quality knobs, in one place.
   ----------------------------------------------------------------------------
   WHY THIS FILE EXISTS

   PlayCanvas ships six tuning parameters on `app.scene.gsplat` that trade
   image quality for frame time, and this viewer has been running every one of
   them at its stock default since the day it was written — not by decision, but
   because `main.ts` adds the gsplat component with no options and never touches
   the scene params at all. They are listed and defaulted in the engine at
   `playcanvas.dbg.mjs:55202`.

   Worse, none of them was reachable from a console, so the one machine that
   matters — Will's phone — could not A/B a single value without a rebuild and
   a redeploy. `TEMPLATE.md` -> "Performance" opens by admitting nobody has
   profiled this viewer; that is the reason why.

   THE ONE THING TO UNDERSTAND BEFORE CHANGING A NUMBER HERE

   Two of the six knobs DO NOTHING on a WebGL2 device.

   The engine resolves GSPLAT_RENDERER_AUTO to GPU sorting on WebGPU and CPU
   sorting on WebGL2 (`playcanvas.dbg.mjs:55251`). `minContribution` and
   `foveationStrength` are read only by the WGSL compute shaders on the GPU-sort
   path — grep the engine build and they appear as `f32` uniforms around
   `:130978` and nowhere in the GLSL. `minPixelSize` and `alphaClipForward` have
   real GLSL uniforms (`:136916`, `:136542`) and work on both.

   This matters more than it sounds. An older phone, and ANY in-app browser
   wrapping WKWebView, falls back to WebGL2 — so on exactly the devices that are
   struggling, the two most powerful-sounding knobs are inert. Tune those two on
   a WebGPU phone if you have one; get the WebGL2 win from `minPixelSize`,
   render resolution, and splat count instead.

   Use `?gl` (see device.ts) to reproduce the WebGL2 path on a desktop, and
   `?stats` to read the result. `activePathNote()` below prints which knobs are
   live on the current device so nobody tunes an inert one for an hour.
   ========================================================================== */

import type { AppBase } from 'playcanvas';

/**
 * The tunable set. Every field is optional so a caller can nudge one value
 * without restating the rest — which is what makes the console helper usable
 * one knob at a time.
 */
export interface SplatQuality {
  /**
   * Screen-space size in pixels below which a splat is discarded. Engine
   * default 2. Works on BOTH render paths, which makes it the main lever on a
   * WebGL2 phone. Raising it culls the distant fine detail first — the long
   * tail of sub-pixel gaussians that cost a full rasterised quad each and
   * contribute a fraction of one pixel of colour.
   */
  minPixelSize?: number;
  /**
   * Alpha floor in the forward pass. Engine default 1/255 — effectively "keep
   * everything that is not perfectly transparent". Works on BOTH paths. A 3DGS
   * scene carries a long tail of near-transparent gaussians that are individually
   * invisible and collectively expensive, because each one still costs a blended
   * quad. This is the cheapest way to delete them at runtime.
   */
  alphaClipForward?: number;
  /**
   * Discard threshold on `opacity * projected area`. Engine default 3.
   * **WebGPU only.** Smarter than `minPixelSize` where it works, because it
   * accounts for a splat being large but faint as well as small but solid.
   */
  minContribution?: number;
  /**
   * Foveated culling strength. Engine default 0, i.e. OFF. **WebGPU only.**
   * Raises the contribution threshold radially from screen centre, so the
   * middle of the frame keeps full detail and the periphery sheds cheap splats.
   * The engine's own formula is
   * `minContribution + foveationStrength * smoothstep(foveationCenter, 1, |ndc|)`.
   * On a phone held at arm's length this is close to free visually: the eye is
   * on the centre of a small screen, and the corners of a 9:16 frame are where
   * the fill cost is worst.
   */
  foveationStrength?: number;
  /**
   * NDC radius inside which foveation has no effect. Engine default 0.3.
   * **WebGPU only.** Lower widens the culling inward; raise it if the falloff
   * becomes visible when you sweep the look stick.
   */
  foveationCenter?: number;
  /**
   * Sort by distance from the camera rather than along its forward axis.
   * Engine default false. Works on BOTH paths, and on the WebGL2 path it is
   * the difference between a sort permanently in flight and one that mostly
   * sleeps.
   *
   * The reason is a threshold, not a preference. The engine re-sorts when the
   * camera changes by more than 1e-3, but WHICH quantity that tests depends on
   * this flag: with directional sorting it is the forward vector, so
   * `acos(dot(last, now)) > 1e-3 rad` = **0.057 degrees** of rotation, and
   * position is ignored entirely. The look stick turns at 75 deg/s — 1.25 deg
   * per frame at 60 fps, twenty-two times over the threshold — so simply
   * looking around requests a re-sort every single frame. With radial sorting
   * the test becomes position moved > 1e-3 world units and rotation is ignored,
   * so turning your head costs nothing.
   *
   * It is a genuine trade, not a free win: the engine's own note is that radial
   * reduces artifacts when the camera ROTATES and linear reduces them when it
   * TRANSLATES — and walk mode translates. Worth judging both ways on the
   * phone with `__splat({radialSorting: false})`.
   */
  radialSorting?: boolean;
  /**
   * Degrees of viewing-angle change before per-splat view-dependent colour is
   * re-evaluated. Engine default 10. Works on BOTH paths, and matters most in
   * walk mode.
   *
   * This bundle carries `shN.bands = 2`, so colour is view-dependent and the
   * unified renderer bakes it into the work buffer rather than evaluating it
   * per frame. The re-bake is all-or-nothing for a non-octree asset: all
   * 2.53M splats, through a ~44-texture-fetch shader, in one frame.
   *
   * The trigger is `tan(colorUpdateAngle) * max(1, distance)` of accumulated
   * camera TRANSLATION (playcanvas.dbg.mjs:130132). At the default 10 degrees
   * that is `tan(10°) = 0.176` world units — and at this scene's 3 units per
   * metre, **5.9 cm**. Walk speed is 1.25 m/s, so simply walking across the
   * room re-bakes the entire scene roughly twenty times a second.
   *
   * Raising it is close to free visually, because what goes stale is only the
   * specular/view-dependent component: 30 degrees gives 19 cm between re-bakes
   * and 45 degrees gives 33 cm. Note the direction of travel — SuperSplat's
   * viewer sets this *lower* (1 in its perf mode), which is a quality-up,
   * performance-down choice; do not copy it.
   */
  colorUpdateAngle?: number;
  /**
   * Alpha floor on the UNIFIED path, engine default **0.3**. Works on both
   * renderers. This is a different knob from `alphaClipForward` despite the
   * name, and the pair was the single most confusing thing about this file:
   * the engine ships them at wildly different defaults (0.3 vs 1/255) because
   * they clip in different passes.
   *
   * SuperSplat sets this to **1/255** — 77x MORE permissive than engine stock,
   * keeping the entire faint tail the default would discard. It is the clearest
   * evidence that its smoothness is not bought with culling, and it is now the
   * mobile value here for the same reason.
   */
  alphaClip?: number;
  /**
   * Anti-aliasing opacity compensation, engine default **false**. Sets the
   * `GSPLAT_AA` shader define, so it is a SHADER RECOMPILE — set it at scene
   * load, and expect a visible hitch if it is toggled live.
   *
   * The engine's own caveat is the reason this is off rather than on: it is
   * meant for splats that were TRAINED with anti-aliasing, and "if the source
   * splats were generated without anti-aliasing, enabling this option may
   * slightly soften the image or alter opacity". Bluedio came out of LichtFeld
   * Studio and nobody has established which it was, so turning this on blind
   * would be another silent quality change of exactly the kind this pass is
   * undoing. It is exposed because it is a genuine candidate for the shimmer
   * on small distant splats at reduced resolution — A/B it with
   * `__splat({antiAlias: true})` and judge the drapes and the far wall.
   */
  antiAlias?: boolean;
}

/**
 * The mobile preset — REWRITTEN 2026-08-25 after reading SuperSplat's source.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 *
 * It moved every shared knob in the quality-DOWN direction, on top of a render
 * resolution already cut to half SuperSplat's and a splat bundle already cut to
 * half the gaussians. Five independent cuts stacked, none of them A/B'd against
 * the others, against a benchmark that makes none of them. The report from the
 * phone — "resolution dropped much too drastically, the culling was much too
 * aggressive" — was simply correct.
 *
 * Here is every shared knob, engine stock vs the viewer being benchmarked
 * against vs what this file used to do:
 *
 *   knob                stock     SuperSplat        old preset
 *   alphaClip           0.3       1/255  (keeps++)  untouched
 *   alphaClipForward    1/255     untouched         0.03   (7.6x harsher)
 *   minContribution     3         1      (keeps++)  6
 *   minPixelSize        2         untouched         3
 *   colorUpdateAngle    10        0.2    (quality)  30
 *   radialSorting       false     true              true
 *
 * SuperSplat moves three knobs and every one of them keeps MORE splats than
 * the engine would by default. So the preset below now does the same, and the
 * mobile build deviates from engine stock in exactly three places:
 *
 * - `alphaClip` 1/255 (from 0.3) — SuperSplat's value. A quality INCREASE over
 *   engine stock, keeping the faint tail that carries most of a splat scene's
 *   photographic softness.
 * - `radialSorting` true. The one unambiguous win from the last pass, and it
 *   survives untouched: it is a re-sort THRESHOLD change, not a quality
 *   trade — see the field note above for the 0.057-degree arithmetic.
 * - `colorUpdateAngle` 30 (from 10). THE ONE DELIBERATE DEVIATION, and it is
 *   deliberate because SuperSplat is an ORBIT viewer and this is a WALK viewer.
 *   The re-bake trigger is camera TRANSLATION, which SuperSplat barely does and
 *   walk mode does constantly — at stock it re-bakes all 2.53M splats about
 *   twenty times a second while walking. What goes stale is only the
 *   view-dependent specular component. This is the value to challenge first if
 *   anything looks flat in motion.
 *
 * Everything else is back to engine stock: `alphaClipForward`, `minPixelSize`,
 * `minContribution`, `foveationStrength`.
 *
 * `foveationStrength` going to 0 deserves a word since it was 4 and it is free
 * where it works. It is WebGPU-only, so it never ran on the phones actually
 * struggling; and its case was made for a FULL-BLEED 9:16 frame, where the
 * corners are far from a centred subject. The docked phone layout renders a
 * small 4:3 window in which no pixel is far from centre, so there is little for
 * it to cull and a real chance of the falloff becoming visible on a look sweep.
 * Off by default, still exposed.
 */
export const MOBILE_PRESET: Required<SplatQuality> = {
  minPixelSize: 2,
  alphaClipForward: 1 / 255,
  alphaClip: 1 / 255,
  minContribution: 3,
  foveationStrength: 0,
  foveationCenter: 0.3,
  radialSorting: true,
  colorUpdateAngle: 30,
  antiAlias: false,
};

/**
 * The OLD mobile preset, kept so the regression is one call away rather than a
 * git archaeology exercise: `__splat('lastpass')`. This is what shipped and
 * what came back judged too aggressive — it is the honest A/B for anyone who
 * later suspects the pendulum swung too far the other way.
 */
export const LAST_PASS_PRESET: Required<SplatQuality> = {
  minPixelSize: 3,
  alphaClipForward: 0.03,
  alphaClip: 0.3,
  minContribution: 6,
  foveationStrength: 4,
  foveationCenter: 0.3,
  radialSorting: true,
  colorUpdateAngle: 30,
  antiAlias: false,
};

/** Everything the engine ships as the default, recorded so `reset()` is honest. */
export const ENGINE_DEFAULTS: Required<SplatQuality> = {
  minPixelSize: 2,
  alphaClipForward: 1 / 255,
  alphaClip: 0.3,
  minContribution: 3,
  foveationStrength: 0,
  foveationCenter: 0.3,
  radialSorting: false,
  colorUpdateAngle: 10,
  antiAlias: false,
};

export class SplatQualityControl {
  private app: AppBase;
  private webgpu: boolean;

  constructor(app: AppBase, renderer: string) {
    this.app = app;
    this.webgpu = renderer === 'webgpu';
  }

  /** Which knobs actually do something on the device that booted. */
  get activePathNote(): string {
    return this.webgpu
      ? 'webgpu (GPU sort): all knobs live'
      : 'webgl2 (CPU sort): minPixelSize, alphaClip, alphaClipForward, ' +
        'colorUpdateAngle, radialSorting and antiAlias are live; ' +
        'minContribution and foveationStrength are WGSL-only and inert here';
  }

  /**
   * Apply a partial set. Unspecified fields keep whatever is in effect.
   *
   * CALL THIS AT SCENE LOAD, NEVER FROM THE FRAME LOOP. That is a rule about
   * the engine, not about tidiness. `GSplatWorld.update()` watches
   * `scene.gsplat.dirty`, and when it is set it marks a work-buffer rebuild, a
   * layer-placement refresh AND a re-sort all at once — re-baking all 2.53M
   * splats through the ~44-fetch bake shader.
   *
   * Most knobs touched here are in the SAFE bucket: they route through
   * `_material.setParameter`, which does not set `dirty`. `radialSorting` is a
   * plain field and is also safe. But `splatBudget`, `colorRamp`, `debug` and
   * `enableIds` are NOT — so anyone extending this class must check which
   * bucket a new knob is in before wiring it to anything that changes often.
   *
   * ONE EXCEPTION, ADDED 2026-08-25: `antiAlias` sets a shader DEFINE and calls
   * `_material.update()`, so it forces a shader recompile rather than a work
   * buffer rebuild. Cheaper than `dirty`, but not free and not silent — it is
   * fine at scene load and fine for a deliberate console A/B, and it must never
   * be driven by anything that changes per frame.
   */
  apply(q: SplatQuality): void {
    const g = this.app.scene.gsplat;
    if (q.minPixelSize !== undefined) g.minPixelSize = q.minPixelSize;
    if (q.alphaClip !== undefined) g.alphaClip = q.alphaClip;
    if (q.alphaClipForward !== undefined) g.alphaClipForward = q.alphaClipForward;
    if (q.minContribution !== undefined) g.minContribution = q.minContribution;
    if (q.foveationStrength !== undefined) g.foveationStrength = q.foveationStrength;
    if (q.foveationCenter !== undefined) g.foveationCenter = q.foveationCenter;
    if (q.radialSorting !== undefined) g.radialSorting = q.radialSorting;
    if (q.colorUpdateAngle !== undefined) g.colorUpdateAngle = q.colorUpdateAngle;
    // Last, and only on a real change: see the shader-recompile note above.
    if (q.antiAlias !== undefined && q.antiAlias !== g.antiAlias) g.antiAlias = q.antiAlias;
  }

  /** Put every knob back to the engine default — the pre-tuning A/B baseline. */
  reset(): void {
    this.apply(ENGINE_DEFAULTS);
  }

  /** Current values, plus the note about which of them matter here. */
  report(): Record<string, unknown> {
    const g = this.app.scene.gsplat;
    return {
      path: this.activePathNote,
      minPixelSize: g.minPixelSize,
      alphaClip: g.alphaClip,
      alphaClipForward: g.alphaClipForward,
      minContribution: g.minContribution,
      foveationStrength: g.foveationStrength,
      foveationCenter: g.foveationCenter,
      radialSorting: g.radialSorting,
      colorUpdateAngle: g.colorUpdateAngle,
      antiAlias: g.antiAlias,
    };
  }
}
