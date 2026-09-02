/* ============================================================================
   gsplatinternals.ts — the ONE file that reaches past the engine's public API.
   ----------------------------------------------------------------------------
   WHY THIS FILE EXISTS

   The 2026-09-02 profiling pass (TEMPLATE.md → "Performance → Profiled
   2026-09-02") found that on the WebGL2 path the single largest main-thread
   cost is the engine uploading the depth-sort result: every completed sort
   re-specifies the whole splat ORDER TEXTURE with one texImage2D — 11.67 MB for
   the 2.53M asset — and a walking camera completes a sort as fast as the worker
   can produce one, about 27 a second. The upload itself is a ~1 ms memcpy on
   an idle GPU and 5-18 ms on a saturated one, because texImage2D is the one
   point in the frame where the main thread waits for the GPU's queue.

   The engine decides WHEN to re-sort with a hard-coded epsilon of 1e-3 (a
   third of a millimetre of translation with radial sorting, 0.057° of rotation
   without), in GSplatManager.testCameraMovedForSort(). There is no public knob
   for it — `lodUpdateDistance` / `lodUpdateAngle` exist for the LOD test, but
   nothing equivalent for the sort — so the only way to change the cadence is
   to replace that method on the live manager. That is what installSortGate()
   does. It is the one deliberate reach into engine internals in this codebase,
   and everything else that needs the same internals (the HUD's bake counter,
   the `?pbo` upload-path A/B) goes through this file so there is exactly one
   place to fix when the engine's shape changes.

   HOW IT STAYS SAFE ACROSS ENGINE UPGRADES

   Every access is feature-detected: if any object on the path
   `app.renderer.gsplatDirector.camerasMap → layersMap → gsplatManager` is
   missing or the method is not a function, the helpers do nothing and say so
   ONCE in the console. A viewer on a newer engine therefore loses the tuning
   and keeps rendering — it never throws in the frame loop. Re-check this file
   against `playcanvas.mjs` on every engine bump: grep `testCameraMovedForSort`,
   `lastSortCameraPos`, `renderColor`, `useSingleBuffer`.

   Managers are created LAZILY (the first frame a gsplat is in view) and
   re-created when the renderer mode or camera set changes, so discovery is
   not a one-off: tick() is called every frame from main.ts and re-patches
   whatever is new. A Map iteration over one camera and one or two layers —
   microseconds.
   ========================================================================== */

import type { AppBase } from 'playcanvas';
import { logTag } from './brand';

/* The minimum shapes this file relies on, spelled out so a mismatch is a type
   error here rather than a runtime surprise. Everything is `unknown`-checked at
   the point of use regardless. */
interface Vec3Like {
  x: number;
  distance(v: Vec3Like): number;
  dot(v: Vec3Like): number;
}
interface WorkBufferLike {
  renderColor?: (...args: unknown[]) => unknown;
  render?: (...args: unknown[]) => unknown;
  uploadStream?: { useSingleBuffer?: boolean; impl?: { useSingleBuffer?: boolean } };
}
export interface GsplatManagerLike {
  testCameraMovedForSort?: () => boolean;
  lastSortCameraPos?: Vec3Like;
  lastSortCameraFwd?: Vec3Like;
  cameraNode?: { getPosition(): Vec3Like; forward: Vec3Like };
  scene?: { gsplat?: { radialSorting?: boolean } };
  world?: { workBuffer?: WorkBufferLike };
}

let warned = false;
function warnOnce(what: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    `${logTag()} engine internals moved (${what}); sort gate / bake counter / ?pbo are off. ` +
      'See src/core/gsplatinternals.ts.',
  );
}

/**
 * Every live GSplatManager (one per camera × layer that holds a gsplat).
 * Empty until the first frame a splat is rendered; empty forever, with one
 * console warning, if the engine no longer looks like 2.21.
 */
export function findGsplatManagers(app: AppBase): GsplatManagerLike[] {
  const out: GsplatManagerLike[] = [];
  const director = (app.renderer as unknown as { gsplatDirector?: unknown }).gsplatDirector as
    | { camerasMap?: Map<unknown, { layersMap?: Map<unknown, { gsplatManager?: unknown }> }> }
    | undefined;
  if (!director) return out; // nothing rendered yet — normal before the first frame
  if (!(director.camerasMap instanceof Map)) {
    warnOnce('gsplatDirector.camerasMap');
    return out;
  }
  for (const cameraData of director.camerasMap.values()) {
    const layers = cameraData?.layersMap;
    if (!(layers instanceof Map)) continue;
    for (const layerData of layers.values()) {
      const mgr = layerData?.gsplatManager;
      if (mgr && typeof mgr === 'object') out.push(mgr as GsplatManagerLike);
    }
  }
  return out;
}

/* ---- The sort gate ------------------------------------------------------- */

export interface SortGateThresholds {
  /** Metres of camera translation before a radial re-sort; 0 = engine stock (1e-3 units). */
  distanceMetres: number;
  /** Degrees of camera rotation before a directional re-sort; 0 = engine stock (0.057°). */
  angleDegrees: number;
  /** Scene units per metre, so the metre threshold lands in the scene's own scale. */
  unitsPerMetre: number;
}

