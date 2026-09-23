// One entry per room. Adding a studio (or swapping a placeholder for the real scan) is an
// edit here only; the labels, the viewer window and the deep link (#studio-b) follow from it.
//
//   src       .ply / .compressed.ply / .sog / lod-meta.json (streamed). Relative paths are
//             served from this site; absolute URLs need CORS enabled on their host.
//   poster    optional still shown in the window before the visitor clicks in.
//   start     where the visitor stands and what they face, in metres, Y-up.
//   fov       field of view in degrees across the wider side of the window (SuperSplat's convention).
//   rotation  optional euler degrees for the splat entity; the default [0, 0, 180] suits scans
//             exported by SuperSplat / splat-transform.
//   mobileFov vertical field of view in the full-screen phone view (default 100), tall enough to
//             keep floor and ceiling in frame. ?fov=NN overrides it for testing on a device.
//   walk      optional walk mode: a fixed eye height and a walkable region (see walk-region.js).
//             { eyeHeight (m above the floor), floorY (world y of the floor), unitsPerMetre,
//               region: { outer: [[x, z], ...], innerRings?, holes?: [{ centre, halfExtent,
//               angleDeg?, pad }], falloff?, spawnMargin? } }. Rings are in world units; pads,
//             falloff and margins in metres. Only a scan with a KNOWN floor and scale gets one.
//   bounds    optional box the visitor can't walk out of, for a studio without a walk region:
//             { min: [x, y, z], max: [x, y, z] }.

// The placeholder rooms are generated (tools/make-placeholder.mjs), so their floor, scale and
// furniture are known exactly: an 8 x 10 m room, floor at y = 0, metric, and two low plinths.
const PLACEHOLDER_WALK = {
    eyeHeight: 1.55,        // between the 1.4 and 1.9 m capture rings, per the Bluedio spec
    floorY: 0,
    unitsPerMetre: 1,
    region: {
        outer: [[-3.65, -4.65], [3.65, -4.65], [3.65, 4.65], [-3.65, 4.65]],   // walls inset 0.35 m
        holes: [
            { centre: [-2.2, -2.2], halfExtent: [0.35, 0.35], pad: 0.2 },    // 0.95 m plinth
            { centre: [2.3, -1.2], halfExtent: [0.3, 0.3], pad: 0.18 }       // 0.6 m plinth
        ],
        falloff: 0.25
    }
};

export const STUDIOS = [
    {
        id: 'b',
        letter: 'B',
        name: 'Studio B',
        status: 'Placeholder room',
        placeholder: true,
        src: 'splats/studio-b/placeholder.ply',
        start: { position: [0, 1.55, 3.8], target: [0, 1.55, 0] },
        fov: 90,
        walk: PLACEHOLDER_WALK
    },
    {
        id: 'c',
        letter: 'C',
        name: 'Studio C',
        status: 'Placeholder room',
        placeholder: true,
        src: 'splats/studio-c/placeholder.ply',
        start: { position: [0, 1.55, 3.8], target: [0, 1.55, 0] },
        fov: 90,
        walk: PLACEHOLDER_WALK
    },
    {
        id: 'e',
        letter: 'E',
        name: 'Studio E',
        status: 'Live scan',
        // streamed from the SuperSplat publish (superspl.at/s?id=2e3188e6) until the files are self-hosted
        src: 'https://d28zzqy0iyovbz.cloudfront.net/2e3188e6/v1/lod-meta.json',
        poster: 'https://s3-eu-west-1.amazonaws.com/images.playcanvas.com/splat/2e3188e6/v1/xl.webp',
        start: { position: [0, 2, 0], target: [2, 2, 0] },
        fov: 103
    }
];
