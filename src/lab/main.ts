/* ============================================================================
   lab/main.ts — reveal-lab. Dev-only parameter explorer for the bloom reveal.
   ----------------------------------------------------------------------------
   Served at /lab.html by `npm run dev`. Never built: Vite's default build input
   is the root index.html, so this entry is invisible to `npm run build`.

   The lab is a harness around src/reveal/*, not a copy of it. Every control
   writes straight into the same RevealDriver production will use, so "what the
   lab converged on" is literally the object `Export preset` prints. If a control
   here has no matching field in RevealConfig, that is a bug in the lab.

   Deliberately NOT a copy of main.ts: no editorial page, no window reparenting,
   no hero points, no loading veil. It does keep OrbitFlyCamera, because looking
   at a held frame from another angle is most of what tuning is.
   ========================================================================== */

import {
  Application,
  Asset,
  Color,
  Entity,
  Vec3,
  FILLMODE_NONE,
  RESOLUTION_AUTO,
  TONEMAP_NONE,
  type BoundingBox,
} from 'playcanvas';
import './lab.css';

import { DEMOS, type Demo } from '../demos';
import { createDevice } from '../device';
import { OrbitFlyCamera } from '../camera';
import { RevealDriver, prefersReducedMotion } from '../reveal/driver';
import {
  DEFAULTS,
  BACKDROP_DEFAULTS,
  PHASE_MODES,
  EASE_MODES,
  DISP_MODES,
  type RevealConfig,
  type BackdropConfig,
} from '../reveal/config';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $('lab-stage');
const canvas = $<HTMLCanvasElement>('viewer');

const { device, renderer } = await createDevice(canvas);

const app = new Application(canvas, { graphicsDevice: device });
app.setCanvasFillMode(FILLMODE_NONE);
app.setCanvasResolution(RESOLUTION_AUTO);

const camera = new Entity('camera');
camera.addComponent('camera', {
  clearColor: new Color(20 / 255, 16 / 255, 12 / 255, 1),
  fov: 55,
  toneMapping: TONEMAP_NONE,
});
app.root.addChild(camera);

const controller = new OrbitFlyCamera(camera, canvas);
const driver = new RevealDriver(app, camera);

/* ---------------------------------------------------------------------------
   Scene loading. One splat at a time, same as production.
   --------------------------------------------------------------------------- */

let currentDemo: Demo | null = null;
let currentSplat: Entity | null = null;
let currentAsset: Asset | null = null;
/** Set on load; cleared once the AABB exists and the reveal has begun. */
let pendingBegin: { demo: Demo; loadSeconds: number } | null = null;
let splatCount = 0;

/** Reduced motion flattens the effect, which makes the lab useless. Overridable. */
let ignoreReducedMotion = prefersReducedMotion();

function unloadScene(): void {
  if (currentSplat) {
    currentSplat.destroy();
    currentSplat = null;
  }
  if (currentAsset) {
    app.assets.remove(currentAsset);
    currentAsset.unload();
    currentAsset = null;
  }
  splatCount = 0;
}

/**
 * The resource AABB is in the splat's own space and the entity carries the
 * starter's 180 degree roll, but the reveal shader reads WORLD centres — so the
 * box has to be transformed, not just offset. Eight corners, min/max.
 */
