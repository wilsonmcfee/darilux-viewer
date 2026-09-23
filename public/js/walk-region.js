// The walkable region, and the constraint that keeps a visitor inside it. Ported from the
// Bluedio viewer (C:\dev\darilux\viewer\src\nav\walk.ts) so both viewers share one model:
//
//   1. The region is a signed distance field, positive inside: an outer ring, minus any inner
//      rings (alcoves, architecture) and padded oriented rects (island furniture).
//        d(p) = min( sdPoly(outer), min -sdPoly(ring), min sdRect(hole) - hole.pad )
//   2. Only the inward normal component of a move is damped, by smoothstep(0, falloff, d).
//      Sliding along a wall stays full speed; pushing into it decays and never quite arrives.
//      The boundary is never drawn and is never a hard stop.
//
// Units: rings are authored in viewer world units (the same numbers as the poses beside them);
// every distance inside the region (falloff, pads, margins) is in metres. Rings are converted to
// metres once, here, and the public methods convert at the boundary.

const smoothstep = (edge, x) => {
    if (edge <= 0) return x > 0 ? 1 : 0;
    const t = Math.max(0, Math.min(1, x / edge));
    return t * t * (3 - 2 * t);
};

// even-odd ray crossing, so ring winding doesn't matter
function pointInRing(r, x, z) {
    let inside = false;
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = r[i * 2], zi = r[i * 2 + 1];
        const xj = r[j * 2], zj = r[j * 2 + 1];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

function ringDistance(r, x, z) {
    let best = Infinity;
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = r[i * 2], zi = r[i * 2 + 1];
        const ex = r[j * 2] - xi, ez = r[j * 2 + 1] - zi;
        const px = x - xi, pz = z - zi;
        const L = ex * ex + ez * ez;
        const t = L > 0 ? Math.max(0, Math.min(1, (px * ex + pz * ez) / L)) : 0;
        const dx = px - ex * t, dz = pz - ez * t;
        best = Math.min(best, dx * dx + dz * dz);
    }
    return Math.sqrt(best);
}

// 2D oriented-rect SDF: positive outside, negative inside
function sdRect(h, x, z) {
    const dx = x - h.cx, dz = z - h.cz;
    const qx = Math.abs(dx * h.cos + dz * h.sin) - h.hx;
    const qz = Math.abs(-dx * h.sin + dz * h.cos) - h.hz;
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

export class WalkRegion {
    backstops = 0;              // times the backstop fired; should stay 0 in normal play

    // region = { outer, innerRings?, holes?, falloff?, falloffZones?, spawnMargin? }
    constructor(region, unitsPerMetre = 1) {
        const upm = unitsPerMetre;
        this.upm = upm;
        const toMetres = (ring) => Float64Array.from(ring.flat(), (v) => v / upm);
        this.outer = toMetres(region.outer);
        this.inners = (region.innerRings ?? []).map(toMetres);
        this.rects = (region.holes ?? []).map((h) => {
            const a = ((h.angleDeg ?? 0) * Math.PI) / 180;
            return {
                cx: h.centre[0] / upm, cz: h.centre[1] / upm,
                hx: h.halfExtent[0] / upm, hz: h.halfExtent[1] / upm,
                cos: Math.cos(a), sin: Math.sin(a), pad: h.pad ?? 0
            };
        });
        this.zones = (region.falloffZones ?? []).map((z) => ({
            x0: Math.min(z.min[0], z.max[0]) / upm, x1: Math.max(z.min[0], z.max[0]) / upm,
            z0: Math.min(z.min[1], z.max[1]) / upm, z1: Math.max(z.min[1], z.max[1]) / upm,
            falloff: z.falloff
        }));
        this.falloff = region.falloff ?? 0.25;
        this.spawnMargin = region.spawnMargin ?? 0.3;
        this._n = { x: 0, z: 0 };
    }

    // signed distance in metres at a metric point, positive inside
    _sd(x, z) {
        let d = (pointInRing(this.outer, x, z) ? 1 : -1) * ringDistance(this.outer, x, z);
        for (const r of this.inners) {
            const s = (pointInRing(r, x, z) ? 1 : -1) * ringDistance(r, x, z);
            d = Math.min(d, -s);
        }
        for (const r of this.rects) d = Math.min(d, sdRect(r, x, z) - r.pad);
        return d;
    }

    _falloffAt(x, z) {
        let f = this.falloff;
        for (const zn of this.zones) {
            if (x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1) f = Math.min(f, zn.falloff);
        }
        return f;
    }

    // inward unit normal by finite difference: correct across the min() seams for free
    _grad(x, z, out) {
        const e = 0.01;
        const nx = this._sd(x + e, z) - this._sd(x - e, z);
        const nz = this._sd(x, z + e) - this._sd(x, z - e);
        const L = Math.hypot(nx, nz);
        out.x = L < 1e-9 ? 0 : nx / L;
        out.z = L < 1e-9 ? 0 : nz / L;
    }

    // signed distance in metres at a world (x, z)
    distanceAt(wx, wz) {
        return this._sd(wx / this.upm, wz / this.upm);
    }

    // Constrain a world-unit move made from a world-unit position; writes the allowed move back
    // into `move` and returns the signed distance (metres) at the start point.
    applyMove(wx, wz, move) {
        const x = wx / this.upm, z = wz / this.upm;
        let dx = move.x / this.upm, dz = move.z / this.upm;
        const d = this._sd(x, z);
        const n = this._n;
        this._grad(x, z, n);

        const along = dx * n.x + dz * n.z;
        if (along < 0) {
            // only the component heading into the boundary is scaled
            const delta = along * smoothstep(this._falloffAt(x, z), d) - along;
            dx += delta * n.x;
            dz += delta * n.z;
        }

        // Backstop for a long frame that still carries someone out. Guarded on d >= 0: it may
        // rescue a move that left the region, never relocate a camera that was already outside.
        let px = x + dx, pz = z + dz;
        const after = this._sd(px, pz);
        if (after < 0 && d >= 0) {
            this.backstops++;
            this._grad(px, pz, n);
            px -= n.x * after;
            pz -= n.z * after;
        }

        move.x = (px - x) * this.upm;
        move.z = (pz - z) * this.upm;
        return d;
    }

    // Nearest point comfortably inside (spawnMargin in), in world units, for a camera that has to
    // be brought in from outside. Marches along the gradient; |grad| ~ 1 so it converges fast.
    nearestInside(wx, wz, out = { x: 0, z: 0 }) {
        let x = wx / this.upm, z = wz / this.upm;
        let ok = false;
        for (let i = 0; i < 96; i++) {
            const d = this._sd(x, z);
            if (d >= this.spawnMargin - 1e-6) { ok = true; break; }
            this._grad(x, z, this._n);
            // dead centre of a symmetric hole has no gradient; any nudge breaks the tie
            if (this._n.x === 0 && this._n.z === 0) { x += 0.02; continue; }
            const step = Math.min(this.spawnMargin - d, 0.25);
            x += this._n.x * step;
            z += this._n.z * step;
        }
        out.x = x * this.upm;
        out.z = z * this.upm;
        out.ok = ok;
        return out;
    }
}
