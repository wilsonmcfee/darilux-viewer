/* ============================================================================
   demos.ts — THE ONE FILE YOU EDIT to tune the demo reel.
   ----------------------------------------------------------------------------
   This is the equivalent of the SuperSplat starter's `splat-config.ts`, extended
   for three scenes and their hero points. Everything the viewer shows (scene
   files, camera framing, copy, hero-point positions) is declared here as data.
   No rendering logic lives in this file.

   HOW POSES WORK
   --------------
   A pose describes where the camera sits and what it looks at:
     position  — [x, y, z] world coordinates of the camera
     target    — [x, y, z] world point the camera aims at (also the orbit pivot)
     fov       — vertical field of view in degrees (lower = more "zoomed in")

   You cannot guess these numbers — they only make sense against the rendered
   scene. Author them the same way as the pilot rig: run `npm run dev`, free-fly
   to a framing you like, open the browser console and run  __logPose()  — it
   prints a ready-to-paste pose. Drop it into `initialPose` (the opening shot) or
   a hero point's `pose` (where the fly-in lands). The `anchor` is the 3D point
   the floating label pins to; if omitted it defaults to the pose's target.

   All coordinate values below are PLACEHOLDERS marked TODO. They will be wrong
   until authored against your real .sog scenes.
   ========================================================================== */

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface HeroPoint {
  id: string;
  label: string;          // short name shown in the drawer menu
  caption: string;        // floating label next to the 3D marker
  pose: Pose;             // where the fly-in lands
  anchor?: [number, number, number]; // 3D point the marker pins to (default: pose.target)
  /**
   * Marker style. 'info' renders a slightly larger circle with an enclosed
   * question mark — for explanatory notes about the capture itself rather
   * than featured gear. Behaves exactly like a normal hero point otherwise.
   */
  variant?: 'info';

  // ---- Description card (shown when the dot or the menu item is clicked) ----
  icon?: string;          // small glyph beside the card title (e.g. 'speaker')
  subtitle?: string;      // e.g. "Analog synthesizer · 1981"
  description?: string;   // paragraph of copy
  specs?: { label: string; value: string }[]; // optional spec rows, e.g. { label: 'Voices', value: '6' }

  // ---- Auto-orbit behavior once the fly-in lands (optional) ----
  //   mode 'sway' (default) = gentle pendulum around the front arc
  //   mode 'spin'           = continuous full 360° turntable (central fixtures)
  //   mode 'none'           = hold still — no auto motion (visitor can still orbit)
  //   direction -1          = start the sway / spin in the opposite direction
  //   pivot 'anchor'        = orbit around the dot's 3D point (default 'view' = the pose target)
  //   speed / ease / amplitude = optional per-hero overrides of the sway feel
  //     (defaults: speed 7.5°/s, ease 6°, amplitude ±30°). Lower speed + higher
  //     ease = smoother, gentler turnaround.
  autoOrbit?: {
    mode?: 'sway' | 'spin' | 'none';
    direction?: 1 | -1;
    pivot?: 'anchor' | 'view';
    speed?: number;
    ease?: number;
    amplitude?: number;
  };
}

export interface Demo {
  id: string;
  title: string;
  scale: string;          // "Small scale", "Medium scale", "Large scale"
  blurb: string;          // one/two lines shown in the info drawer
  /**
   * The WEB-READY compressed splat. Two forms are accepted:
   *   • Local path  — 'splat/<name>.sog' (file in public/splat/, served from Pages)
   *   • Full URL    — 'https://…/<name>.sog' (e.g. Cloudflare R2 / a CDN for large
   *                   scenes that exceed a host's per-file limit)
   * Mix and match per demo. For a cross-origin URL, the bucket/CDN must send an
   * Access-Control-Allow-Origin header that permits this site.
   * See public/splat/README.txt for how to produce these from your .ply files.
   */
  src: string;
  /**
   * The opening shot when this demo loads. Set to null to auto-frame the scene
   * from its bounding box (used until a pose is authored with __logPose).
   */
  initialPose: Pose | null;
  heroPoints: HeroPoint[];
  /**
   * Hero description card style:
   *   'hud'      — fixed glass panel on the left (default)
   *   'anchored' — small callout pinned to the hero's 3D point, tracking the camera
   */
  cardStyle?: 'hud' | 'hud-bottom' | 'anchored';
  /**
   * The viewer-window aspect ratio (width / height) this demo's poses were
   * AUTHORED at — i.e. the window's desktop CSS aspect. Pose `fov` is vertical,
   * so on a narrower viewport (e.g. the 16:9 windows becoming 4:3 on mobile)
   * the same fov silently crops the sides. The camera compensates: whenever the
   * live aspect is narrower than this reference, it widens the vertical fov to
   * preserve the authored HORIZONTAL coverage. Defaults to 16/9.
   */
  refAspect?: number;
}

