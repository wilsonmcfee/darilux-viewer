/* ============================================================================
   reachable.mjs — emit the set of camera positions a visitor can actually reach.
   ----------------------------------------------------------------------------
   WHAT AND WHY

   `mobile_asset.py` scores every gaussian by how much screen area it can ever
   occupy, and "ever" is a much smaller set than it sounds. This viewer does not
   offer free flight: a visitor gets a constrained walk at ONE fixed eye height
   inside a small polygon, plus a fixed list of authored hero poses. For Bluedio
   that is a ~9.8 m2 floor patch at 1.55 m and ten camera stations — a few
   hundred distinct viewpoints, not a volume.

   That is what makes aggressive pruning safe here in a way it would not be for
   a free-orbit viewer: a splat's worst case is its closest approach across a
   set we can enumerate in advance.

   WHY IT READS demos.ts RATHER THAN scene.json

   `autoscene/scene.json` also carries a walk polygon, but it is the wrong one.
   It is autoscene.py's conservative 2.54 m2 answer to "does this room deserve
   walk mode at all". What SHIPS is envelope.py's looser region, hand-corrected
   afterwards, and living in `src/demos.ts` at 9.8 m2 — nearly four times the
   area and a different shape. Scoring against the small polygon would
   over-weight one corner and prune detail the visitor can walk right up to.

   demos.ts is the single source of truth for both the region and the hero
   poses, so this reads it directly. Node 24 strips the TypeScript on import.

   COORDINATES — the easiest thing to get wrong here

   demos.ts is in WORLD space. The source .ply is in RAW .sog space. Per
   TEMPLATE.md "Gotchas" #1 the viewer rolls every splat entity 180 degrees
   about Z, so raw (x, y, z) renders at world (-x, -y, z). This script emits
   RAW, because that is the space the .ply is in and the space the Python pass
   never has to convert out of.

   USAGE
     node --experimental-strip-types autoscene/reachable.mjs > autoscene/reachable.json
   ========================================================================== */

const { DEMOS } = await import('../src/demos.ts');

const demo = DEMOS.find((d) => d.id === 'bluedio');
if (!demo) throw new Error('no demo with id "bluedio" in demos.ts');
if (!demo.walk) throw new Error('bluedio has no walk block — nothing to sample');

const { eyeHeight, floorY, unitsPerMetre, region } = demo.walk;

/** World -> raw. Only x and y flip; see the coordinate note above. */
const toRaw = ([x, y, z]) => [-x, -y, z];

/* ---- Walk stations --------------------------------------------------------
   Sample the walkable polygon on a grid rather than using its vertices. The
   vertices are all ON the boundary, which is the one place a visitor never
   quite reaches (the falloff makes the edge asymptotic), and they cluster where
   the outline is detailed rather than where the floor is open.

   20 cm is comfortably finer than the pruning decisions that depend on it: at
   the closest approach that matters (~0.5 m) a 20 cm sampling error moves a
   splat's projected size by well under the margin between keeping and dropping
   it. Bluedio's ~9.8 m2 yields roughly 245 stations. */
const STEP_M = 0.2;

/** Even-odd point-in-polygon. Rings are [x, z] pairs in world units. */
function inRing(px, pz, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const outer = region.outer;
const innerRings = region.innerRings ?? [];
const xs = outer.map((p) => p[0]);
const zs = outer.map((p) => p[1]);
const stepWorld = STEP_M * unitsPerMetre;

// The walk plane, in world y: the floor plus a metric eye height.
const eyeWorldY = floorY + eyeHeight * unitsPerMetre;

const stations = [];
for (let x = Math.min(...xs); x <= Math.max(...xs); x += stepWorld) {
  for (let z = Math.min(...zs); z <= Math.max(...zs); z += stepWorld) {
    if (!inRing(x, z, outer)) continue;
    // An inner ring is a hole: inside it is NOT walkable.
    if (innerRings.some((r) => inRing(x, z, r))) continue;
    stations.push(toRaw([x, eyeWorldY, z]));
  }
}

/* ---- Hero stations --------------------------------------------------------
   Hero poses sit OUTSIDE the walk region by design — off a console face, above
   a desk, where no body stands (see WALK_IMPLEMENTATION_BRIEF §6). They are
   also the closest the camera EVER gets to the gear, so they dominate the
   significance score exactly where detail matters most. Omitting them would
   prune the hero subjects hardest, which is the opposite of what anyone wants.

   Auto-orbit swings the camera around each hero, so a single point understates
   the reach; the orbit stays at the same radius though, so the nearest-distance
   metric this feeds is unaffected. */
const heroes = demo.heroPoints.map((h) => toRaw(h.pose.position));

const out = {
  _note:
    'RAW .sog coordinates. Generated from src/demos.ts by autoscene/reachable.mjs — do not hand-edit.',
  demo: demo.id,
  eye_height_m: eyeHeight,
  floor_world_y: floorY,
  units_per_metre: unitsPerMetre,
  step_m: STEP_M,
  walk_stations: stations,
  hero_stations: heroes,
};

console.log(JSON.stringify(out));
process.stderr.write(
  `[reachable] ${stations.length} walk stations at ${STEP_M} m + ${heroes.length} hero poses\n`,
);
