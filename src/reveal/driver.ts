/* ============================================================================
   reveal/driver.ts — installs the reveal chunks, drives its uniforms, owns time.
   ----------------------------------------------------------------------------
   This is the module that becomes production `src/reveal.ts`. It has deliberately
   no UI and no knowledge of the lab: give it an app, a camera and a RevealConfig,
   call begin() when a scene lands and update() each frame.

   TWO ENGINE LEVERS THE EFFECT CANNOT WORK WITHOUT
   Scaling gaussians toward zero does NOT produce a point cloud in PlayCanvas
   2.21 — it produces an empty frame. Three mechanisms erase a tiny splat:

     1. initCornerCov dilates the projected covariance by +0.3 on both diagonals,
        so even a zero-scale splat has an extent of roughly 1.55 px.
     2. It then DISCARDS the splat outright when max(l1,l2) < minPixelSize, and
        minPixelSize defaults to 2. 1.55 < 2, so the whole seed state vanishes.
     3. With GSPLAT_AA on, aaFactor = sqrt(detOrig/detBlur) tends to zero with
        the projected area, crushing alpha; clipCorner then shrinks the quad
        again as alpha nears the clip threshold.

   So the driver manages `minPixelSize` (a material parameter, no recompile —
   lowered for the reveal, restored to the engine default afterwards) and the
   config exposes `antiAlias` (a define, so it recompiles — applied once and left
   alone rather than toggled per reveal, because a recompile hitch at the moment
   the reveal ENDS is the most visible place to put one). `seedAlphaFloor` in the
   shader is the third leg: it fights the AA crush without any recompile at all.

   TIMING — WHAT IS ACTUALLY POSSIBLE HERE
   The brief asks for theatrical / honest / hybrid, where honest means splats
   bloom as bytes arrive. That is not reachable in this architecture: a SOG bundle
   is means_l, means_u, quats, scales, sh0, shN_* and the GSplatResource does not
   exist until every one of them has downloaded AND decoded. There is no
   partially-renderable splat, so nothing can bloom during the download — the
   whole scene pops into being when `asset.once('load')` fires.

   The three policies therefore reduce to three ways of choosing the reveal's
   DURATION from the measured load time, and the honest part of the experience is
   the loading veil (which does report real aggregated byte progress — sog.js
   combineProgress sums across all sub-assets), handing off to a theatrical
   bloom. Note the inversion in `hybrid`: it makes the reveal SHORTER on a slow
   load, not longer. A visitor who has already waited nine seconds does not want
   a longer animation, and the brief's "never finish before the asset does"
   constraint is satisfied for free because the reveal cannot start until the
   asset is complete.
   ========================================================================== */

import { Color, Vec3, type Application, type Entity } from 'playcanvas';
import {
  DEFAULTS,
  BACKDROP_DEFAULTS,
  PHASE_MODES,
  EASE_MODES,
  DISP_MODES,
  hexToRgb,
  type RevealConfig,
  type BackdropConfig,
} from './config';
import { REVEAL_GLSL, REVEAL_WGSL } from './shader';

/** Engine default for minPixelSize, restored when the reveal finishes. */
const ENGINE_MIN_PIXEL_SIZE = 2;

/**
 * The page already respects prefers-reduced-motion, but only in CSS
 * (style.css: .hero-dot ping, #disclaimer-open, scroll-behavior). CSS cannot
 * gate a vertex shader, so one media-query read in JS is unavoidable. It lives
 * here, once, rather than being sprinkled at call sites.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export interface SceneBounds {
  /** World-space AABB. The reveal reads centres in world space — see shader.ts. */
  min: Vec3;
  max: Vec3;
}

export class RevealDriver {
  private readonly app: Application;
  private readonly camera: Entity;

  private cfg: RevealConfig = { ...DEFAULTS };
  private backdrop: BackdropConfig = { ...BACKDROP_DEFAULTS };

  private installed = false;
  /** 0..1 across the whole reveal, including the spread tail. */
  private p = 1;
  private duration = DEFAULTS.duration;
  private running = false;
  private held = false;
  /** True when prefers-reduced-motion is neutralising the motion terms. */
  private reduced = false;

  private bounds: SceneBounds | null = null;
  private origin = new Vec3();
  private invRadial = 1;
  private invHeight = 1;
  private invCamRange = 1;

  /** Camera clear colour to settle on. Captured at install so we can restore it. */
  private restColor = new Color();
  private readonly scratchColor = new Color();
  private readonly scratchCam = new Vec3();

  constructor(app: Application, camera: Entity) {
    this.app = app;
    this.camera = camera;
    const cc = camera.camera?.clearColor;
    if (cc) this.restColor.copy(cc);
    this.backdrop.finalColor = this.restColor.toString(false);
  }

