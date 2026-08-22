#!/usr/bin/env python3
"""
autoscene — derive a room's walk envelope, hero points and a fly-in tour
straight from a .sog, with no manual annotation.

Run:  python3 autoscene.py --heroes 8

Coordinate contract
-------------------
The .sog is Y-down (up = -Y) and y=0 is the viewer's eye height (1.40 m).
Internally everything is metres, Y-up, floor at 0:

    x_m = x * S            y_m = (FLOOR_RAW - y) * S            z_m = z * S
    x   = x_m / S          y   = FLOOR_RAW - y_m / S            z   = z_m / S

Everything written to scene.json is already back in raw .sog coordinates, so it
can be pasted into demos.ts untouched.
"""
import json, argparse, math
import numpy as np
from scipy import ndimage
from skimage import measure

# ------------------------------------------------------------------ constants
S          = 1.0 / 3.0      # .sog units -> metres  (solved: y=0 is 1.40 m, floor at 4.20 u)
FLOOR_RAW  = 4.20           # .sog y of the floor plane
EYE        = 1.40           # viewer eye height (m)
CEIL       = 2.90           # solved ceiling height (m)

CELL       = 0.05           # plan grid (m)
BODY       = (0.30, 1.70)   # vertical band a body occupies -> blocks movement
GEAR       = (0.25, 2.20)   # vertical band gear lives in -> saliency
MIN_PTS    = 4              # points per cell before it counts as solid

TALL_TOP   = 1.30           # object top above this -> optical standoff
PAD_TALL   = 0.50
PAD_LOW    = 0.18
WALL_INSET = 0.50
MIN_CORRIDOR = 0.80

HERO_SEP   = 0.85           # min separation between hero points (m)
SEAT_MARGIN = 0.30          # keep the opening seat this far inside the walk region:
                            # falloff_m (0.35) damps motion near the boundary, so a
                            # seat on the edge spawns the visitor nearly immobilised
STANDOFF   = (0.55, 1.45)   # allowed hero standoff range (m)
HFOV       = math.radians(58.0)