function worldBounds(entity: Entity, local: BoundingBox): { min: Vec3; max: Vec3 } {
  const m = entity.getWorldTransform();
  const c = local.center;
  const h = local.halfExtents;
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  const p = new Vec3();
  for (let i = 0; i < 8; i++) {
    p.set(
      c.x + (i & 1 ? h.x : -h.x),
      c.y + (i & 2 ? h.y : -h.y),
      c.z + (i & 4 ? h.z : -h.z),
    );
    m.transformPoint(p, p);
    min.set(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
    max.set(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
  }
  return { min, max };
}

function loadScene(demo: Demo): void {
  currentDemo = demo;
  pendingBegin = null;
  unloadScene();
  paintSceneButtons();
  controller.setReferenceAspect(demo.refAspect ?? 16 / 9);
  setWarn(`Loading ${demo.title}…`);

  const isAbsolute = /^https?:\/\//i.test(demo.src);
  const url = isAbsolute ? demo.src : `${import.meta.env.BASE_URL}${demo.src}`;
  const filename = url.split('/').pop() || 'meta.json';
  const asset = new Asset(demo.id, 'gsplat', { url, filename });
  currentAsset = asset;
  const t0 = performance.now();

  asset.once('load', () => {
    if (currentDemo !== demo) {
      app.assets.remove(asset);
      asset.unload();
      return;
    }
    const entity = new Entity(demo.id);
    entity.setLocalEulerAngles(0, 0, 180); // SuperSplat exports are flipped
    entity.addComponent('gsplat', { asset });
    app.root.addChild(entity);
    currentSplat = entity;

    const res = asset.resource as { numSplats?: number } | null;
    splatCount = res?.numSplats ?? 0;

    if (demo.initialPose) controller.setPose(demo.initialPose);

    // Park at the seed state on the very first frame the splat exists, so it
    // never flashes at full size while we wait for its bounding box.
    driver.hold(0);
    pendingBegin = { demo, loadSeconds: (performance.now() - t0) / 1000 };
    setWarn('');
  });

  asset.on('progress', (received: number, length: number) => {
    if (currentDemo !== demo || length <= 0) return;
    setWarn(`Loading ${demo.title}… ${Math.floor((received / length) * 100)}%`);
  });

  asset.once('error', (err: string) => {
    if (currentDemo !== demo) return;
    setWarn(`Failed to load ${demo.src} — ${err}`);
  });

  app.assets.add(asset);
  app.assets.load(asset);
}

/* ---------------------------------------------------------------------------
   Frame loop: deferred reveal start, camera, frame-time sampling.
   --------------------------------------------------------------------------- */

const frameSamples: number[] = [];

app.on('update', (dt: number) => {
  if (pendingBegin && currentSplat) {
    const local =
      currentSplat.gsplat?.customAabb ??
      (currentAsset?.resource as { aabb?: BoundingBox } | null)?.aabb ??
      null;
    if (local) {
      app.root.syncHierarchy(); // bake the roll before we read the transform
      driver.begin(worldBounds(currentSplat, local), pendingBegin.loadSeconds, {
        ignoreReducedMotion,
      });
      pendingBegin = null;
      syncTransport();
    }
  }

  controller.update(dt);
  driver.update(dt);
  if (driver.isRunning) syncTransport();

  frameSamples.push(dt * 1000);
  if (frameSamples.length > 90) frameSamples.shift();
});

const ro = new ResizeObserver(() => {
  if (!stage.clientWidth || !stage.clientHeight) return;
  app.resizeCanvas(stage.clientWidth, stage.clientHeight);
  controller.refresh();
});
ro.observe(stage);

app.start();
driver.install();

/* ---------------------------------------------------------------------------
   Control panel. Built in code so lab.html stays a shell.
   --------------------------------------------------------------------------- */

const controls = $('lab-controls');
const refreshers: (() => void)[] = [];

function group(title: string): void {
  const el = document.createElement('div');
  el.className = 'lab-group';
  el.textContent = title;
  controls.appendChild(el);
}

function row(label: string): { row: HTMLDivElement; value: HTMLSpanElement } {
  const r = document.createElement('div');
  r.className = 'lab-row';
  const l = document.createElement('label');
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'lab-val';
  r.append(l, v);
  controls.appendChild(r);
  return { row: r, value: v };
}

function note(parent: HTMLElement, text: string, warn = false): HTMLElement {
  const n = document.createElement('div');
  n.className = warn ? 'lab-note warn' : 'lab-note';
  n.textContent = text;
  parent.appendChild(n);
  return n;
}

function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
): HTMLDivElement {
  const { row: r, value } = row(label);
  const input = document.createElement('input');
  input.type = 'range';
  Object.assign(input, { min: String(min), max: String(max), step: String(step) });
  const paint = () => {
    input.value = String(get());
    value.textContent = fmt(get());
  };
  input.addEventListener('input', () => {
    set(parseFloat(input.value));
    paint();
    drawCurve();
  });
  r.appendChild(input);
  refreshers.push(paint);
  paint();
  return r;
}

function dropdown<T extends string>(
  label: string,
  options: readonly T[],
  get: () => T,
  set: (v: T) => void,
): HTMLDivElement {
  const { row: r } = row(label);
  const sel = document.createElement('select');
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  });
  const paint = () => {
    sel.value = get();
  };
  sel.addEventListener('change', () => {
    set(sel.value as T);
    drawCurve();
  });
  r.appendChild(sel);
  refreshers.push(paint);
  paint();
  return r;
}

