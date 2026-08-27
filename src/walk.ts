/* ============================================================================
   walk.ts — the walkable region, and the constraint that keeps a visitor in it.
   ----------------------------------------------------------------------------
   Per WALK_IMPLEMENTATION_BRIEF §4-§5. Two ideas carry the whole module:

   1. THE REGION IS A SIGNED DISTANCE FIELD, positive inside. Composed from an
      outer ring, optional inner rings (plan-fill holes: alcoves, architecture)
      and optional oriented rects (island furniture), all combined with min():

        d(p) = min( sdPoly(outer),
                    min over innerRings: -sdPoly(ring),
                    min over holes:       sdRect(hole) - hole.pad )

      A distance field rather than a hit test, because the falloff needs the
      distance anyway — and once you have it the normal is a finite difference,
      so there is nothing else left to build.

   2. ONLY THE INWARD NORMAL COMPONENT IS DAMPED. Sliding along a wall stays at
      full speed; pushing into it decays asymptotically and never quite arrives.
      Damping the whole velocity vector is what makes movement near a wall feel
      like wading through tar — the exact thing this design exists to avoid.

   The boundary is never drawn and is never a hard stop. Tuned right, nobody
   notices a limit; they simply lose interest in that direction.

   UNITS — the likeliest bug in this module, per the brief. Regions are AUTHORED
   in viewer world units, so a polygon sits in demos.ts in the same numbers as
   the poses beside it. Everything in here is METRES, because every tuning
   constant (falloff, pads, margins) is metric. So the rings are converted once
   in the constructor and never again, and the public methods convert at the
   boundary. No other function in this file sees a world unit.
   ========================================================================== */

import type { WalkRegion } from './types';

const smoothstep = (edge: number, x: number): number => {
  if (edge <= 0) return x > 0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, x / edge));
  return t * t * (3 - 2 * t);
};

/** Even-odd ray crossing. Orientation-independent, so ring winding is free. */
function pointInRing(r: Float64Array, x: number, z: number): boolean {
  let inside = false;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1];
    const xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Unsigned distance from (x, z) to a closed polyline. */
function ringDistance(r: Float64Array, x: number, z: number): number {
  let best = Infinity;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1];
    const ex = r[j * 2] - xi, ez = r[j * 2 + 1] - zi;
    const px = x - xi, pz = z - zi;
    const L = ex * ex + ez * ez;
    const t = L > 0 ? Math.max(0, Math.min(1, (px * ex + pz * ez) / L)) : 0;
    const dx = px - ex * t, dz = pz - ez * t;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

interface Rect {
  cx: number; cz: number; hx: number; hz: number; cos: number; sin: number; pad: number;
}

/** A falloff zone, converted to metres and normalised so min < max. */
interface Zone { x0: number; z0: number; x1: number; z1: number; falloff: number }

/** Standard 2D oriented-rect SDF: positive outside, negative inside. */
function sdRect(h: Rect, x: number, z: number): number {
  const dx = x - h.cx, dz = z - h.cz;
  const qx = Math.abs(dx * h.cos + dz * h.sin) - h.hx;
  const qz = Math.abs(-dx * h.sin + dz * h.cos) - h.hz;
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0);
}

export class WalkConstraint {
  private outer: Float64Array;
  private inners: Float64Array[] = [];
  private rects: Rect[] = [];
  private zones: Zone[] = [];
  private upm: number;
  private n = { x: 0, z: 0 };

  readonly falloff: number;
  readonly spawnMargin: number;
  /** Times the §5 backstop fired. Brief §8.4: should stay 0 in normal play. */
  backstops = 0;