  /**
   * Install the chunk override on the shared gsplat material template. Both
   * languages every time: which one is live depends on the device, and the
   * unused one costs nothing. Idempotent.
   */
  install(): void {
    if (this.installed) return;
    const mat = this.app.scene.gsplat.material;
    mat.getShaderChunks('glsl').set('gsplatModifyVS', REVEAL_GLSL);
    mat.getShaderChunks('wgsl').set('gsplatModifyVS', REVEAL_WGSL);
    mat.update();
    this.installed = true;
    this.applyConfig();
    this.pushUniforms();
  }

  /** Remove the override and put the engine's levers back. */
  uninstall(): void {
    if (!this.installed) return;
    const mat = this.app.scene.gsplat.material;
    mat.getShaderChunks('glsl').delete('gsplatModifyVS');
    mat.getShaderChunks('wgsl').delete('gsplatModifyVS');
    mat.setParameter('minPixelSize', ENGINE_MIN_PIXEL_SIZE);
    this.app.scene.gsplat.antiAlias = true;
    mat.update();
    this.installed = false;
  }

  get config(): RevealConfig {
    return this.cfg;
  }

  get backdropConfig(): BackdropConfig {
    return this.backdrop;
  }

  /** 0..1 across the whole reveal. 1 means finished (or never started). */
  get progress(): number {
    return this.p;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** True while the motion terms are being flattened for reduced motion. */
  get isReduced(): boolean {
    return this.reduced;
  }

  /** Effective wall time of the current reveal, in seconds. */
  get wallTime(): number {
    return this.duration * (1 + (this.reduced ? 0 : this.cfg.spread));
  }

  setConfig(patch: Partial<RevealConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.applyConfig();
    this.pushUniforms();
  }

  setBackdrop(patch: Partial<BackdropConfig>): void {
    this.backdrop = { ...this.backdrop, ...patch };
    this.pushBackdrop();
  }

  /**
   * Start a reveal. Call from the scene's load handler, once the splat entity
   * exists and the camera is already sitting at the scene's initialPose — the
   * reveal never moves the camera, so it composes with whatever camera mode is
   * live and hands back cleanly when it finishes.
   *
   * @param bounds world-space AABB of the loaded splat
   * @param loadSeconds measured wall time of the load, for the timing policy
   */
  begin(bounds: SceneBounds, loadSeconds: number, opts?: { ignoreReducedMotion?: boolean }): void {
    this.install();
    this.bounds = bounds;
    this.cacheBoundsDerived(bounds);

    // Neutralised rather than skipped: the shader still runs but every
    // motion-bearing term is forced flat, so reduced motion gets a plain
    // opacity crossfade. Overridable only so the lab can tune on a machine
    // where the OS setting is on.
    this.reduced = prefersReducedMotion() && !opts?.ignoreReducedMotion;
    this.duration = this.reduced ? 0.5 : this.effectiveDuration(loadSeconds);

    this.p = 0;
    this.running = true;
    this.held = false;
    this.app.scene.gsplat.material.setParameter('minPixelSize', this.cfg.minPixelSize);
    this.pushUniforms();
    this.pushBackdrop();
  }

  /** Freeze the reveal at a normalised position. This is the scrub bar. */
  hold(p01: number): void {
    this.p = Math.max(0, Math.min(1, p01));
    this.held = true;
    this.running = true;
    this.install();
    this.app.scene.gsplat.material.setParameter('minPixelSize', this.cfg.minPixelSize);
    this.pushUniforms();
    this.pushBackdrop();
  }

  /** Resume from wherever hold() left it. */
  release(): void {
    this.held = false;
  }

  /** Jump to the finished state and put the engine's levers back. */
  finish(): void {
    this.p = 1;
    this.running = false;
    this.held = false;
    this.app.scene.gsplat.material.setParameter('minPixelSize', ENGINE_MIN_PIXEL_SIZE);
    this.pushUniforms();
    this.pushBackdrop();
  }

  update(dt: number): void {
    if (!this.running || this.held) return;
    const total = this.duration * (1 + this.cfg.spread);
    this.p = total > 0 ? Math.min(1, this.p + dt / total) : 1;
    this.pushUniforms();
    this.pushBackdrop();
    if (this.p >= 1) this.finish();
  }

  /**
   * The timing policy, and the whole of it. See the header for why all three
   * modes are duration functions rather than progress-driven animations.
   */
  effectiveDuration(loadSeconds: number): number {
    const c = this.cfg;
    switch (c.timing) {
      case 'honest':
        // Mirror the wait. Clamped because a 200 ms cache hit should not produce
        // a 200 ms reveal (invisible) and a 40 s cold load should not produce a
        // 40 s one (interminable).
        return Math.max(0.6, Math.min(6, loadSeconds));
      case 'hybrid':
        return Math.max(
          c.durationFloor,
          Math.min(c.duration, c.duration - c.loadTimeSlope * Math.max(0, loadSeconds - 2)),
        );
      case 'theatrical':
      default:
        return c.duration;
    }
  }

  // ---- internals ----------------------------------------------------------

  private cacheBoundsDerived(b: SceneBounds): void {
    this.origin.set(
      (b.min.x + b.max.x) * 0.5,
      (b.min.y + b.max.y) * 0.5,
      (b.min.z + b.max.z) * 0.5,
    );
    const height = Math.max(1e-4, b.max.y - b.min.y);
    this.invHeight = 1 / height;
    const dx = (b.max.x - b.min.x) * 0.5;
    const dz = (b.max.z - b.min.z) * 0.5;
    this.invRadial = 1 / Math.max(1e-4, Math.hypot(dx, dz));
    // Camera-distance phase normalises against the scene diagonal, so "fog
    // clearing near to far" spans the room regardless of where the camera sits.
    this.invCamRange = 1 / Math.max(1e-4, Math.hypot(b.max.x - b.min.x, height, b.max.z - b.min.z));
  }

  /** Engine levers that are not our uniforms. antiAlias recompiles — see header. */
  private applyConfig(): void {
    if (!this.installed) return;
    const g = this.app.scene.gsplat;
    if (g.antiAlias !== this.cfg.antiAlias) g.antiAlias = this.cfg.antiAlias;
    g.material.setParameter(
      'minPixelSize',
      this.running ? this.cfg.minPixelSize : ENGINE_MIN_PIXEL_SIZE,
    );
  }

  private pushUniforms(): void {
    if (!this.installed) return;
    const c = this.cfg;
    const mat = this.app.scene.gsplat.material;
    const b = this.bounds;

    // Disabled once finished: the shader early-outs on A.w and every channel
    // passes through untouched, so there is no cost to leaving it installed.
    const enabled = this.running ? 1 : 0;
    // Reduced motion keeps the alpha ramp and drops everything that moves.
    const spread = this.reduced ? 0 : c.spread;
    const u = this.p * (1 + spread);

    mat.setParameter('uRevealA', [u, spread, this.reduced ? 0 : c.hashBlend, enabled]);
    mat.setParameter('uRevealB', [
      Math.max(0, PHASE_MODES.indexOf(c.phase)),
      Math.max(0, EASE_MODES.indexOf(c.ease)),
      this.reduced ? 1 : c.seedScale,
      this.reduced ? 0 : c.opacityLead,
    ]);
    mat.setParameter('uRevealC', [
      this.reduced ? 0 : c.disp,
      Math.max(0, DISP_MODES.indexOf(c.dispMode)),
      this.reduced ? 0 : c.tintStrength,
      this.reduced ? 0 : c.seedAlphaFloor,
    ]);
    const [tr, tg, tb] = hexToRgb(c.tint);
    mat.setParameter('uRevealTint', [tr, tg, tb, this.reduced ? 1 : c.seedGate]);

    if (b) {
      mat.setParameter('uRevealMin', [b.min.x, b.min.y, b.min.z, this.invHeight]);
      mat.setParameter('uRevealOrg', [this.origin.x, this.origin.y, this.origin.z, this.invRadial]);
    } else {
      mat.setParameter('uRevealMin', [0, 0, 0, 1]);
      mat.setParameter('uRevealOrg', [0, 0, 0, 1]);
    }

    const cp = this.camera.getPosition();
    this.scratchCam.copy(cp);
    mat.setParameter('uRevealCam', [cp.x, cp.y, cp.z, this.invCamRange]);
  }

  /**
   * Backdrop crossfade. The brand argument is for revealing against paper
   * (#efeae2) rather than the black void every other 3DGS viewer uses, but the
   * shipped viewer window is a deliberate dark shell (#14100c) with its whole
   * chrome designed against it — so seed and rest colours are both parameters
   * and the crossfade between them is the thing to tune.
   */
  private pushBackdrop(): void {
    const cam = this.camera.camera;
    if (!cam) return;
    const bd = this.backdrop;
    const [sr, sg, sb] = hexToRgb(bd.seedColor);
    const [fr, fg, fb] = hexToRgb(bd.finalColor);
    const k = bd.crossfade <= 0 ? 1 : Math.min(1, this.p / bd.crossfade);
    const m = this.running ? k : 1;
    this.scratchColor.set(sr + (fr - sr) * m, sg + (fg - sg) * m, sb + (fb - sb) * m, 1);
    cam.clearColor = this.scratchColor;
  }
}