function swatch(label: string, get: () => string, set: (v: string) => void): HTMLDivElement {
  const { row: r } = row(label);
  const input = document.createElement('input');
  input.type = 'color';
  const paint = () => {
    input.value = get();
  };
  input.addEventListener('input', () => set(input.value));
  r.appendChild(input);
  refreshers.push(paint);
  paint();
  return r;
}

function toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLDivElement {
  const { row: r, value } = row(label);
  value.remove();
  const input = document.createElement('input');
  input.type = 'checkbox';
  const paint = () => {
    input.checked = get();
  };
  input.addEventListener('change', () => set(input.checked));
  r.appendChild(input);
  refreshers.push(paint);
  paint();
  return r;
}

// Shorthands that write through the driver so uniforms update on the same tick.
const cfg = <K extends keyof RevealConfig>(k: K) => () => driver.config[k];
const setCfg = <K extends keyof RevealConfig>(k: K) => (v: RevealConfig[K]) =>
  driver.setConfig({ [k]: v } as Partial<RevealConfig>);
const bd = <K extends keyof BackdropConfig>(k: K) => () => driver.backdropConfig[k];
const setBd = <K extends keyof BackdropConfig>(k: K) => (v: BackdropConfig[K]) =>
  driver.setBackdrop({ [k]: v } as Partial<BackdropConfig>);

group('Phase — when each splat starts');
dropdown('Phase function', PHASE_MODES, cfg('phase'), setCfg('phase'));
const hashRow = slider('Hash blend', 0, 1, 0.01, cfg('hashBlend'), setCfg('hashBlend'));
note(
  hashRow,
  'A structured sweep alone is a hard plane sliding through the room. 0.2–0.3 of hash turns it into a soft advancing front — the biggest quality lever here.',
);
slider('Spread', 0, 1, 0.01, cfg('spread'), setCfg('spread'));

group('Curve');
slider('Duration', 0.5, 6, 0.05, cfg('duration'), setCfg('duration'), (v) => `${v.toFixed(2)}s`);
dropdown('Easing', EASE_MODES, cfg('ease'), setCfg('ease'));

group('Scale & opacity');
slider('Seed scale', 0.005, 0.4, 0.005, cfg('seedScale'), setCfg('seedScale'), (v) => v.toFixed(3));
slider('Opacity lead', 0, 0.5, 0.01, cfg('opacityLead'), setCfg('opacityLead'));
const floorRow = slider(
  'Seed alpha floor',
  0,
  1,
  0.01,
  cfg('seedAlphaFloor'),
  setCfg('seedAlphaFloor'),
);
note(
  floorRow,
  'Not cosmetic. The engine multiplies alpha by an AA factor that goes to zero with projected area, then shrinks the quad again near the alpha clip. At 0 the seed state is invisible however small you set the scale.',
);
const gateRow = slider('Seed gate', 0, 1, 0.01, cfg('seedGate'), setCfg('seedGate'));
const gateNote = note(gateRow, '');

group('Displacement');
const dispRow = slider('Magnitude', 0, 2, 0.01, cfg('disp'), setCfg('disp'), (v) => `${v.toFixed(2)}m`);
const dispNote = note(dispRow, '');
dropdown('Direction', DISP_MODES, cfg('dispMode'), setCfg('dispMode'));

group('Colour');
swatch('Seed tint', cfg('tint'), setCfg('tint'));
slider('Tint strength', 0, 0.6, 0.01, cfg('tintStrength'), setCfg('tintStrength'));