# ------------------------------------------------------------------ scene grid
class Scene:
    def __init__(self, xyz="./xyz.npy", sh0="./sh0.npy"):
        X = np.load(xyz).astype(np.float64)
        C = np.clip(0.5 + 0.28209479 * np.load(sh0).astype(np.float64), 0, 1)
        M = np.stack([X[:, 0] * S, (FLOOR_RAW - X[:, 1]) * S, X[:, 2] * S], 1)
        keep = (np.abs(M[:, 0]) < 12) & (np.abs(M[:, 2]) < 12) & (M[:, 1] > -0.25) & (M[:, 1] < 4.0)
        self.M, self.C = M[keep], C[keep]

        self.x0, self.z0 = self.M[:, 0].min(), self.M[:, 2].min()
        nx = int((self.M[:, 0].max() - self.x0) / CELL) + 1
        nz = int((self.M[:, 2].max() - self.z0) / CELL) + 1
        self.shape = (nx, nz)
        self.ix = np.clip(((self.M[:, 0] - self.x0) / CELL).astype(int), 0, nx - 1)
        self.iz = np.clip(((self.M[:, 2] - self.z0) / CELL).astype(int), 0, nz - 1)
        self.flat = self.ix * nz + self.iz
        self._build()

    # --- helpers -----------------------------------------------------------
    def cell_of(self, x, z):
        return (int((x - self.x0) / CELL), int((z - self.z0) / CELL))

    def world_of(self, i, j):
        return (self.x0 + (np.asarray(i) + 0.5) * CELL,
                self.z0 + (np.asarray(j) + 0.5) * CELL)

    def _count(self, m):
        return np.bincount(self.flat[m], minlength=self.shape[0]*self.shape[1]).reshape(self.shape)

    def _stack_top(self, hmax=2.80, vb=0.05, gap=3):
        """Per cell, the height where the occupied column first breaks.
        Distinguishes a 1.1 m synth standing against a wall from the wall."""
        m = (self.M[:, 1] > 0.02) & (self.M[:, 1] < hmax)
        nb = int(hmax/vb)
        b = np.clip((self.M[m, 1]/vb).astype(int), 0, nb-1)
        vox = np.zeros(self.shape[0]*self.shape[1]*nb, np.int32)
        np.add.at(vox, self.flat[m]*nb + b, 1)
        vox = (vox.reshape(self.shape[0], self.shape[1], nb) >= 2)
        # only count empty runs ABOVE the column's lowest occupied bin, so a
        # keyboard on an open stand reports the keyboard, not the air beneath it
        anyocc_b = vox.any(-1)
        firstocc = np.where(anyocc_b, vox.argmax(-1), 0)
        below = np.arange(nb)[None, None, :] < firstocc[..., None]
        empt = ~vox & ~below
        run = np.zeros(vox.shape, np.int16)
        run[..., 0] = empt[..., 0]
        for k in range(1, nb):
            run[..., k] = np.where(empt[..., k], run[..., k-1] + 1, 0)
        brk = (run >= gap)
        first = np.where(brk.any(-1), brk.argmax(-1), nb-1)
        return np.where(anyocc_b, np.maximum(first - gap + 1, 0)*vb, 0.0)

    def _top(self, m):
        o = np.full(self.shape[0]*self.shape[1], 0.0)
        np.maximum.at(o, self.flat[m], self.M[m, 1])
        return o.reshape(self.shape)

    # --- fields and room ---------------------------------------------------
    def _build(self):
        body = (self.M[:, 1] > BODY[0]) & (self.M[:, 1] < BODY[1])
        gear = (self.M[:, 1] > GEAR[0]) & (self.M[:, 1] < GEAR[1])
        self.top  = self._stack_top()
        self.col_top = self._top(gear)          # raw column top, kept for reference
        self.dens = self._count(gear).astype(float)

        # colour spread per cell (visual interest, cheap proxy for "detailed gear")
        n  = np.bincount(self.flat[gear], minlength=self.shape[0]*self.shape[1])
        s1 = np.stack([np.bincount(self.flat[gear], weights=self.C[gear, c],
                                   minlength=self.shape[0]*self.shape[1]) for c in range(3)])
        s2 = np.stack([np.bincount(self.flat[gear], weights=self.C[gear, c]**2,
                                   minlength=self.shape[0]*self.shape[1]) for c in range(3)])
        nn = np.maximum(n, 1)
        var = np.clip(s2/nn - (s1/nn)**2, 0, None).mean(0)
        self.colvar = np.where(n > 8, np.sqrt(var), 0).reshape(self.shape)

        solid = ndimage.binary_closing(self._count(body) >= MIN_PTS, np.ones((3, 3)))
        self.solid = ndimage.binary_opening(solid, np.ones((2, 2)))

        lbl, k = ndimage.label(~self.solid)
        border = set(np.unique(np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]])))
        cand = [(np.count_nonzero(lbl == i), i) for i in range(1, k+1) if i not in border]
        if not cand:
            raise SystemExit("no enclosed free region — check FLOOR_RAW / BODY band")
        self.interior = lbl == max(cand)[1]
        self.outer = ndimage.binary_fill_holes(self.interior)
        self.holes = self.outer & ~self.interior
        self.room_area = self.outer.sum() * CELL**2

    # --- walk envelope -----------------------------------------------------
    def envelope(self):
        dist_edge = ndimage.distance_transform_edt(self.outer) * CELL
        islands, lbl, k = [], *ndimage.label(self.holes, np.ones((3, 3)))
        walk = ndimage.binary_erosion(self.outer, np.ones((2*int(WALL_INSET/CELL) | 1,)*2))
        for i in range(1, k+1):
            m = lbl == i
            area = m.sum()*CELL**2
            if area < 0.06:
                continue
            h = float(self.top[m].max())
            pad = PAD_TALL if h > TALL_TOP else PAD_LOW
            gap = float(dist_edge[m].min())
            # pinching rule: an island within one standoff of the wall is
            # architecture, not a hole — otherwise it leaves a tar-pit sliver
            pinched = gap < pad + WALL_INSET
            islands.append(dict(mask=m, area=area, top=h, pad=pad, gap=gap, pinched=pinched))
            # every island is subtracted — "pinched" only changes how it is
            # DESCRIBED downstream (architecture vs. a hole in the region), never
            # whether a body can stand inside it
            walk &= ~ndimage.binary_dilation(m, np.ones((2*int(pad/CELL) | 1,)*2))
        # open with a disk the width of the narrowest corridor we will accept:
        # anything thinner than this is the tar-pit sliver, not usable floor
        rr = max(1, int(MIN_CORRIDOR/2/CELL))
        yy, xx = np.ogrid[-rr:rr+1, -rr:rr+1]
        disk = (xx*xx + yy*yy) <= rr*rr
        walk = ndimage.binary_opening(walk, disk)
        lb, n = ndimage.label(walk)
        if n:
            sizes = sorted(((np.count_nonzero(lb == i), i) for i in range(1, n+1)), reverse=True)
            main = lb == sizes[0][1]
            stranded = [s[0]*CELL**2 for s in sizes[1:] if s[0]*CELL**2 > 0.2]
        else:
            main, stranded = walk, []
        self.walk, self.islands, self.stranded = main, islands, stranded
        self.walk_area = main.sum()*CELL**2
        # narrowest clear width inside the envelope (2x the max inscribed radius
        # along the medial axis is generous; report the min over the skeleton)
        d = ndimage.distance_transform_edt(main)*CELL
        skel = main & (d >= ndimage.maximum_filter(d, 5) - 1e-9)
        self.min_width = float(2*d[skel].min()) if skel.any() else 0.0
        self.typ_width = float(2*np.median(d[skel])) if skel.any() else 0.0
        return main

    # --- visibility --------------------------------------------------------
    def visible(self, i0, j0, i1, j1):
        """2D line-of-sight over the solid grid; both endpoints exempt."""
        n = int(max(abs(i1-i0), abs(j1-j0)))
        if n < 2:
            return True
        t = np.linspace(0.0, 1.0, n+1)[1:-1]
        ii = np.rint(i0 + (i1-i0)*t).astype(np.intp)
        jj = np.rint(j0 + (j1-j0)*t).astype(np.intp)
        ok = (ii >= 0) & (ii < self.shape[0]) & (jj >= 0) & (jj < self.shape[1])
        if not ok.all():
            return False
        return not self.solid[ii, jj].any()

    def first_hit(self, i0, j0, i1, j1):
        """March from (i0,j0) to (i1,j1); return the first solid cell hit, or None."""
        n = int(max(abs(i1-i0), abs(j1-j0)))
        if n < 2:
            return None
        t = np.linspace(0.0, 1.0, n+1)[1:]
        ii = np.rint(i0 + (i1-i0)*t).astype(np.intp)
        jj = np.rint(j0 + (j1-j0)*t).astype(np.intp)
        if (ii < 0).any() or (ii >= self.shape[0]).any() or \
           (jj < 0).any() or (jj >= self.shape[1]).any():
            return None
        hit = np.nonzero(self.solid[ii, jj])[0]
        return None if len(hit) == 0 else (int(ii[hit[0]]), int(jj[hit[0]]))

    def sees_object(self, i0, j0, i1, j1, reg, tol=0.25):
        """True when the first thing the ray meets is the object itself (or its
        immediate neighbourhood — gear sits shoulder to shoulder)."""
        h = self.first_hit(i0, j0, i1, j1)
        if h is None:
            return True
        if reg[h]:
            return True
        r = int(tol/CELL)
        return math.dist(h, (i1, j1)) <= r

    def vis_from(self, i1, j1, cells):
        """Vectorised LOS from many source cells to one target. cells = (I, J)."""
        I, J = cells
        n = int(max(np.abs(I-i1).max(), np.abs(J-j1).max())) + 1
        t = np.linspace(0.0, 1.0, n)[None, 1:-1]
        ii = np.rint(I[:, None] + (i1-I[:, None])*t).astype(np.intp)
        jj = np.rint(J[:, None] + (j1-J[:, None])*t).astype(np.intp)
        np.clip(ii, 0, self.shape[0]-1, out=ii); np.clip(jj, 0, self.shape[1]-1, out=jj)
        return ~self.solid[ii, jj].any(axis=1)


