/* ============================================================================
   splatpick.ts — snap authoring picks to the actual splat data (author mode).
   ----------------------------------------------------------------------------
   WHY: a hero anchor authored from the orbit target usually floats slightly
   off the gear's surface. The dot is then projected from a 3D point that is
   in front of / behind the geometry, so it parallax-slides across the object
   as the camera zooms or orbits. Snapping the anchor to the nearest splat
   CENTER along the pick ray pins it to the captured surface exactly.

   HOW: the SOG bundle stores splat means as two 8-bit webp textures
   (means_l/means_u = low/high bytes of a 16-bit value per axis), normalized
   over meta.json's mins/maxs in LOG space. This mirrors the engine's decode:
       n = (low + high·256) / 65535
       v = lerp(mins, maxs, n)
       center = sign(v) · (e^|v| − 1)
   ~500k points ≈ 6 MB of Float32 — fine for an authoring-only tool. Never
   loaded for visitors (main.ts only calls load() in ?author mode).
   ========================================================================== */

import { Mat4, Vec3 } from 'playcanvas';

interface SogMeta {
  count: number;
  means: { mins: number[]; maxs: number[]; files: string[] };
}

export class SplatPicker {
  private positions: Float32Array | null = null;
  private loadedUrl = '';

  private invMat = new Mat4();
  private tmpO = new Vec3();
  private tmpD = new Vec3();
  private tmpP = new Vec3();

  get ready(): boolean {
    return this.positions !== null;
  }

  /** Fetch + decode the SOG means for a scene (idempotent per URL). */
  async load(metaUrl: string): Promise<void> {
    if (this.loadedUrl === metaUrl && this.positions) return;
    this.positions = null;
    this.loadedUrl = metaUrl;

    const meta = (await (await fetch(metaUrl)).json()) as SogMeta;
    const { mins, maxs, files } = meta.means;
    const base = new URL(metaUrl, location.href);
    const [lo, hi] = await Promise.all(
      files.map((f) => SplatPicker.readImage(new URL(f, base).toString())),
    );

    const count = meta.count;
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const px = i * 4; // RGBA texels; xyz live in rgb
      for (let c = 0; c < 3; c++) {
        const n = (lo.data[px + c] + hi.data[px + c] * 256) / 65535;
        const v = mins[c] + (maxs[c] - mins[c]) * n;
        out[i * 3 + c] = Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
      }
    }
    // A newer load may have started while we decoded — don't clobber it.
    if (this.loadedUrl === metaUrl) this.positions = out;
  }

  /**
   * Nearest splat along a world-space ray. tanRadius is the angular pick
   * radius (tan of the half-angle — i.e. a screen-space tolerance). Within
   * that cone the CLOSEST point along the ray wins, so the pick lands on the
   * first surface the ray meets rather than something behind it. If nothing
   * falls inside the cone, falls back to the smallest angular miss.
   * worldTransform is the splat entity's transform (the 180° roll etc.) —
   * the ray is taken into local space and the result returned in world space.
   */
  pick(
    originWorld: Vec3,
    dirWorld: Vec3,
    tanRadius: number,
    worldTransform: Mat4,
  ): [number, number, number] | null {
    const pos = this.positions;
    if (!pos) return null;

    this.invMat.copy(worldTransform).invert();
    const o = this.invMat.transformPoint(originWorld, this.tmpO);
    const d = this.invMat.transformVector(dirWorld, this.tmpD).normalize();

    const r2 = tanRadius * tanRadius;
    let bestT = Infinity;
    let bestIdx = -1;
    let bestMiss = Infinity;
    let bestMissIdx = -1;

    for (let i = 0; i < pos.length; i += 3) {
      const wx = pos[i] - o.x;
      const wy = pos[i + 1] - o.y;
      const wz = pos[i + 2] - o.z;
      const t = wx * d.x + wy * d.y + wz * d.z;
      if (t < 0.05) continue; // behind or on top of the camera
      const perp2 = wx * wx + wy * wy + wz * wz - t * t;
      const angular2 = perp2 / (t * t); // ≈ tan²(angle off the ray)
      if (angular2 < r2) {
        if (t < bestT) {
          bestT = t;
          bestIdx = i;
        }
      } else if (angular2 < bestMiss) {
        bestMiss = angular2;
        bestMissIdx = i;
      }
    }

    const idx = bestIdx >= 0 ? bestIdx : bestMissIdx;
    if (idx < 0) return null;
    this.tmpP.set(pos[idx], pos[idx + 1], pos[idx + 2]);
    worldTransform.transformPoint(this.tmpP, this.tmpP);
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return [round(this.tmpP.x), round(this.tmpP.y), round(this.tmpP.z)];
  }

  private static async readImage(url: string): Promise<ImageData> {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    const cnv = document.createElement('canvas');
    cnv.width = bmp.width;
    cnv.height = bmp.height;
    const ctx = cnv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  }
}