group('Backdrop');
const seedBgRow = swatch('Seed background', bd('seedColor'), setBd('seedColor'));
note(
  seedBgRow,
  'The brand argument is for revealing against paper (#efeae2), not the black void every other 3DGS viewer uses. The shipped window is a dark shell, so this is the crossfade to tune, not a fixed choice.',
);
swatch('Rest background', bd('finalColor'), setBd('finalColor'));
slider('Crossfade', 0, 1, 0.01, bd('crossfade'), setBd('crossfade'));

group('Engine levers');
const mpsRow = slider(
  'Min pixel size',
  0,
  3,
  0.05,
  cfg('minPixelSize'),
  setCfg('minPixelSize'),
  (v) => `${v.toFixed(2)}px`,
);
const mpsNote = note(mpsRow, '');
const aaRow = toggle('Anti-alias (GSPLAT_AA)', cfg('antiAlias'), setCfg('antiAlias'));
note(aaRow, 'Shader define — toggling recompiles. Off lets sub-pixel splats keep their alpha.');

group('Timing policy');
const timingRow = dropdown(
  'Policy',
  ['theatrical', 'honest', 'hybrid'] as const,
  cfg('timing'),
  setCfg('timing'),
);
note(
  timingRow,
  'All three are duration functions of measured load time. Splats cannot bloom as bytes arrive: a SOG bundle has no renderable partial state, so the scene pops into existence when the last sub-asset decodes.',
);
slider('Duration floor', 0.5, 4, 0.05, cfg('durationFloor'), setCfg('durationFloor'), (v) => `${v.toFixed(2)}s`);
const slopeRow = slider('Load-time slope', 0, 0.5, 0.01, cfg('loadTimeSlope'), setCfg('loadTimeSlope'));
note(
  slopeRow,
  'Seconds shaved off the reveal per second of load beyond 2s. Shortens on a slow load: someone who waited nine seconds does not want a longer animation.',
);
slider('Veil handoff', 0, 600, 10, cfg('veilHandoff'), setCfg('veilHandoff'), (v) => `${v | 0}ms`);
toggle('Ignore reduced motion', () => ignoreReducedMotion, (v) => {
  ignoreReducedMotion = v;
});

/** Notes that depend on current values rather than being static. */
function paintDynamicNotes(): void {
  const c = driver.config;
  dispNote.textContent =
    c.disp <= 0
      ? 'Zero. Position offsets are coupled to (1-e), so the stale sort is invisible while splats are small.'
      : c.disp > 0.35
        ? `${c.disp.toFixed(2)}m is a fly-in, not a settle — the depth sort runs on undisplaced centres, so expect visible blend errors mid-reveal. That is the point of showing it rather than clamping it.`
        : 'A settle. Small enough that the stale sort stays invisible.';
  dispNote.className = c.disp > 0.35 ? 'lab-note warn' : 'lab-note';

  gateNote.textContent =
    c.seedGate >= 0.6
      ? `At ${c.seedGate.toFixed(2)} nearly every splat in the scene is drawn from the first frame. On a 2.5M-splat room that is fog, not a point cloud, and it is where the frame-time cost comes from.`
      : c.seedGate <= 0.02
        ? 'Fully gated: an advancing front with empty space ahead of it. Cheapest, and the strongest "assembling" read — but the opening frame is empty, so watch the veil handoff.'
        : 'A faint haze ahead of the front. Enough to hint at the room before it arrives without washing it out.';
  gateNote.className = c.seedGate >= 0.6 ? 'lab-note warn' : 'lab-note';

  const kills = c.minPixelSize >= 1.6;
  mpsNote.textContent = kills
    ? `At ${c.minPixelSize.toFixed(2)}px the engine discards any splat projecting smaller than that, and covariance dilation floors a zero-scale splat near 1.55px — so the seed state is culled outright. Engine default is 2.`
    : 'Below ~1.55px, sub-pixel splats survive the cull and read as dots. Restored to the engine default of 2 when the reveal finishes.';
  mpsNote.className = kills ? 'lab-note warn' : 'lab-note';
}

