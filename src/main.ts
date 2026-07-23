/* ============================================================================
   main.ts — application bootstrap and scene orchestration.
   ----------------------------------------------------------------------------
   Architecture: the page is a normal scrolling editorial layout with styled
   "viewer windows". ONE shared stage (#stage: canvas + hero layer + cards +
   loading veil) is created lazily on the first "Enter" click and MOVED into
   whichever window the visitor enters. Entering another window reparents the
   stage there and swaps the scene; the previous window returns to its poster.
   Only one splat is ever in memory at a time.

   Responsibilities:
     • create the graphics device (WebGPU→WebGL2) and the PlayCanvas app —
       lazily, so the page itself stays light until a viewer is entered
     • size the canvas to its host window (FILLMODE_NONE + ResizeObserver)
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
  FILLMODE_NONE,
  RESOLUTION_AUTO,
  type BoundingBox,
} from 'playcanvas';
import './style.css';

import { DEMOS, type Demo, type HeroPoint, type Pose } from './demos';
import { createDevice, canRender } from './device';
import { OrbitFlyCamera } from './camera';
import { HeroPointManager } from './heropoints';
import { UI } from './ui';

function boot(): void {
  const stage = document.getElementById('stage') as HTMLElement;
  const canvas = document.getElementById('viewer') as HTMLCanvasElement;

  // ---- App state (the app itself is created lazily on first Enter) ---------
  let app: Application | null = null;
  let controller: OrbitFlyCamera | null = null;
  let heroes: HeroPointManager | null = null;

  let activeDemo: Demo | null = null;
  let currentSplat: Entity | null = null;
  let currentAsset: Asset | null = null;
  let homePose: Pose | null = null; // the opening framing to return to on "Exit close-up"
  let pendingFrame = false; // true while we wait for a scene's bounds to auto-frame it
  let pendingHero: HeroPoint | null = null; // fly here once the scene finishes loading

  const ui = new UI(DEMOS, {
    onEnterViewer: (demoId) => enterViewer(demoId),
    onExitViewer: () => exitViewer(),
    onSelectHero: (hero) => selectHero(hero),
    onExitCloseup: () => exitCloseup(),
  });

  // ---- Lazy engine creation -------------------------------------------------
  async function ensureApp(): Promise<boolean> {
    if (app) return true;

    // Backstop — if the device can render nothing, show the overlay and stop.
    if (!canRender()) {
      ui.showUnsupported();
      return false;
    }

    // Graphics device (WebGPU first, silent WebGL2 fallback).
    const { device } = await createDevice(canvas);

    // The canvas is sized by its host window (CSS 100%), not the browser window:
    // FILLMODE_NONE + RESOLUTION_AUTO track the element's client size.
    app = new Application(canvas, { graphicsDevice: device });
    app.setCanvasFillMode(FILLMODE_NONE);
    app.setCanvasResolution(RESOLUTION_AUTO);

    // Camera. TONEMAP_NONE keeps the baked splat colors faithful (no filmic curve).
    const camera = new Entity('camera');
    camera.addComponent('camera', {
      clearColor: new Color(20 / 255, 16 / 255, 12 / 255, 1), // matches the window shell #14100c
      fov: 55,
      toneMapping: TONEMAP_NONE,
    });
    app.root.addChild(camera);

    controller = new OrbitFlyCamera(camera, canvas);
    heroes = new HeroPointManager(camera, document.getElementById('hero-layer')!);
    heroes.onSelect = (hero) => selectHero(hero);

    // Expose the pose/anchor authoring helpers for the browser console.
    (window as unknown as { __logPose: () => void }).__logPose = () => controller!.logPose();
    (window as unknown as { __logAnchor: () => void }).__logAnchor = () => controller!.logAnchor();

    // Authoring aid: add ?author (or #author) to the URL to show a center crosshair.
    // __logAnchor() captures the point under this crosshair. Hidden for visitors.
    if (/author/i.test(location.search + location.hash)) {
      const cross = document.createElement('div');
      cross.id = 'author-crosshair';
      stage.appendChild(cross);
      console.info('[darilux] authoring mode — aim the crosshair at a spot, run __logAnchor() for the dot position');
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
          app!.root.syncHierarchy(); // ensure the 180° roll is baked into the world transform
          const center = new Vec3();
          currentSplat.getWorldTransform().transformPoint(bb.center, center);
          controller!.frameBounds(center, bb.halfExtents.length());
          homePose = controller!.getPose();
          pendingFrame = false;
        }
      }
      controller!.update(dt);
      heroes!.update();
    });

    // ---- Resize: track the HOST WINDOW, not the browser window ---------------
    // The stage is reparented between differently-sized windows, so a
    // ResizeObserver (which also fires on reparent) keeps the buffer in sync.
    const ro = new ResizeObserver(() => {
      app?.resizeCanvas(stage.clientWidth, stage.clientHeight);
    });
    ro.observe(stage);

    app.start();
    return true;
  }

  // ---- Entering / leaving a viewer window -----------------------------------
  async function enterViewer(demoId: string): Promise<void> {
    const demo = DEMOS.find((d) => d.id === demoId);
    if (!demo) {
      console.error(`[darilux] unknown demo "${demoId}"`);
      return;
    }
    if (activeDemo?.id === demoId) return;

    // Move the stage into the chosen window FIRST (its poster hides via `.live`)
    // so the canvas has a real size when the graphics device is created.
    const win = ui.windowFor(demoId);
    win.appendChild(stage);
    ui.setLive(demoId);

    if (!(await ensureApp())) {
      // Unsupported device — give the window its poster back.
      ui.setLive(null);
      document.getElementById('stage-dock')!.appendChild(stage);
      return;
    }
    app!.resizeCanvas(stage.clientWidth, stage.clientHeight);

    await loadDemo(demo);
  }

  // The × on the stage: unload the scene (frees GPU + JS memory) and give the
  // window its poster back. The engine stays warm for the next Enter.
  function exitViewer(): void {
    if (!activeDemo) return;
    exitCloseupUI();
    unloadScene();
    activeDemo = null;
    pendingHero = null;
    ui.setLive(null);
    ui.hideLoading();
    document.getElementById('stage-dock')!.appendChild(document.getElementById('stage')!);
  }

  // ---- Hero points -----------------------------------------------------------
  // Both triggers — clicking a hero dot in the scene and picking a synth from
  // the collection list — route here. If the hero's scene isn't live yet (list
  // click while the window shows its poster), enter the viewer first and fly
  // once the splat has loaded.
  function selectHero(hero: HeroPoint): void {
    const owner = DEMOS.find((d) => d.heroPoints.includes(hero));
    if (!owner) return;
    if (activeDemo?.id !== owner.id) {
      pendingHero = hero;
      void enterViewer(owner.id);
      return;
    }
    flyToHero(hero);
  }

  function flyToHero(hero: HeroPoint): void {
    // flyToHero enters constrained close-up mode (auto-orbit + view limits).
    // Per-hero autoOrbit config (spin vs sway, direction, pivot) rides along.
    const ao = hero.autoOrbit;
    const pivot = ao?.pivot === 'anchor' ? (hero.anchor ?? hero.pose.target) : undefined;
    controller!.flyToHero(
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
    const cardStyle = activeDemo?.cardStyle;
    if (cardStyle === 'anchored') {
      ui.showAnchoredCard(hero);
      heroes!.setActiveAnchor(hero.anchor ?? hero.pose.target);
    } else {
      ui.showHeroCard(hero, cardStyle === 'hud-bottom' ? 'bottom' : 'left');
    }
  }

  // Closing the card (× / Esc) releases the constraints and returns home.
  function exitCloseup(): void {
    if (!controller) return;
    controller.exitHero();
    exitCloseupUI();
    if (homePose) controller.flyTo(homePose, 1.3);
  }

  function exitCloseupUI(): void {
    ui.hideHeroCard();
    ui.hideAnchoredCard();
    heroes?.setActiveAnchor(null);
  }

  // ---- Scene loader: one splat at a time, with a soft fade -------------------
  function unloadScene(): void {
    if (currentSplat) {
      currentSplat.destroy();
      currentSplat = null;
    }
    if (currentAsset && app) {
      app.assets.remove(currentAsset);
      currentAsset.unload();
      currentAsset = null;
    }
  }

  async function loadDemo(demo: Demo): Promise<void> {
    activeDemo = demo;

    exitCloseupUI();
    ui.showLoading(`Loading ${demo.title}…`);
    heroes!.setVisible(false);
    pendingFrame = false; // cancel any auto-frame still pending from a prior scene

    // Tear down the previous scene so only one splat is ever in memory.
    unloadScene();

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
      if (activeDemo !== demo) return; // visitor entered another window mid-load
      const entity = new Entity(demo.id);
      // SuperSplat / splat-transform exports are flipped; the starter corrects
      // with a 180° roll. Without this the scene renders upside-down.
      entity.setLocalEulerAngles(0, 0, 180);
      entity.addComponent('gsplat', { asset });
      app!.root.addChild(entity);
      currentSplat = entity;

      if (demo.initialPose) {
        controller!.setPose(demo.initialPose);
        homePose = controller!.getPose();
      } else {
        // No authored pose — auto-frame from the splat's bounds. Those bounds may
        // not be ready on this exact tick, so we defer to the update loop, which
        // retries until they exist (see app.on('update')). Framing before bounds
        // are ready aims the camera at empty space.
        pendingFrame = true;
      }

      heroes!.setDemo(demo);
      heroes!.setVisible(true);
      ui.hideLoading();

      // A synth picked from the collection list while the window was dormant:
      // now that the scene is in, complete the fly-in.
      if (pendingHero && demo.heroPoints.includes(pendingHero)) {
        const hero = pendingHero;
        pendingHero = null;
        flyToHero(hero);
      }
    });

    asset.on('progress', (received: number, length: number) => {
      if (activeDemo !== demo) return;
      if (length > 0) {
        const pct = Math.floor(Math.max(0, Math.min(1, received / length)) * 100);
        ui.showLoading(`Loading ${demo.title}… ${pct}%`);
      }
    });

    asset.once('error', (err: string) => {
      console.error(`[darilux] failed to load ${url}:`, err);
      ui.showLoading(
        `Couldn't load ${demo.title}. Check public/${demo.src} exists — see README.`,
      );
    });

    app!.assets.add(asset);
    app!.assets.load(asset);
  }
}

boot();
