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
//   heroes    optional authored views, shown as numbered buttons (and keys 1–9) that glide the
//             camera there: [{ label?, pose: { position, target } }]. Author them with
//             ?author and __logPose(), like `start`.
//   rooms     optional, for a studio with more than one scanned space: [{ id, name, src, start,
//             fov, heroes, ... }]. Each room takes the per-scan fields above; the first is the one
//             "Click to enter" opens, and buttons in the window move between them (one scan in
//             memory at a time). Deep link to a room with #studio-c/booth.

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
        status: 'Live scan',
        rooms: [
            {
                id: 'control',
                name: 'Control room',
                // STUDIO_C_DETAIL_v1.ply (1.5M gaussians, SH3) encoded with splat-transform 3.3.0:
                //   --filter-nan -m -i 3 --max-workers 8 studio-c.sog
                src: 'splats/studio-c/studio-c.sog',
                start: { position: [0.262, 0.096, -0.392], target: [0.25, 0.122, 0.608] },
                fov: 90,
                heroes: [
                    { pose: { position: [-1.359, -0.342, 3.771], target: [-1.596, -0.816, 4.619] } },
                    { pose: { position: [0.239, 1.35, 3.16], target: [0.259, 1.041, 4.111] } },
                    { pose: { position: [2.006, -0.502, 2.095], target: [1.363, -0.651, 1.345] } }
                ]
            },
            {
                id: 'booth',
                name: 'Vocal booth',
                // mirrored as published from SuperSplat (superspl.at/scene/7c92f7a7): streamed
                // SOG, 2 LODs (1.50M + 0.75M gaussians), 27 MB
                src: 'splats/studio-c/booth/lod-meta.json',
                start: { position: [0.776, 0.994, -3.269], target: [0.562, 0.717, -2.332] },
                fov: 93
            }
        ]
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