  constructor(region: WalkRegion, unitsPerMetre: number) {
    this.upm = unitsPerMetre;
    const toMetres = (ring: [number, number][]): Float64Array => {
      const a = new Float64Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        a[i * 2] = ring[i][0] / unitsPerMetre;
        a[i * 2 + 1] = ring[i][1] / unitsPerMetre;
      }
      return a;
    };
    this.outer = toMetres(region.outer);
    for (const r of region.innerRings ?? []) this.inners.push(toMetres(r));
    for (const h of region.holes ?? []) {
      const a = ((h.angleDeg ?? 0) * Math.PI) / 180;
      this.rects.push({
        cx: h.centre[0] / unitsPerMetre,
        cz: h.centre[1] / unitsPerMetre,
        hx: h.halfExtent[0] / unitsPerMetre,
        hz: h.halfExtent[1] / unitsPerMetre,
        cos: Math.cos(a),
        sin: Math.sin(a),
        pad: h.pad ?? 0,
      });
    }
    for (const z of region.falloffZones ?? []) {
      const xs = [z.min[0] / unitsPerMetre, z.max[0] / unitsPerMetre];
      const zs = [z.min[1] / unitsPerMetre, z.max[1] / unitsPerMetre];
      this.zones.push({
        x0: Math.min(...xs), x1: Math.max(...xs),
        z0: Math.min(...zs), z1: Math.max(...zs),
        falloff: z.falloff,
      });
    }
    this.falloff = region.falloff ?? 0.25;
    this.spawnMargin = region.spawnMargin ?? 0.3;
  }

  /** Signed distance in metres at a METRIC point. Positive inside. */
  private sd(x: number, z: number): number {
    let d = (pointInRing(this.outer, x, z) ? 1 : -1) * ringDistance(this.outer, x, z);
    for (const r of this.inners) {
      // -sdPoly(ring): an inner ring's INTERIOR is outside the walkable region.
      const s = (pointInRing(r, x, z) ? 1 : -1) * ringDistance(r, x, z);
      if (-s < d) d = -s;
    }
    for (const r of this.rects) {
      // Unpadded distance minus the pad, which is what inflating a hole means.
      const s = sdRect(r, x, z) - r.pad;
      if (s < d) d = s;
    }
    return d;
  }

  /** Effective falloff at a metric point: the tightest zone containing it. */
  private falloffAt(x: number, z: number): number {
    let f = this.falloff;
    for (const zn of this.zones) {
      if (x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1 && zn.falloff < f) {
        f = zn.falloff;
      }
    }
    return f;
  }

  /** Signed distance in METRES at a WORLD (x, z). Positive inside. */
  distanceAt(wx: number, wz: number): number {
    return this.sd(wx / this.upm, wz / this.upm);
  }

  /** Falloff in force at a WORLD (x, z) — the global value, or a zone's. */
  falloffAtWorld(wx: number, wz: number): number {
    return this.falloffAt(wx / this.upm, wz / this.upm);
  }

  /**
   * Inward unit normal at a metric point, by finite difference rather than by
   * tracking the closest feature analytically — cheaper to write, and correct
   * across the min() seams where an analytic normal gets fiddly.
   */
  private grad(x: number, z: number, out: { x: number; z: number }): void {
    const e = 0.01;
    const nx = this.sd(x + e, z) - this.sd(x - e, z);
    const nz = this.sd(x, z + e) - this.sd(x, z - e);
    const L = Math.hypot(nx, nz);
    if (L < 1e-9) {
      out.x = 0;
      out.z = 0;
      return;
    }
    // Points toward increasing distance, i.e. INWARD.
    out.x = nx / L;
    out.z = nz / L;
  }

  /**
   * Constrain a world-unit displacement made from a world-unit position, and
   * write the allowed displacement back into `move`. Returns the signed
   * distance at the START point, in metres (negative = the caller was outside).
   */
  applyMove(wx: number, wz: number, move: { x: number; z: number }): number {
    const x = wx / this.upm, z = wz / this.upm;
    let dx = move.x / this.upm, dz = move.z / this.upm;
    const d = this.sd(x, z);
    this.grad(x, z, this.n);
    const nx = this.n.x, nz = this.n.z;

    if (nx !== 0 || nz !== 0) {
      const along = dx * nx + dz * nz;
      // along < 0 means moving TOWARD the boundary. Scale only that component;
      // the tangential remainder is never touched, which is exactly what keeps
      // a slide along a wall at full speed.
      if (along < 0) {
        const delta = along * smoothstep(this.falloffAt(x, z), d) - along;
        dx += delta * nx;
        dz += delta * nz;
      }
    }

    // Backstop. smoothstep decays but never reaches zero, and a long frame or a
    // mode transition can still carry someone OUT. Project back along the normal.
    // Brief §8.4: if this fires every frame, the falloff is mistuned.
    //
    // Guarded on d >= 0 — it may only rescue a move that LEFT the region, never
    // relocate a camera that was already outside. Without the guard it fires
    // every frame of an arrival (the opening shot is authored 0.42 m out on
    // Bluedio), teleporting the visitor onto the boundary and fighting the very
    // ease that is bringing them in. Coming in from outside is nearestInside()'s
    // job, and outward motion is already fully damped out there anyway, because
    // smoothstep of a negative distance is 0.
    let px = x + dx, pz = z + dz;
    const after = this.sd(px, pz);
    if (after < 0 && d >= 0) {
      this.backstops++;
      this.grad(px, pz, this.n);
      px += this.n.x * -after;
      pz += this.n.z * -after;
    }

    move.x = (px - x) * this.upm;
    move.z = (pz - z) * this.upm;
    return d;
  }

  /**
   * Nearest point comfortably inside the region, in WORLD units — for a camera
   * that has to be brought in from outside. Marches along the gradient, which
   * converges quickly because |grad| is ~1 for a distance field.
   */
  nearestInside(wx: number, wz: number, out: { x: number; z: number }): boolean {
    let x = wx / this.upm, z = wz / this.upm;
    let ok = false;
    for (let i = 0; i < 96; i++) {
      const d = this.sd(x, z);
      if (d >= this.spawnMargin) {
        ok = true;
        break;
      }
      this.grad(x, z, this.n);
      if (this.n.x === 0 && this.n.z === 0) break;
      const step = Math.min(this.spawnMargin - d, 0.25);
      x += this.n.x * step;
      z += this.n.z * step;
    }
    out.x = x * this.upm;
    out.z = z * this.upm;
    return ok;
  }
}