export const DEMOS: Demo[] = [
  /* ---------------------------------------------------------------------- */
  {
    id: 'synths',
    title: 'Legendary Synthesizers',
    scale: 'Small scale',
    blurb:
      'A tight capture of five synthesizers. Tap a hero point to fly in and read ' +
      'each instrument close-up — the level of detail a single object can hold.',
    src: 'splat/synths/meta.json', // SOGS bundle ("Synth Heroes Rev" export)
    cardStyle: 'hud-bottom', // stationary HUD card, bottom-center
    refAspect: 3.4 / 5.5, // keep in sync with .ratio-tall in style.css
    // Real pose authored in SuperSplat and carried over from the starter.
    // Depth illusion: rest wide-ish at 80, then every hero fly-in eases the fov
    // out to 120 while the camera moves in — a dolly-zoom feel. Closing the
    // card flies home and reverses it. (flyTo lerps fov, so no code needed.)
    initialPose: {
      position: [0.432,0.536,-4.077],
      target: [0.237,0.385,-1.769],
      fov: 80,
    },
    heroPoints: [
      // Authored in SuperSplat via __logPose(). Each target sits on the instrument,
      // so it doubles as the floating label's anchor.
      {
        id: 'moog-sub-phatty',
        label: 'Moog Sub Phatty',
        caption: 'Moog Sub Phatty',
        pose: { position: [0.136, 2, -1.546], target: [-0.081, 2.282, 0.535], fov: 120 },
        anchor: [0.3,2.22,0],
        description:
          'A modern Moog monosynth with a Multidrive circuit and dedicated sub ' +
          'oscillator, built for weighty, growling low-end.',
        specs: [
          { label: 'Released', value: '2013' },
          { label: 'Sound', value: 'Gritty, punchy' },
        ],
      },
      {
        id: 'moog-minimoog',
        label: 'Moog Minimoog',
        caption: 'Moog Minimoog',
        pose: { position: [0.127, 1.6, -1.643], target: [-0.061, 1.264, 0.35], fov: 120 },
        anchor: [0.555, 1.4,0],
        subtitle: 'Model D',
        description:
          'The first portable synth to leave the lab for the stage, and the fat, ' +
          'singing voice behind five decades of bass and lead lines.',
        specs: [
          { label: 'Released', value: '1970' },
          { label: 'Sound', value: 'Warm, muscular' },
        ],
      },
      {
        id: 'sequential-prophet-10',
        label: 'Sequential Prophet 10',
        caption: 'Sequential Prophet 10',
        pose: { position: [0.215, 0.85, -1.87], target: [-0.052, 0.406, 0.123], fov: 120 },
        anchor: [0.5,0.658,0],
        description:
          'Ten voices of programmable analog — two Prophet-5s in one chassis — ' +
          'made for dense pads and orchestral swells.',
        specs: [
          { label: 'Released', value: '1980' },
          { label: 'Sound', value: 'Thick, cinematic' },
        ],
      },
      {
        id: 'roland-juno-60',
        label: 'Roland Juno-60',
        caption: 'Roland Juno-60',
        pose: { position: [0.122, 0.276, -1.864], target: [-0.06, -0.164, 0.173], fov: 120 },
        anchor: [0.78,-0.2,0],
        description:
          "One oscillator wrapped in Roland's unmistakable chorus, and arguably " +
          'the defining polysynth sound of the 1980s.',
        specs: [
          { label: 'Released', value: '1982' },
          { label: 'Sound', value: 'Shimmering, lush' },
        ],
      },
      {
        id: 'hohner-pianet-m',
        label: 'Hohner Pianet M',
        caption: 'Hohner Pianet M',
        pose: { position: [0.104, -0.67, -1.887], target: [-0.058, -0.846, 0.143], fov: 120 },
        anchor: [0.55,-0.87,0],
        description:
          "Hohner's reed-driven electric piano, carrying the warm, plaintive " +
          "Pianet voice woven through the fabric of '60s and '70s pop.",
        specs: [
          { label: 'Released', value: 'c. 1977' },
          { label: 'Sound', value: 'Warm, reedy' },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'studio-e',
    title: 'Studio E',
    scale: 'Medium scale',
    blurb:
      'Full-room coverage of Studio E. Move freely through the space, or fly to a ' +
      'hero point to inspect the featured gear at capture-grade fidelity.',
    src: 'splat/studio-e/meta.json', // SOGS bundle ("best Studio E yet" export)
    cardStyle: 'hud-bottom', // demo-1 style HUD card, anchored to the bottom of the screen
    refAspect: 16 / 9, // poses authored in the desktop .ratio-16x9 window (4:3 on mobile)
    // Authored opening pose carried over from the new (half) scan's starter.
    initialPose: {
      position: [-0.81,5.653,-7.861],
      target: [-0.742,4.881,-4.484],
      fov: 75,
    },
    heroPoints: [
      {
        id: 'atmos-monitors',
        label: 'Dolby Atmos Monitors',
        caption: 'PMC 6-2 · Immersive monitoring',
        icon: 'speaker',
        pose: { position: [-0.573, 5.828, -0.402], target: [-0.54, 4.666, 2.862], fov: 75 },
       anchor: [-0.409, 1.72, 6.852],
        description: `Studio E's Atmos bed runs on PMC 6-2 monitors — a three-way active design PMC released in 2021, purpose-built for rooms where immersive mixes have to translate exactly. Twin 6" woofers, a 2" midrange, and a 1" tweeter are each driven by their own 400W Class-D amplifier, with PMC's ATL bass-loading holding tonal balance steady from quiet reference levels up to 109dB. The result: what you hear at the desk is what ships.`,
      },
      {
        id: 'capture-quality',
        label: 'Why does it look like that?',
        caption: 'Why does it look like that?',
        variant: 'info',
        pose: { position: [-1.535, 4.29, 2.127], target: [1.418, 5.373, 0.672], fov: 75 },
        anchor: [9.543, 5.104, -4.374],
        autoOrbit: { mode: 'none' }, // hold the framing still — this one's for reading
        description:
          `The biggest advantage of Gaussian Splatting is also in some ways its biggest issue. It all hinges upon method of capture. If an iPhone is capturing a space in low light, due to hardware constraints (such as size of lens and FOV) details can become soft and fuzzy, which the compiler translates exactly as they're presented — creating soft floating gaussians and inconsistencies in some walls and angles.<br><br>` +
          `The fix? A higher quality method of capture. Final captures will be done with a Sony ZV-E1 using a 20mm lens, meaning impeccable capture of details even at low light, with a much wider field of view to gather more visual information. That way you preserve details even after compiling/compression. While there may still be some minor gaussian artifacts, they will be hardly noticeable compared to the iPhone capture. ` +
          `<a class="hero-card-link" href="https://superspl.at/scene/b149b2b0" target="_blank" rel="noopener">Here is an example using a similar camera setup</a>.`,
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'common-room',
    title: 'Common Room',
    scale: 'Large scale',
    blurb:
      'The common room — a composite of two captures stitched into one scene to ' +
      'show how fidelity holds across a larger space. Roam the whole room.',
    src: 'splat/common-room/meta.json', // SOGS bundle (composite of two captures)
    cardStyle: 'anchored', // callouts pinned to the 3D point rather than a HUD panel
    refAspect: 16 / 9, // poses authored in the desktop .ratio-16x9 window (4:3 on mobile)
    // Rough starting pose aimed at the scene's actual (offset) center. Bounds are
    // floater-inflated (~31 units) so auto-framing fails; explicit pose instead.
    // REFINE with __logPose() for the real shot.
    initialPose: {
     position: [17.423, 1.43, -3.132], 
     target: [9.492, 1.44, -3.887],
     fov: 60
    },
    heroPoints: [
      // TODO: author each — fly + __logPose() for `pose`, crosshair (?author) +
      // __logAnchor() for `anchor`, then add subtitle/description/specs copy.
      {
        id: 'common-hero-1',
        label: 'Meeting Space',
        caption: 'Meeting Space',
        pose: { position: [-0.439, 2.163, -15.634], target: [-1.161, 1.963, -11.403], fov: 55 },
        anchor: [-2.5,0,-5],
        autoOrbit: { mode: 'spin', pivot: 'anchor' }, // full 360° turntable around the fixture
        description: 'The perfect place to unwind or discuss the next big idea with your team.',
      },
      {
        id: 'common-hero-2',
        label: 'Lounge Area',
        caption: 'Lounge Area',
        pose: { position: [-7.847, 1.005, -20.128], target: [-12.085, 0.91, -20.827], fov: 55 },
        anchor: [-16.395,0.558,-22.091],
        // Much gentler sway: ~30% speed with a wide ease zone for a soft turnaround.
        autoOrbit: { direction: -1, speed: 2.25, ease: 22 },
        description: 'Surround yourself with incredible gear and watch how easy it is to get inspired.',
      },
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'bluedio',
    title: 'Bluedio',
    scale: 'Medium scale',
    blurb:
      "A dense live room - drum kit, synth wall, DJ booth, red drapes. Authoring " +
      "scratchpad: hero points are still to be placed by hand.",
    src: 'splat/bluedio/meta.json', // SOGS bundle ("Bluedio_optimized.sog", 2,534,528 gaussians)
    cardStyle: 'hud-bottom',
    refAspect: 16 / 9,

    /* ---- COORDINATE NOTE - read before pasting anything from scene.json ----
       main.ts rolls every splat entity 180 deg about Z, so a raw .sog point
       (x, y, z) lands in WORLD space at (-x, -y, z). The autoscene pipeline in
       `Bluedio Experience/autoscene/` emits raw .sog coordinates, so its numbers
       must have x and y NEGATED before they go in here. (That roll is also what
       turns the Y-down .sog into a Y-up world: raw floor y=+4.20 -> world
       y=-4.20, and the raw eye plane y=0 stays at world y=0, i.e. 4.20 units =
       1.40 m above the floor at 1 unit = 1/3 m.)

       Poses captured in-browser with __logPose() are ALREADY world-space and
       need no conversion - that is the path to use.
       -------------------------------------------------------------------- */

    // Opening shot from autoscene: the walk-region seat with the most saliency
    // in frame, 0.316 m clear of the walk boundary. Raw .sog was
    // position [-7.5497, 0, 2.1787] / target [-0.6553, 0.75, 7.9638], yaw 40.
    // fov 42 matches the vertical FOV the CPU contact sheet was rendered at, so
    // this frame is the one verified in autoscene/previews.png.
    initialPose: {
      position: [7.55, 0, 2.179],
      target: [0.655, -0.75, 7.964],
      fov: 42,
    },

    /* Authored by Will with __logPose(), in viewer WORLD space - no conversion
       needed or applied. Order here is the order the markers are created in.

       `anchor` is intentionally omitted, so each marker falls back to its
       pose.target. Note what that means: __logPose() reports target as a
       look-at point a fixed ~0.6 m ahead of the camera, NOT a point on the
       gear. So a dot sits dead-centre when you are at its own hero pose, but
       floats in mid-air when seen from anywhere else. To pin the dots to the
       gear itself, add ?author to the URL and use __logAnchor() on each.

       TODO: subtitle / description / specs copy for each. Left blank on
       purpose rather than guessed at - the cards render a placeholder. */
    heroPoints: [
      {
        id: 'dub-station',
        label: 'Dub Station',
        caption: 'Dub Station',
        pose: { position: [6.552, 1.022, 0.198], target: [4.852, 0.357, 0.268], fov: 42 },
      },
      {
        id: 'roland-space-echo',
        label: 'Roland Space Echo',
        caption: 'Roland Space Echo',
        pose: { position: [6.872, -2.034, -2.087], target: [5.191, -2.403, -2.077], fov: 42 },
      },
      {
        id: 'juno-6',
        label: 'Juno 6',
        caption: 'Juno 6',
        pose: { position: [5.035, 1.887, 3.418], target: [5.114, 0.984, 5.004], fov: 42 },
      },
      {
        id: 'jupiter-6',
        label: 'Jupiter 6',
        caption: 'Jupiter 6',
        pose: { position: [5.282, 0.804, 3.115], target: [5.361, -0.105, 4.698], fov: 42 },
      },
      {
        id: 'access-virus',
        label: 'Access Virus',
        caption: 'Access Virus',
        pose: { position: [-0.309, 0.866, 3.09], target: [-0.208, 0.08, 4.619], fov: 42 },
      },
      {
        id: 'ursa-major-sst-282',
        label: 'Ursa Major SST 282',
        caption: 'Ursa Major SST 282 Space Station',
        pose: { position: [-3.051, -2.63, 3.738], target: [-2.925, -2.766, 5.449], fov: 42 },
      },
      {
        id: 'urei-la-3a',
        label: 'UREI LA-3A',
        caption: 'UREI LA-3A compressors',
        pose: { position: [-2.897, 1.045, 2.946], target: [-4.284, -0.144, 2.998], fov: 42 },
      },
      {
        id: 'pioneer-dj-station',
        label: 'Pioneer DJ Station',
        caption: 'Pioneer DJ Station',
        pose: { position: [-2.998, 2.964, -0.14], target: [-4.67, 2.233, -0.038], fov: 42 },
      },
      {
        id: 'shelford-channel',
        label: 'Shelford Channel',
        caption: 'Rupert Neve Designs Shelford Channel',
        pose: { position: [-2.634, 0.432, -3.534], target: [-4.188, -0.527, -3.476], fov: 42 },
      },
      {
        id: 'dj-sandman-theory',
        label: 'DJ Sandman Theory',
        caption: 'DJ Sandman Theory',
        pose: { position: [-1.507, 3.825, -4.566], target: [0.293, 3.738, -4.865], fov: 42 },
      },
    ],
  },
];