/* ---------------------------------------------------------------------------
   Scene switcher — a curve tuned on one room is not right on another.
   --------------------------------------------------------------------------- */

const sceneBar = $('lab-scenes');
const sceneButtons = DEMOS.map((demo) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = demo.title;
  b.addEventListener('click', () => loadScene(demo));
  sceneBar.appendChild(b);
  return { demo, el: b };
});

function paintSceneButtons(): void {
  sceneButtons.forEach(({ demo, el }) =>
    el.setAttribute('aria-pressed', String(demo === currentDemo)),
  );
}

/* ---------------------------------------------------------------------------
   Transport — holding at t = 0.35 and looking at it beats watching it play
   fifty times.
   --------------------------------------------------------------------------- */

const scrub = $<HTMLInputElement>('lab-scrub');
const scrubRead = $<HTMLOutputElement>('lab-scrub-read');
let scrubbing = false;

scrub.addEventListener('pointerdown', () => {
  scrubbing = true;
});
scrub.addEventListener('pointerup', () => {
  scrubbing = false;
});
scrub.addEventListener('input', () => {
  driver.hold(parseInt(scrub.value, 10) / 1000);
  syncTransport();
});

$('lab-replay').addEventListener('click', replay);
document.addEventListener('keydown', (e) => {
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !/input|select/i.test((e.target as HTMLElement)?.tagName ?? '')) {
    replay();
  }
});

function replay(): void {
  if (!currentSplat) return;
  const local =
    currentSplat.gsplat?.customAabb ??
    (currentAsset?.resource as { aabb?: BoundingBox } | null)?.aabb ??
    null;
  if (!local) return;
  driver.begin(worldBounds(currentSplat, local), 2, { ignoreReducedMotion });
  syncTransport();
}

function syncTransport(): void {
  const p = driver.progress;
  if (!scrubbing) scrub.value = String(Math.round(p * 1000));
  scrubRead.textContent = `t ${p.toFixed(3)}  ·  ${driver.wallTime.toFixed(2)}s`;
}

/* ---------------------------------------------------------------------------
   Curve preview. Two envelopes — the first splat to bloom and the last — plus
   the lead-ahead alpha ramp, over normalised reveal time. This is where spread
   becomes legible.
   --------------------------------------------------------------------------- */

const curve = $<HTMLCanvasElement>('lab-curve');
const cx = curve.getContext('2d')!;

function ease(t: number, mode: string): number {
  const inv = 1 - t;
  switch (mode) {
    case 'quint': return 1 - inv ** 5;
    case 'back': {
      const c1 = 1.70158;
      return 1 - (c1 + 1) * inv ** 3 + c1 * inv ** 2;
    }
    case 'expo': return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
    case 'cubic':
    default: return 1 - inv ** 3;
  }
}

function drawCurve(): void {
  paintDynamicNotes();
  const c = driver.config;
  const W = curve.width;
  const H = curve.height;
  const pad = 16;
  const w = W - pad * 2;
  const h = H - pad * 2;
  const total = 1 + c.spread;

  cx.clearRect(0, 0, W, H);
  cx.strokeStyle = 'rgba(242,237,229,0.14)';
  cx.lineWidth = 1;
  cx.strokeRect(pad, pad, w, h);

  const plot = (phase: number, lead: number, color: string, width: number, dash: number[]) => {
    cx.beginPath();
    cx.setLineDash(dash);
    cx.strokeStyle = color;
    cx.lineWidth = width;
    for (let i = 0; i <= 120; i++) {
      const s = i / 120;
      const u = s * total;
      const t = Math.max(0, Math.min(1, u - phase * c.spread + lead));
      const e = ease(t, c.ease);
      const x = pad + s * w;
      const y = pad + h - Math.max(0, Math.min(1.15, e)) / 1.15 * h;
      if (i === 0) cx.moveTo(x, y);
      else cx.lineTo(x, y);
    }
    cx.stroke();
    cx.setLineDash([]);
  };

  // Alpha ramps first, so the scale envelopes read on top.
  plot(0, c.opacityLead, 'rgba(184,57,46,0.55)', 1, [3, 3]);
  plot(1, c.opacityLead, 'rgba(184,57,46,0.55)', 1, [3, 3]);
  plot(0, 0, 'rgba(242,237,229,0.95)', 1.75, []);
  plot(1, 0, 'rgba(242,237,229,0.5)', 1.75, []);

  // Playhead.
  const px = pad + Math.max(0, Math.min(1, driver.progress)) * w;
  cx.beginPath();
  cx.strokeStyle = '#b8392e';
  cx.lineWidth = 1;
  cx.moveTo(px, pad);
  cx.lineTo(px, pad + h);
  cx.stroke();

  cx.fillStyle = 'rgba(242,237,229,0.42)';
  cx.font = '11px Inter, system-ui, sans-serif';
  cx.fillText('first splat', pad + 4, pad + 13);
  cx.fillText('last splat', pad + 4, pad + 27);
  cx.fillText(`${driver.wallTime.toFixed(2)}s total`, pad + w - 74, pad + h - 6);
}

