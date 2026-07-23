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

  // ---- Description card (shown when the dot or the menu item is clicked) ----
  icon?: string;          // small glyph beside the card title (e.g. 'speaker')
  subtitle?: string;      // e.g. "Analog synthesizer · 1981"
  description?: string;   // paragraph of copy
  specs?: { label: string; value: string }[]; // optional spec rows, e.g. { label: 'Voices', value: '6' }

  // ---- Auto-orbit behavior once the fly-in lands (optional) ----
  //   mode 'sway' (default) = gentle pendulum around the front arc
  //   mode 'spin'           = continuous full 360° turntable (central fixtures)
  //   direction -1          = start the sway / spin in the opposite direction
  //   pivot 'anchor'        = orbit around the dot's 3D point (default 'view' = the pose target)
  //   speed / ease / amplitude = optional per-hero overrides of the sway feel
  //     (defaults: speed 7.5°/s, ease 6°, amplitude ±30°). Lower speed + higher
  //     ease = smoother, gentler turnaround.
  autoOrbit?: {
    mode?: 'sway' | 'spin';
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
    src: 'splat/synths/meta.json', // SOGS bundle (meta.json + .webp textures)
    cardStyle: 'hud-bottom', // stationary HUD card, bottom-center
    // Real pose authored in SuperSplat and carried over from the starter.
    initialPose: {
      position: [0.432,0.536,-4.077],
      target: [0.237,0.385,-1.769],
      fov: 81,
    },
    heroPoints: [
      // Authored in SuperSplat via __logPose(). Each target sits on the instrument,
      // so it doubles as the floating label's anchor.
      {
        id: 'moog-sub-phatty',
        label: 'Moog Sub Phatty',
        caption: 'Moog Sub Phatty',
        pose: { position: [0.136, 2.316, -1.546], target: [-0.081, 2.282, 0.535], fov: 81 },
        anchor: [0.458,2.519,0.465],
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
        pose: { position: [0.127, 1.872, -1.643], target: [-0.061, 1.264, 0.35], fov: 81 },
        anchor: [0.758,1.559,0.629],
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
        pose: { position: [0.215, 0.985, -1.87], target: [-0.052, 0.406, 0.123], fov: 81 },
        anchor: [.8,0.656,0.391],
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
        pose: { position: [0.122, 0.276, -1.864], target: [-0.06, -0.164, 0.173], fov: 81 },
        anchor: [1.1,-0.059,0.479],
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
        pose: { position: [0.104, -0.367, -1.887], target: [-0.058, -0.846, 0.143], fov: 81 },
        anchor: [.8,-0.87,0.479],
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
    src: 'splat/studio-e/lod-meta.json', // tiled LOD SOGS (streams by level of detail)
    cardStyle: 'hud-bottom', // demo-1 style HUD card, anchored to the bottom of the screen
    // Authored opening pose carried over from the new (half) scan's starter.
    initialPose: {
      position: [2.713,-3.842,-1.049],
      target: [2.332,-3.268,2.347],
      fov: 75,
    },
    heroPoints: [
      {
        id: 'atmos-monitors',
        label: 'Dolby Atmos Monitors',
        caption: 'PMC 6-2 · Immersive monitoring',
        icon: 'speaker',
        pose: { position: [2.229, -2.646, 2.193], target: [1.844, -2.341, 5.623], fov: 75 },
        anchor: [2.009, -1.972, 4.425],
        description: `Studio E's Atmos bed runs on PMC 6-2 monitors — a three-way active design PMC released in 2021, purpose-built for rooms where immersive mixes have to translate exactly. Twin 6" woofers, a 2" midrange, and a 1" tweeter are each driven by their own 400W Class-D amplifier, with PMC's ATL bass-loading holding tonal balance steady from quiet reference levels up to 109dB. The result: what you hear at the desk is what ships.`,
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
    // Rough starting pose aimed at the scene's actual (offset) center. Bounds are
    // floater-inflated (~31 units) so auto-framing fails; explicit pose instead.
    // REFINE with __logPose() for the real shot.
    initialPose: {
      position: [5.033,-0.679,24.31],
      target: [3.95,0.031,16.449],
      fov: 60,
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
];
