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

export interface DeviceResult {
  device: GraphicsDevice;
  renderer: 'webgpu' | 'webgl2';
}

export async function createDevice(canvas: HTMLCanvasElement): Promise<DeviceResult> {
  const device = await createGraphicsDevice(canvas, {
    // Order = preference. Engine tries WebGPU, silently falls back to WebGL2.
    deviceTypes: [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
    antialias: false, // splats do their own edge softening; MSAA just costs memory
  });

  // Cap DPR at 2: retina phones would otherwise render 3× the pixels for a heavy
  // splat with little visible gain. Matches the starter's perf guard.
  device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

  const renderer: DeviceResult['renderer'] = device.isWebGPU ? 'webgpu' : 'webgl2';
  // Decided behavior: fall back SILENTLY (no "compatibility mode" label to the
  // client) but LOG the active renderer so we can confirm which path ran in testing.
  console.info(`[darilux] active renderer: ${renderer}`);

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
