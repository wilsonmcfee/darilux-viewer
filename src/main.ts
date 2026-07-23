/* ============================================================================
   main.ts — application bootstrap and scene orchestration.
   ----------------------------------------------------------------------------
   Responsibilities:
     • create the graphics device (WebGPU→WebGL2) and the PlayCanvas app
     • set up the camera + orbit/fly controller + hero-point manager + UI
     • load ONE splat at a time, swapping scenes with a soft fade
     • run the per-frame update loop
   Scene data and copy live in demos.ts; this file is the machinery.
   ========================================================================== */

import {
  Application,
  Entity,
  Asset,
  Color,
  Vec3,
  TONEMAP_NONE,
  FILLMODE_FILL_WINDOW,
  RESOLUTION_AUTO,
  type BoundingBox,
} from 'playcanvas';
import './style.css';

import { DEMOS, type Demo, type HeroPoint, type Pose } from './demos';
import { createDevice, canRender } from './device';
import { OrbitFlyCamera } from './camera';
import { HeroPointManager } from './heropoints';
import { UI } from './ui';

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewer') as HTMLCanvasElement;

  // 0) Backstop — if the device can render nothing, show the overlay and stop.
  if (!canRender()) {
    new UI(DEMOS, {
      onSelectDemo: () => {},
      onSelectHero: () => {},
      onExitCloseup: () => {},
    }).showUnsupported();
    return;
  }

  // 1) Graphics device (WebGPU first, silent WebGL2 fallback).
  const { device } = await createDevice(canvas);

  // 2) App. We pass the device we just created; input is handled by our own
  //    controller, so we don't attach PlayCanvas's mouse/touch systems.
  const app = new Application(canvas, { graphicsDevice: device });
  app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(RESOLUTION_AUTO);

  // 3) Camera. TONEMAP_NONE keeps the baked splat colors faithful (no filmic curve).
  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(23 / 255, 16 / 255, 10 / 255, 1), // matches --bg #17100a (near-black espresso)
    fov: 55,
    toneMapping: TONEMAP_NONE,
  });
  app.root.addChild(camera);

  const controller = new OrbitFlyCamera(camera, canvas);
  const heroes = new HeroPointManager(camera, document.getElementById('hero-layer')!);

  // Expose the pose/anchor authoring helpers for the browser console.
  (window as unknown as { __logPose: () => void }).__logPose = () => controller.logPose();
  (window as unknown as { __logAnchor: () => void }).__logAnchor = () => controller.logAnchor();

  // Authoring aid: add ?author (or #author) to the URL to show a center crosshair.
  // __logAnchor() captures the point under this crosshair. Hidden for visitors.
  if (/author/i.test(location.search + location.hash)) {
    const cross = document.createElement('div');
    cross.id = 'author-crosshair';
    document.body.appendChild(cross);
    console.info('[morisot] authoring mode — aim the crosshair at a spot, run __logAnchor() for the dot position');
  }

  // 4) UI + callbacks.
  let activeIndex = -1;
  let currentSplat: Entity | null = null;
  let currentAsset: Asset | null = null;
  let homePose: Pose | null = null; // the opening framing to return to on "Exit close-up"
  let pendingFrame = false; // true while we wait for a scene's bounds to auto-frame it

  const ui = new UI(DEMOS, {
    onSelectDemo: (i) => void loadDemo(i),
    onSelectHero: (hero) => flyToHero(hero),
    onExitCloseup: () => exitCloseup(),
  });

  // Both triggers — clicking a hero dot in the scene and picking it from the
  // drawer menu — route here: fly the camera in AND pop the description card.
  heroes.onSelect = (hero) => flyToHero(hero);

  function flyToHero(hero: HeroPoint): void {
    // flyToHero enters constrained close-up mode (auto-orbit + view limits).
    // Per-hero autoOrbit config (spin vs sway, direction, pivot) rides along.
    const ao = hero.autoOrbit;
    const pivot = ao?.pivot === 'anchor' ? (hero.anchor ?? hero.pose.target) : undefined;
    controller.flyToHero(
      hero.pose,
      1.6,
      ao
        ? {
            mode: ao.mode,
            direction: ao.direction,
            pivot,
            speed: ao.speed,
            ease: ao.ease,
            amplitude: ao.amplitude,
          }
        : undefined,
    );
    // Card style is per-demo: HUD panel, or a callout pinned to the 3D point.
    const cardStyle = DEMOS[activeIndex]?.cardStyle;
    if (cardStyle === 'anchored') {
      ui.showAnchoredCard(hero);
      heroes.setActiveAnchor(hero.anchor ?? hero.pose.target);
    } else {
      ui.showHeroCard(hero, cardStyle === 'hud-bottom' ? 'bottom' : 'left');
    }
  }

  // Closing the card (× / Esc) releases the constraints and returns home.
  function exitCloseup(): void {
    controller.exitHero();
    ui.hideHeroCard();
    ui.hideAnchoredCard();
    heroes.setActiveAnchor(null);
    if (homePose) controller.flyTo(homePose, 1.3);
  }

  // ---- Scene loader: one splat at a time, with a soft fade -----------------
  async function loadDemo(index: number): Promise<void> {
    if (index === activeIndex) return;
    const demo: Demo = DEMOS[index];
    activeIndex = index;

    ui.setActiveDemo(index);
    ui.hideHeroCard();
    ui.hideAnchoredCard();
    heroes.setActiveAnchor(null);
    ui.showLoading(`Loading ${demo.title}…`);
    heroes.setVisible(false);
    pendingFrame = false; // cancel any auto-frame still pending from a prior scene

    // Tear down the previous scene so only one splat is ever in memory.
    if (currentSplat) {
      currentSplat.destroy();
      currentSplat = null;
    }
    if (currentAsset) {
      app.assets.remove(currentAsset);
      currentAsset.unload();
      currentAsset = null;
    }

    // Host-agnostic: a demo's `src` may be a local path (bundled in public/splat/
    // and served from GitHub/Cloudflare Pages) OR a full URL (e.g. a large scene
    // served from Cloudflare R2 or any CDN). Absolute URLs are used as-is; local
    // paths resolve against the Vite base so they work under /<repo>/ on Pages.
    const isAbsolute = /^https?:\/\//i.test(demo.src);
    const url = isAbsolute ? demo.src : `${import.meta.env.BASE_URL}${demo.src}`;
    // filename hints the loader which parser to use (SOGS bundle = meta.json).
    const filename = url.split('/').pop() || 'meta.json';
    const asset = new Asset(demo.id, 'gsplat', { url, filename });
    currentAsset = asset;

    asset.once('load', () => {
      const entity = new Entity(demo.id);
      // SuperSplat / splat-transform exports are flipped; the starter corrects
      // with a 180° roll. Without this the scene renders upside-down.
      entity.setLocalEulerAngles(0, 0, 180);
      entity.addComponent('gsplat', { asset });
      app.root.addChild(entity);
      currentSplat = entity;

      if (demo.initialPose) {
        controller.setPose(demo.initialPose);
        homePose = controller.getPose();
      } else {
        // No authored pose — auto-frame from the splat's bounds. Those bounds may
        // not be ready on this exact tick, so we defer to the update loop, which
        // retries until they exist (see app.on('update')). This is the fix for
        // scenes appearing blank: framing before bounds are ready aims the camera
        // at empty space.
        pendingFrame = true;
      }

      heroes.setDemo(demo);
      heroes.setVisible(true);
      ui.hideLoading();
    });

    asset.on('progress', (received: number, length: number) => {
      if (length > 0) {
        const pct = Math.floor(Math.max(0, Math.min(1, received / length)) * 100);
        ui.showLoading(`Loading ${demo.title}… ${pct}%`);
      }
    });

    asset.once('error', (err: string) => {
      console.error(`[morisot] failed to load ${url}:`, err);
      ui.showLoading(
        `Couldn't load ${demo.title}. Check public/${demo.src} exists — see README.`,
      );
    });

    app.assets.add(asset);
    app.assets.load(asset);
  }

  // ---- Frame loop ----------------------------------------------------------
  app.on('update', (dt: number) => {
    // Auto-frame a bounds-only scene as soon as its bounding box is available.
    if (pendingFrame && currentSplat) {
      const bb =
        currentSplat.gsplat?.customAabb ??
        (currentAsset?.resource as { aabb?: BoundingBox } | null)?.aabb ??
        null;
      if (bb) {
        app.root.syncHierarchy(); // ensure the 180° roll is baked into the world transform
        const center = new Vec3();
        currentSplat.getWorldTransform().transformPoint(bb.center, center);
        controller.frameBounds(center, bb.halfExtents.length());
        homePose = controller.getPose();
        pendingFrame = false;
      }
    }
    controller.update(dt);
    heroes.update();
  });

  // ---- Resize --------------------------------------------------------------
  const resize = () => app.resizeCanvas();
  window.addEventListener('resize', resize);

  app.start();

  // 5) Open on the first demo.
  await loadDemo(0);
}

boot().catch((err) => {
  console.error('[morisot] boot failed:', err);
});