def rdp(pts, eps):
    """Douglas-Peucker: a wall is a straight line, not 400 grid steps."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = np.linalg.norm(ab)
    ap = pts - a
    # 2-D cross magnitude, written out: np.cross dropped 2-vector support in
    # NumPy 2.3, while np.trapezoid below needs NumPy >= 2.0 — the original
    # np.cross form cannot run on any single NumPy version.
    d = (np.abs(ab[0]*ap[:, 1] - ab[1]*ap[:, 0]) / L) if L > 1e-9 \
        else np.linalg.norm(ap, axis=1)
    i = int(np.argmax(d))
    if d[i] <= eps:
        return np.array([a, b])
    return np.vstack([rdp(pts[:i+1], eps)[:-1], rdp(pts[i:], eps)])


def polygons(sc, eps=0.09):
    """Walk envelope as an outer ring plus holes, in raw .sog coordinates.
    Also emits each hole's oriented bounding box, which is the closed-form
    primitive the falloff SDF wants."""
    ii, jj = np.nonzero(sc.walk)
    wx, wz = sc.world_of(ii, jj)
    walk_cells = np.stack([wx, wz], 1)

    def trace(mask):
        out = []
        for c in measure.find_contours(np.pad(mask.astype(float), 1), 0.5):
            c = c - 1.0
            xy = np.stack([sc.x0 + (c[:, 0] + 0.5)*CELL, sc.z0 + (c[:, 1] + 0.5)*CELL], 1)
            # Douglas-Peucker does NOT preserve containment - it will shave the
            # corner a walk cell sits in. That is how the first Bluedio opening
            # shot ended up 13 mm OUTSIDE its own walk polygon. Back eps off
            # until the simplified ring still encloses every walk cell the raw
            # contour enclosed, so the polygon is a superset of the grid region
            # and anything the pipeline seats on the grid stays legal in it.
            keep = walk_cells[measure.points_in_poly(walk_cells, xy)]
            simp, e = xy, eps
            for _ in range(8):
                simp = rdp(xy, e)
                if len(keep) == 0 or measure.points_in_poly(keep, simp).all():
                    break
                e *= 0.5
            else:
                # never converged: ship the unsimplified contour rather than a
                # ring that quietly excludes cells the pipeline may seat on.
                print(f"  ! containment not reached by eps={e:.4f}; "
                      f"keeping raw {len(xy)}-pt contour")
                simp = xy
            if len(simp) >= 4:
                out.append((simp, e))
        return out

    rings = trace(sc.walk)
    rings.sort(key=lambda r: -abs(np.trapezoid(r[0][:, 1], r[0][:, 0])))

    def ring_area(r):
        return abs(float(np.sum(r[:-1, 0]*r[1:, 1] - r[1:, 0]*r[:-1, 1])))/2
    def wind(r, ccw):
        """Normalise ring orientation so the consumer can trust the sign."""
        a = float(np.sum(r[:-1, 0]*r[1:, 1] - r[1:, 0]*r[:-1, 1]))
        return r if (a > 0) == ccw else r[::-1]

    def as_sog(r):
        return [[round(float(x)/S, 4), round(float(z)/S, 4)] for x, z in r]

    holes = []
    for isl in sc.islands:
        if isl["pinched"]:
            continue
        ii, jj = np.nonzero(isl["mask"])
        xs, zs = sc.world_of(ii, jj)
        P = np.stack([xs, zs], 1)
        c = P.mean(0)
        _, _, vt = np.linalg.svd(P - c, full_matrices=False)
        loc = (P - c) @ vt.T
        half = (loc.max(0) - loc.min(0)) / 2
        ctr = c + (loc.max(0) + loc.min(0))/2 @ vt
        holes.append(dict(
            kind="rect", pad_m=isl["pad"], top_m=round(isl["top"], 3),
            centre=[round(float(ctr[0])/S, 4), round(float(ctr[1])/S, 4)],
            half_extent=[round(float(half[0])/S, 4), round(float(half[1])/S, 4)],
            angle_deg=round(float(math.degrees(math.atan2(vt[0, 1], vt[0, 0]))), 2),
        ))
    return dict(
        eye_height_sog_y=0.0,
        winding="outer CCW, inner rings CW, in the (x, z) plane",
        simplify_eps_m=round(float(rings[0][1]), 4) if rings else None,
        polygon_area_m2=round(ring_area(rings[0][0]), 3) if rings else 0.0,
        raster_area_m2=round(float(sc.walk.sum()*CELL**2), 3),
        outer=as_sog(wind(rings[0][0], True)) if rings else [],
        inner_rings=[as_sog(wind(r[0], False)) for r in rings[1:]],
        holes=holes,
        falloff_m=0.35,
    )


# ------------------------------------------------------------------ heroes
def find_heroes(sc, n_heroes):
    """Saliency field + non-maximum suppression. Gear that is dense, colourful,
    tall and locally distinct wins; NMS keeps them spread around the room."""
    d = np.log1p(sc.dens)
    d = (d - d.min()) / (np.ptp(d) + 1e-9)
    c = sc.colvar / (np.percentile(sc.colvar[sc.colvar > 0], 98) + 1e-9)
    # gear that stands up off the floor is what deserves a hero point; a rug or a
    # cable run can be dense and colourful and is never worth flying to
    h = np.clip((sc.top - 0.45) / 1.15, 0, 1)
    relief = ndimage.maximum_filter(sc.top, 7) - ndimage.minimum_filter(sc.top, 7)
    r = np.clip(relief / 0.8, 0, 1)                       # local silhouette complexity
    sal = (0.34*d + 0.28*np.clip(c, 0, 1) + 0.20*h + 0.18*r)
    sal = ndimage.gaussian_filter(sal, 2.0)
    sal[sc.walk] = 0                                      # heroes are gear, not floor
    sal[sc.top < 0.55] = 0
    # gear more than ROOM_REACH from the room's plan area belongs to somewhere else
    near_room = ndimage.binary_dilation(sc.outer, np.ones((2*int(1.20/CELL) | 1,)*2))
    sal[~near_room] = 0
    sc.sal = sal

    # candidate seats: cells in the walk region we could actually fly from
    walk_d = ndimage.distance_transform_edt(~sc.walk)*CELL
    sep = int(HERO_SEP/CELL)
    peaks = (sal >= ndimage.maximum_filter(sal, sep | 1) - 1e-12) & (sal > 0)
    pi, pj = np.nonzero(peaks)
    order = np.argsort(sal[pi, pj])[::-1]
    print(f"  {len(pi)} saliency peaks to test")
    picks, used = [], np.zeros(sc.shape, bool)
    for o in order:
        i, j = int(pi[o]), int(pj[o])
        if used[i, j]:
            continue
        pose = frame_it(sc, i, j, walk_d)
        if pose is None:
            continue
        # The NMS above runs on saliency PEAKS. Two peaks on one object can sit
        # just outside the box and still grow into the same region: heroes 4 and
        # 5 of the first Bluedio run had centroids 0.249 m apart, the same
        # keyboard framed from 315 deg and from 45 deg. Peak separation is not
        # object separation, so re-check once the region is actually known.
        if any(math.dist(pose["centroid_m"][::2], q["centroid_m"][::2]) < HERO_SEP
               or (pose["_reg"] & q["_reg"]).sum()
                  > 0.35*min(pose["_reg"].sum(), q["_reg"].sum())
               for q in picks):
            continue
        used[max(0, i-sep):i+sep+1, max(0, j-sep):j+sep+1] = True
        picks.append(pose)
        if len(picks) >= n_heroes:
            break
    return picks


def frame_it(sc, i, j, walk_d):
    """Grow the object around a saliency peak, then stand off its open face."""
    seed_h = sc.top[i, j]
    reg = np.zeros(sc.shape, bool)
    reg[i, j] = True
    for _ in range(int(0.90/CELL)):
        gr = ndimage.binary_dilation(reg, np.ones((3, 3)))
        reg = gr & (np.abs(sc.top - seed_h) < 0.50) & (sc.top > 0.35) & ~sc.walk
    if reg.sum()*CELL**2 < 0.12:
        return None
    ii, jj = np.nonzero(reg)
    xs, zs = sc.world_of(ii, jj)
    cx, cz = float(xs.mean()), float(zs.mean())
    obj_top = float(np.percentile(sc.top[reg], 92))

    best = None
    for deg in range(0, 360, 15):
        a = math.radians(deg)
        dx, dz = math.cos(a), math.sin(a)
        # the face: how far the object itself extends in this direction
        reach = float(np.max((xs - cx)*dx + (zs - cz)*dz))
        fx, fz = cx + dx*reach, cz + dz*reach
        for back in np.arange(STANDOFF[0], STANDOFF[1]+1e-9, 0.10):
            px, pz = fx + dx*back, fz + dz*back
            pi, pj = sc.cell_of(px, pz)
            if not (0 <= pi < sc.shape[0] and 0 <= pj < sc.shape[1]):
                continue
            if not sc.outer[pi, pj] or sc.solid[pi, pj]:
                continue
            if not sc.sees_object(pi, pj, i, j, reg):
                continue
            # prefer: mid-range standoff, close to (but not inside) the walk region,
            # and a clear cone in front of the camera
            # the fly-in is a privileged move: prefer a pose a visitor could not
            # walk to, close in, still inside the room's plan area
            score = (-abs(back - 0.75)*1.4
                     + 0.75*min(float(walk_d[pi, pj]), 0.7)
                     + 0.25*float(sc.interior[pi, pj]))
            if best is None or score > best[0]:
                best = (score, px, pz, float(back), math.degrees(a), reach)
    if best is None:
        return None
    _, px, pz, back, adeg, reach = best

    # frame the whole object: eye a little above its mid-height, aim at mid-height
    # aim at the object's upper third — its face, controls, keybed — and put the
    # camera near standing eye level looking slightly down, never at knee height
    tgt_y = float(np.clip(obj_top*0.78, 0.45, 1.85))
    eye_y = float(np.clip(obj_top*0.45 + 0.72, 1.05, 1.70))
    span = max(float(np.ptp(xs)), float(np.ptp(zs)), obj_top)
    need = (span*0.5) / math.tan(HFOV/2) + 0.15
    if need > back:                                   # too tight: back off if we can
        back = float(min(need, STANDOFF[1]))
        px = cx + math.cos(math.radians(adeg))*(reach + back)
        pz = cz + math.sin(math.radians(adeg))*(reach + back)
    return dict(
        cell=(int(i), int(j)),
        centroid_m=[round(cx, 3), round(obj_top*0.5, 3), round(cz, 3)],
        footprint_m2=round(float(reg.sum()*CELL**2), 3),
        top_m=round(obj_top, 3),
        standoff_m=round(back, 3),
        approach_deg=round(adeg, 1),
        saliency=round(float(sc.sal[i, j]), 4),
        position=[round(px/S, 4), round(FLOOR_RAW - eye_y/S, 4), round(pz/S, 4)],
        target=[round(cx/S, 4), round(FLOOR_RAW - tgt_y/S, 4), round(cz/S, 4)],
        _pm=(px, eye_y, pz), _tm=(cx, tgt_y, cz), _reg=reg,
    )


# ------------------------------------------------------------------ opening shot
def opening_shot(sc, heroes):
    """Best first frame: stand in the walk region, look where the saliency is."""
    # Containment alone is not enough: a seat 25 mm inside the boundary is legal
    # and still lands inside the 0.35 m falloff, so the visitor would spawn at a
    # few percent of walking speed. Seat only where there is real clearance.
    clear = ndimage.distance_transform_edt(sc.walk)*CELL
    seatable = sc.walk & (clear >= SEAT_MARGIN)
    if not seatable.any():                     # pocket too tight: take the roomiest cell
        seatable = sc.walk & (clear >= clear.max() - 1e-9)
    ii, jj = np.nonzero(seatable)
    step = max(1, len(ii)//900)
    I, J = ii[::step], jj[::step]
    X, Z = sc.world_of(I, J)
    vis = np.stack([np.array([sc.sees_object(int(i), int(j), h["cell"][0], h["cell"][1],
                                             h["_reg"]) for i, j in zip(I, J)])
                    for h in heroes]) if heroes else np.zeros((0, len(I)), bool)
    hx = np.array([sc.world_of(*h["cell"])[0] for h in heroes])
    hz = np.array([sc.world_of(*h["cell"])[1] for h in heroes])
    w = np.array([h["saliency"] for h in heroes])
    bearing = np.arctan2(hz[:, None]-Z[None, :], hx[:, None]-X[None, :])
    best = None
    for deg in range(0, 360, 10):
        a = math.radians(deg)
        infov = np.abs((bearing - a + math.pi) % (2*math.pi) - math.pi) < HFOV*0.62
        seen = (w[:, None]*(infov & vis)).sum(0)
        k = int(np.argmax(seen))
        if best is None or seen[k] > best[0]:
            best = (float(seen[k]), int(I[k]), int(J[k]), deg)
    _, i, j, deg = best
    x, z = sc.world_of(i, j)
    a = math.radians(deg)
    return dict(
        position=[round(float(x)/S, 4), 0.0, round(float(z)/S, 4)],
        target=[round(float(x + math.cos(a)*3.0)/S, 4), round(FLOOR_RAW - 1.15/S, 4),
                round(float(z + math.sin(a)*3.0)/S, 4)],
        yaw_deg=deg, heroes_in_frame=round(float(best[0]), 3),
        margin_m=round(float(clear[i, j]), 3),
    )


# ------------------------------------------------------------------ fly-in tour
def tour(sc, heroes, start):
    """Order the heroes into a walk that keeps the camera moving one way round
    the room, so consecutive fly-ins never whip back across the frame."""
    if not heroes:
        return []
    cx = np.mean([h["_pm"][0] for h in heroes]); cz = np.mean([h["_pm"][2] for h in heroes])
    ang = [math.atan2(h["_pm"][2]-cz, h["_pm"][0]-cx) for h in heroes]
    sx, sz = start["position"][0]*S, start["position"][2]*S
    a0 = math.atan2(sz-cz, sx-cx)
    order = sorted(range(len(heroes)), key=lambda k: (ang[k]-a0) % (2*math.pi))
    out = []
    for n, k in enumerate(order):
        h = heroes[k]
        prev = out[-1]["_pm"] if out else (sx, EYE, sz)
        d = math.dist(prev[::2], h["_pm"][::2])
        out.append(dict(h, order=n,
                        travel_m=round(d, 2),
                        duration_s=round(float(np.clip(1.1 + 0.55*d, 1.4, 4.2)), 2),
                        dwell_s=2.6))
    return out


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--heroes", type=int, default=8)
    ap.add_argument("--out", default="./scene.json")
    a = ap.parse_args()

    sc = Scene()
    sc.envelope()
    heroes = find_heroes(sc, a.heroes)
    start = opening_shot(sc, heroes)
    seq = tour(sc, heroes, start)

    print(f"room            {sc.room_area:6.2f} m²  ({sc.room_area*10.764:6.1f} sq ft)")
    print(f"walkable        {sc.walk_area:6.2f} m²  ({sc.walk_area*10.764:6.1f} sq ft)  "
          f"= {100*sc.walk_area/sc.room_area:.0f}%")
    print(f"clear width     min {sc.min_width:.2f} m, median {sc.typ_width:.2f} m "
          f"(along the medial axis; floor {MIN_CORRIDOR:.2f} m)")
    if sc.min_width < MIN_CORRIDOR:
        print("  ! narrower than the corridor floor somewhere — check the plan figure")
    print(f"islands         {len(sc.islands)} ({sum(i['pinched'] for i in sc.islands)} pinched into wall)")
    print(f"stranded        {[round(s,2) for s in sc.stranded] or 'none'}")
    print(f"opening shot    yaw {start['yaw_deg']}°, {start['heroes_in_frame']} saliency in frame")
    print(f"\n{len(seq)} hero points, tour order:")
    for h in seq:
        print(f"  {h['order']}  sal={h['saliency']:.3f}  top={h['top_m']:.2f} m  "
              f"foot={h['footprint_m2']:.2f} m²  standoff={h['standoff_m']:.2f} m  "
              f"travel={h['travel_m']:.2f} m  pos={h['position']}")

    clean = [{k: v for k, v in h.items() if not k.startswith("_")} for h in seq]

    # polygons() is not cheap now that it backs off on eps - build it once, and
    # stamp every exported pose with whether it is actually inside the ring so a
    # consumer never has to re-derive that.
    walk = polygons(sc)
    ring = np.array(walk["outer"], float)*S if walk["outer"] else np.zeros((0, 2))
    def inside(pos):
        return bool(len(ring)) and bool(
            measure.points_in_poly([[pos[0]*S, pos[2]*S]], ring)[0])
    start["inside_walk_polygon"] = inside(start["position"])
    for h in clean:
        h["inside_walk_polygon"] = inside(h["position"])
    if not start["inside_walk_polygon"]:
        raise SystemExit("opening shot is outside the walk polygon - refusing to export")

    json.dump(dict(
        _units="positions and targets are raw .sog coordinates, ready for demos.ts",
        scale_m_per_unit=S, floor_raw_y=FLOOR_RAW, eye_height_m=EYE, ceiling_m=CEIL,
        room_m2=round(sc.room_area, 2), walkable_m2=round(sc.walk_area, 2),
        min_clear_width_m=round(sc.min_width, 2),
        stranded_pockets_m2=[round(s, 2) for s in sc.stranded],
        params=dict(cell=CELL, body=list(BODY), gear=list(GEAR), pad_tall=PAD_TALL,
                    pad_low=PAD_LOW, wall_inset=WALL_INSET, hero_sep=HERO_SEP),
        walk=walk,
        initialPose=start, heroes=clean,
    ), open(a.out, "w"), indent=1)
    np.savez("./grids.npz", solid=sc.solid, interior=sc.interior,
             outer=sc.outer, holes=sc.holes, walk=sc.walk, sal=sc.sal, top=sc.top,
             x0=sc.x0, z0=sc.z0, cell=CELL)
    print(f"\nwalk polygon: {len(walk['outer'])} vertices, {len(walk['inner_rings'])} inner rings, "
          f"{len(walk['holes'])} padded holes")
    print(f"  area {walk['polygon_area_m2']} m2 vs raster {walk['raster_area_m2']} m2; "
          f"eps {walk['simplify_eps_m']} m; seat {start['margin_m']} m inside")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