const patchedManagers = new WeakSet<object>();

/**
 * Replace the engine's re-sort trigger with one whose thresholds are ours.
 *
 * Only the CAMERA test is replaced. Every other reason the engine has to sort —
 * a new world version, a work-buffer rebuild, a renderer change — still sets
 * `sortNeeded` exactly as before, so the first sort after a scene lands, and
 * every structural re-sort, are untouched.
 *
 * Inert on WebGPU by construction: the hybrid renderer sorts on the GPU every
 * frame and never consults this test, so the gate costs nothing there and
 * changes nothing.
 *
 * `read()` is called on every test rather than captured, so the knobs can be
 * turned live from the console without re-patching.
 */
export function installSortGate(app: AppBase, read: () => SortGateThresholds): void {
  for (const mgr of findGsplatManagers(app)) {
    if (patchedManagers.has(mgr)) continue;
    const orig = mgr.testCameraMovedForSort;
    if (
      typeof orig !== 'function' ||
      !mgr.lastSortCameraPos ||
      !mgr.lastSortCameraFwd ||
      !mgr.cameraNode ||
      !mgr.scene?.gsplat
    ) {
      warnOnce('GSplatManager.testCameraMovedForSort');
      return;
    }
    patchedManagers.add(mgr);
    mgr.testCameraMovedForSort = function (this: GsplatManagerLike): boolean {
      const t = read();
      const cam = this.cameraNode!;
      if (this.scene!.gsplat!.radialSorting) {
        const eps = t.distanceMetres * t.unitsPerMetre;
        if (!(eps > 0)) return orig.call(this);
        // Before the first sort lastSortCameraPos is (∞,∞,∞): distance is ∞,
        // the test passes, exactly as the engine's own version does.
        return this.lastSortCameraPos!.distance(cam.getPosition()) > eps;
      }
      const ang = (t.angleDegrees * Math.PI) / 180;
      if (!(ang > 0)) return orig.call(this);
      const last = this.lastSortCameraFwd!;
      if (!Number.isFinite(last.x)) return true;
      const dot = Math.min(1, Math.max(-1, last.dot(cam.forward)));
      return Math.acos(dot) > ang;
    };
  }
}

/* ---- Work-buffer hooks (diagnostics) -------------------------------------- */

export interface BakeCounters {
  /** Full colour re-bakes (the SH pass over every resident splat). */
  color: number;
  /** Geometry re-bakes (a splat's transform changed — rare in this viewer). */
  geometry: number;
}

const hookedBuffers = new WeakSet<object>();

/**
 * Count the work-buffer bake passes so the HUD can show them. Both passes run
 * on the GPU, so their cost is invisible to main-thread timing — the COUNT is
 * the only thing the page can observe, and it is the number that explains a
 * frame-time dip that no sort or upload accounts for.
 */
export function hookBakeCounters(app: AppBase, counters: BakeCounters): void {
  for (const mgr of findGsplatManagers(app)) {
    const wb = mgr.world?.workBuffer;
    if (!wb || hookedBuffers.has(wb)) continue;
    if (typeof wb.renderColor !== 'function' || typeof wb.render !== 'function') {
      warnOnce('GSplatWorkBuffer.renderColor');
      return;
    }
    hookedBuffers.add(wb);
    const color = wb.renderColor.bind(wb);
    const geometry = wb.render.bind(wb);
    wb.renderColor = (...args: unknown[]) => {
      counters.color++;
      return color(...args);
    };
    wb.render = (...args: unknown[]) => {
      counters.geometry++;
      return geometry(...args);
    };
  }
}

/**
 * Switch the WebGL2 order-texture upload between the engine's two paths.
 *
 *   'direct'  one texImage2D of the whole texture per sort — the engine's
 *             choice for WebGL, because the PBO path "stalls the main thread on
 *             multi-MB uploads through Chrome's renderer→GPU IPC" (engine
 *             source, gsplat-work-buffer.js). Measured here on Chrome/Windows:
 *             the PBO path was indeed WORSE (12 ms vs 6.7 ms mean main-thread
 *             frame while walking).
 *   'pbo'     PBO + texSubImage2D of only the rows that changed, with a fence.
 *
 * Exposed as `?pbo=1` for exactly one audience: a Firefox or non-Chrome
 * browser, where Chrome's IPC rationale does not apply and nobody has measured
 * which path wins. Returns whether the switch found anything to flip.
 */
export function setOrderUploadPath(app: AppBase, path: 'direct' | 'pbo'): boolean {
  let flipped = false;
  for (const mgr of findGsplatManagers(app)) {
    const us = mgr.world?.workBuffer?.uploadStream;
    if (!us || typeof us.useSingleBuffer !== 'boolean') continue;
    us.useSingleBuffer = path === 'direct';
    if (us.impl && typeof us.impl.useSingleBuffer === 'boolean') {
      us.impl.useSingleBuffer = path === 'direct';
    }
    flipped = true;
  }
  return flipped;
}
