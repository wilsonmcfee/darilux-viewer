/* ============================================================================
   reveal/config.ts — the reveal's parameter surface, and nothing else.
   ----------------------------------------------------------------------------
   This file is the contract between reveal-lab and production. The lab writes
   a RevealConfig; `driver.ts` consumes one; `__logReveal()` prints one. When the
   lab converges, the printed object becomes DEFAULTS here and the lab has done
   its job.

   Every field below is a live uniform, NOT a shader define — see shader.ts for
   why that matters (defines recompile; uniforms do not, and a recompiling
   dropdown makes a parameter explorer useless).

   Two fields are exceptions and are called out where they appear:
   `antiAlias` is a shader define, and `minPixelSize` is an engine material
   parameter rather than one of ours. Both exist here because the reveal is
   impossible without them — see the header of driver.ts.
   ========================================================================== */

export type PhaseMode = 'vertical' | 'radial-xz' | 'camera-distance' | 'hash';
export type EaseMode = 'cubic' | 'quint' | 'back' | 'expo';
export type DispMode = 'outward' | 'from-camera' | 'gravity';
export type TimingMode = 'theatrical' | 'honest' | 'hybrid';

/** Shader-side ordinals. Order is load-bearing — shader.ts branches on these. */
export const PHASE_MODES: PhaseMode[] = ['vertical', 'radial-xz', 'camera-distance', 'hash'];
export const EASE_MODES: EaseMode[] = ['cubic', 'quint', 'back', 'expo'];
export const DISP_MODES: DispMode[] = ['outward', 'from-camera', 'gravity'];

export interface RevealConfig {
  // ---- Phase: WHEN each splat starts. All the character lives here. --------
  /** Which structured sweep drives phase before the hash is blended in. */
  phase: PhaseMode;
  /**
   * How much hash to mix into the structured sweep. The single biggest quality
   * lever in the feature: at 0 a structured sweep is a hard plane sliding
   * through the room; at 0.2–0.3 the plane becomes a soft advancing front.
   */
  hashBlend: number; // 0..1
  /**
   * How far the front is smeared across space, in units of `duration`. At 0
   * every splat blooms at once; at 1 the last splat starts as the first
   * finishes. Total reveal wall time is duration * (1 + spread).
   */
  spread: number; // 0..1

  // ---- Curve ---------------------------------------------------------------
  duration: number; // seconds, per-splat bloom length
  ease: EaseMode;

  // ---- Scale / opacity ----------------------------------------------------
  /** World-scale multiplier at t=0. The "dot" size. */
  seedScale: number; // 0..1
  /** How far ahead of the scale curve the alpha curve runs, in t units. */
  opacityLead: number; // 0..0.5
  /**
   * Minimum alpha applied while a splat is still small, decaying to nothing as
   * it reaches full size. Not cosmetic: the engine multiplies alpha by an AA
   * factor that goes to zero with the splat's projected area, and then shrinks
   * the quad again in `clipCorner` when alpha approaches the clip threshold.
   * Without a floor here the seed state is not dots — it is nothing.
   */
  seedAlphaFloor: number; // 0..1
  /**
   * How much of `seedAlphaFloor` a splat gets before its own phase window opens.
   * At 1 every splat in the scene is a visible dot from the first frame — on a
   * 2.5M-splat room that reads as fog rather than a point cloud, because
   * millions of 1px quads blending over a 1MP viewport saturate it, and it costs
   * real frame time. At 0 the bloom is a genuine advancing front with empty
   * space ahead of it and the GPU only pays for splats actually in flight.
   * With any structured phase function this is the difference between "the room
   * assembles itself" and "the room fades up".
   */
  seedGate: number; // 0..1

  // ---- Displacement (optional; degrades sort order — see driver.ts) --------
  /** World units of offset at t=0. Coupled to (1-e), so it is zero at rest. */
  disp: number;
  dispMode: DispMode;

  // ---- Colour -------------------------------------------------------------
  /** Seed tint as an sRGB hex string. Resolves to true colour as e → 1. */
  tint: string;
  tintStrength: number; // 0..1

  // ---- Engine-level levers the effect cannot work without -----------------
  /**
   * Engine default is 2. `initCornerCov` DISCARDS any splat whose projected
   * size falls below this, and covariance dilation floors a zero-scale splat at
   * roughly 1.55px — so at the default a seed state simply vanishes.
   */
  minPixelSize: number;
  /**
   * GSPLAT_AA. On, `aaFactor = sqrt(detOrig/detBlur)` crushes the alpha of
   * sub-pixel splats. Off, tiny splats keep their alpha and read as dots.
   * This one is a shader DEFINE — toggling it recompiles.
   */
  antiAlias: boolean;

  // ---- Timing policy ------------------------------------------------------
  timing: TimingMode;
  /** Hybrid's floor: the reveal never runs shorter than this. Seconds. */
  durationFloor: number;
  /**
   * How much the duration shrinks per second of measured load time, seconds
   * per second. Positive values SHORTEN the reveal on a slow load — a visitor
   * who already waited eight seconds does not want a longer animation. See the
   * timing note in driver.ts.
   */
  loadTimeSlope: number;
  /** Milliseconds after the veil starts fading before the reveal begins. */
  veilHandoff: number;
}

export interface BackdropConfig {
  /** Clear colour at e = 0. The brand argument is for paper, not black. */
  seedColor: string;
  /** Clear colour at e = 1 — the shipped viewer shell. */
  finalColor: string;
  /** Fraction of the reveal over which seed → final happens. 0 disables. */
  crossfade: number;
}

/**
 * Starting point, not a converged answer. `spread` and `hashBlend` are the two
 * to move first; everything else is scaffolding around them.
 */
export const DEFAULTS: RevealConfig = {
  phase: 'vertical',
  hashBlend: 0.25,
  spread: 0.6,
  duration: 2.6,
  ease: 'cubic',
  seedScale: 0.06,
  opacityLead: 0.12,
  seedAlphaFloor: 0.12,
  seedGate: 0.15,
  disp: 0,
  dispMode: 'outward',
  tint: '#b8392e', // --accent
  tintStrength: 0.15,
  minPixelSize: 1.0,
  antiAlias: false,
  timing: 'theatrical',
  durationFloor: 1.5,
  loadTimeSlope: 0.12,
  veilHandoff: 180,
};

export const BACKDROP_DEFAULTS: BackdropConfig = {
  seedColor: '#efeae2', // --paper
  finalColor: '#14100c', // --shell
  crossfade: 1.0,
};

/** '#efeae2' → [0.937, 0.918, 0.886]. Tolerates a missing '#'. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