/* ---------------------------------------------------------------------------
   HUD + export.
   --------------------------------------------------------------------------- */

const fpsEl = $('lab-fps');
const rendererEl = $('lab-renderer');
const splatsEl = $('lab-splats');
const warnEl = $('lab-warn');

rendererEl.textContent = renderer;

function setWarn(text: string): void {
  warnEl.textContent = text;
  warnEl.hidden = !text;
}

setInterval(() => {
  if (frameSamples.length) {
    const sorted = [...frameSamples].sort((a, b) => a - b);
    const avg = frameSamples.reduce((s, v) => s + v, 0) / frameSamples.length;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    fpsEl.textContent = `${avg.toFixed(1)} ms avg · ${p95.toFixed(1)} p95`;
  }
  splatsEl.textContent = splatCount ? `${(splatCount / 1e6).toFixed(2)}M splats` : '—';
  drawCurve();
}, 250);

function preset(): { reveal: RevealConfig; backdrop: BackdropConfig } {
  return { reveal: { ...driver.config }, backdrop: { ...driver.backdropConfig } };
}

/**
 * Same idiom as __logPose() / __logAnchor(): print something pasteable. This is
 * how the lab's output reaches production — the printed object goes straight
 * into DEFAULTS in src/reveal/config.ts.
 */
function logReveal(): void {
  const p = preset();
  const text = `// reveal-lab preset — tuned on "${currentDemo?.title ?? 'unknown'}" (${renderer})
export const DEFAULTS: RevealConfig = ${JSON.stringify(p.reveal, null, 2)};

export const BACKDROP_DEFAULTS: BackdropConfig = ${JSON.stringify(p.backdrop, null, 2)};`;
  console.log(text);
  navigator.clipboard?.writeText(text).then(
    () => setWarn('Preset copied to clipboard and logged to the console.'),
    () => setWarn('Preset logged to the console (clipboard blocked).'),
  );
  setTimeout(() => setWarn(''), 4000);
}

$('lab-export').addEventListener('click', logReveal);
$('lab-reset').addEventListener('click', () => {
  driver.setConfig({ ...DEFAULTS });
  driver.setBackdrop({ ...BACKDROP_DEFAULTS });
  refreshers.forEach((f) => f());
  drawCurve();
});

(window as unknown as { __logReveal: () => void }).__logReveal = logReveal;
// The driver itself, for poking at values the panel does not expose and for
// scripted A/B measurements (hold a frame, change one lever, read the HUD).
(window as unknown as { __reveal: RevealDriver }).__reveal = driver;

if (prefersReducedMotion()) {
  setWarn(
    'prefers-reduced-motion is ON for this OS. The lab is overriding it so you can tune; production flattens to an opacity crossfade.',
  );
}

loadScene(DEMOS[DEMOS.length - 1]); // Bluedio: the heaviest scene, worst case first
drawCurve();
console.info('[reveal-lab] ready — R replays, __logReveal() prints the preset');
