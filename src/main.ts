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
  CameraFrame,
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
import { SplatPicker } from './splatpick';
import { UI } from './ui';

function boot(): void {
  const stage = document.getElementById('stage') as HTMLElement;
  const canvas = document.getElementById('viewer') as HTMLCanvasElement;

  // Authoring mode (?author / #author): crosshair, pose panel, splat-snap
  // anchor picking. The picker decodes each scene's splat centers on the CPU —
  // author-only cost, never paid by visitors.
  const authorMode = /author/i.test(location.search + location.hash);
  const picker = new SplatPicker();

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

    /* ---- Sharpen A/B (authoring aid) -------------------------------------
       PlayCanvas ships AMD CAS (Contrast Adaptive Sharpening) in CameraFrame's
       compose pass. CAS sharpens low-contrast regions hard and backs off on
       high-contrast edges, so it avoids the halo ringing a naive unsharp mask
       would put around every gaussian.

       OFF BY DEFAULT, and deliberately not merely disabled: with no ?sharpen
       param no CameraFrame is constructed at all, so the three client demos
       render through the exact same path as before this was added. Constructing
       a CameraFrame installs framePasses and switches the camera to an
       offscreen HDR target + compose pass.

         ?sharpen=0.3     set the starting amount (0..1, 0 = off)
         __sharpen(0.4)   change it live in the console, no reload
         __sharpen(0)     tear the pass back down and release its resources

       toneMapping is pinned to the camera's TONEMAP_NONE. CameraFrame defaults
       rendering.toneMapping to TONEMAP_LINEAR, which would shift colour the
       moment sharpening turned on and make the A/B a comparison of two things
       at once.
       -------------------------------------------------------------------- */
    let camFrame: CameraFrame | null = null;
    const setSharpen = (amount: number): number => {
      const v = Math.max(0, Math.min(1, Number(amount) || 0));
      if (v === 0) {
        if (camFrame) camFrame.enabled = false;
        return 0;
      }
      if (!camFrame) camFrame = new CameraFrame(app!, camera.camera!);
      camFrame.enabled = true;
      camFrame.rendering.toneMapping = TONEMAP_NONE;
      camFrame.rendering.sharpness = v;
      camFrame.update();
      return v;
    };
    (window as unknown as { __sharpen: (n: number) => number }).__sharpen = setSharpen;

    const sharpenParam = Number(
      new URLSearchParams(window.location.search).get('sharpen') ?? '0',
    );
    if (sharpenParam > 0) setSharpen(sharpenParam);

    // Expose the pose/anchor authoring helpers for the browser console.
    (window as unknown as { __logPose: () => void }).__logPose = () => controller!.logPose();
    (window as unknown as { __logAnchor: () => void }).__logAnchor = () => controller!.logAnchor();

    // Authoring aid: add ?author (or #author) to the URL for authoring mode —
    // a center crosshair plus an on-screen panel with a live pose readout and
    // Copy pose / Copy anchor buttons (no console needed; works on touch).
    // The console helpers (__logPose / __logAnchor) still work as a fallback.
    if (authorMode) {
      const cross = document.createElement('div');
      cross.id = 'author-crosshair';
      stage.appendChild(cross);

      const panel = document.createElement('div');
      panel.id = 'author-panel';
      panel.innerHTML =
        `<div id="author-readout"></div>
         <div class="author-btns">
           <button type="button" id="author-copy-pose">Copy pose</button>
           <button type="button" id="author-snap-anchor">Snap anchor</button>
           <button type="button" id="author-copy-anchor">Free anchor</button>
         </div>`;
      stage.appendChild(panel);

      // The last splat-snapped pick, shown as a live dot so you can verify it
      // sticks to the surface while orbiting/zooming (no parallax slide).
      let pickedWorld: Vec3 | null = null;
      const pickedDot = document.createElement('div');
      pickedDot.id = 'author-picked';
      stage.appendChild(pickedDot);
      const screenTmp = new Vec3();
      app.on('update', () => {
        if (!pickedWorld || !camera.camera) {
          pickedDot.style.display = 'none';
          return;
        }
        camera.camera.worldToScreen(pickedWorld, screenTmp);
        pickedDot.style.display = screenTmp.z > 0 ? '' : 'none';
        pickedDot.style.left = `${screenTmp.x}px`;
        pickedDot.style.top = `${screenTmp.y}px`;
      });

      const readout = panel.querySelector('#author-readout') as HTMLElement;
      const fmt = (v: number[]) => `[${v.join(', ')}]`;
      // Live readout — cheap, so just poll. getPose() is side-effect free.
      window.setInterval(() => {
        const p = controller!.getPose();
        readout.textContent =
          `pos ${fmt(p.position)}\ntgt ${fmt(p.target)}\nfov ${p.fov}`;
      }, 150);

      // Copy → clipboard when available (localhost/https), console otherwise.
      const copy = async (snippet: string, btn: HTMLButtonElement) => {
        let ok = true;
        try {
          await navigator.clipboard.writeText(snippet);
        } catch {
          ok = false;
          console.log('[darilux] copy blocked — paste from here:\n' + snippet);
        }
        const original = btn.textContent;
        btn.textContent = ok ? 'Copied ✓' : 'See console';
        window.setTimeout(() => (btn.textContent = original), 1200);
      };
      panel.querySelector('#author-copy-pose')!.addEventListener('click', () => {
        const p = controller!.getPose();
        void copy(
          `pose: { position: ${fmt(p.position)}, target: ${fmt(p.target)}, fov: ${p.fov} },`,
          panel.querySelector('#author-copy-pose') as HTMLButtonElement,
        );
      });
      panel.querySelector('#author-copy-anchor')!.addEventListener('click', () => {
        // "Free anchor": the raw orbit target (screen-center, but at the orbit
        // pivot's depth — may float off the surface). Prefer Snap anchor.
        const p = controller!.getPose();
        void copy(
          `anchor: ${fmt(p.target)},`,
          panel.querySelector('#author-copy-anchor') as HTMLButtonElement,
        );
      });

      // ---- Splat-snapped anchor picking ------------------------------------
      // Casts a ray and snaps to the nearest actual splat center, so the
      // anchor sits ON the captured surface. A dot authored this way cannot
      // parallax-slide across the gear when the visitor zooms or orbits.
      const PICK_PX = 8; // screen-space pick tolerance
      const snapBtn = panel.querySelector('#author-snap-anchor') as HTMLButtonElement;
      const pickAt = (cssX: number, cssY: number): void => {
        const cc = camera.camera;
        if (!cc || !currentSplat) return;
        if (!picker.ready) {
          snapBtn.textContent = 'Decoding…';
          window.setTimeout(() => (snapBtn.textContent = 'Snap anchor'), 1200);
          return;
        }
        const far = cc.screenToWorld(cssX, cssY, cc.farClip);
        const origin = camera.getPosition();
        const dir = new Vec3().sub2(far, origin).normalize();
        const tanRadius =
          Math.tan((cc.fov * Math.PI) / 360) * ((2 * PICK_PX) / Math.max(canvas.clientHeight, 1));
        const hit = picker.pick(origin, dir, tanRadius, currentSplat.getWorldTransform());
        if (!hit) return;
        pickedWorld = new Vec3(hit[0], hit[1], hit[2]);
        void copy(`anchor: [${hit.join(', ')}],`, snapBtn);
      };
      // Button: pick whatever is under the center crosshair.
      snapBtn.addEventListener('click', () =>
        pickAt(canvas.clientWidth / 2, canvas.clientHeight / 2),
      );
      // Double-click / double-tap: pick under the cursor (doesn't fight orbit-drag).
      canvas.addEventListener('dblclick', (e) => {
        const rect = canvas.getBoundingClientRect();
        pickAt(e.clientX - rect.left, e.clientY - rect.top);
      });

      console.info('[darilux] authoring mode — Copy pose for framings; Snap anchor (or double-click) pins to the splat surface');
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
    });

    // Marker projection runs on PRERENDER, not on update, and that placement is
    // load-bearing. CameraComponent.onAppPrerender() is the ONLY thing that
    // dirties the camera's cached view matrix (moving the entity does not), and
    // the render then consumes and clears it. So a worldToScreen() call from
    // inside app.on('update') silently reprojects with the PREVIOUS frame's
    // camera pose, and the markers lag the camera by a frame whenever it moves.
    // Registering here means this listener runs after the camera component's own
    // prerender handler — added when the component was created, above — so the
    // matrix is rebuilt from the transform controller.update() just wrote.
    app.on('prerender', () => heroes!.update());

    // ---- Resize: track the HOST WINDOW, not the browser window ---------------
    // The stage is reparented between differently-sized windows, so a
    // ResizeObserver (which also fires on reparent) keeps the buffer in sync.
    const ro = new ResizeObserver(() => {
      // When the stage is parked in the hidden dock (viewer closed) it
      // measures 0×0. Resizing the swapchain to zero creates invalid WebGPU
      // textures and every subsequent frame submits an invalid command
      // buffer — the console spam that drags the whole page down. Skip it.
      if (!stage.clientWidth || !stage.clientHeight) return;
      app?.resizeCanvas(stage.clientWidth, stage.clientHeight);
      // The viewport shape changed (rotation / reparenting into another
      // window) — re-apply the camera so its aspect-compensated fov tracks it.
      controller?.refresh();
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
    app!.autoRender = true; // wake the renderer (paused while no viewer is live)
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
    // Pause rendering while the stage is parked — there's nothing to draw,
    // and it keeps the (0-sized) canvas from ever reaching the GPU.
    if (app) app.autoRender = false;
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

  /**
   * Orbit pivot for a hero, pushed PAST its surface anchor.
   *
   * `anchor` is a point on the object's FRONT FACE. Orbiting a front-face point
   * sweeps the camera around the skin of the object rather than around its mass,
   * which reads as looking side to side instead of circling the piece. Pushing
   * the pivot roughly to the object's middle makes the same drag arc around it.
   *
   * The push is along the camera→anchor ray, and the anchor already lies on the
   * pose's view ray, so the pivot stays collinear with the authored framing:
   * yaw and pitch are untouched and only the orbit RADIUS changes. Landing
   * framing is therefore identical to before.
   */
  const HERO_PIVOT_PUSH = 0.18; // fraction of the camera→anchor distance

  function orbitPivot(hero: HeroPoint): [number, number, number] | undefined {
    if (hero.autoOrbit?.pivot !== 'anchor') return undefined;
    const a = hero.anchor ?? hero.pose.target;
    const p = hero.pose.position;
    const k = 1 + HERO_PIVOT_PUSH;
    return [p[0] + (a[0] - p[0]) * k, p[1] + (a[1] - p[1]) * k, p[2] + (a[2] - p[2]) * k];
  }

  function flyToHero(hero: HeroPoint): void {
    // flyToHero enters constrained close-up mode (auto-orbit + view limits).
    // Per-hero autoOrbit config (spin vs sway, direction, pivot) rides along.
    const ao = hero.autoOrbit;
    const pivot = orbitPivot(hero);
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
      ui.showHeroCard(hero, cardStyle === 'hud-bottom' ? 'bottom' : 'left', activeDemo?.id);
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

    // Poses are authored at this demo's desktop window aspect; the camera
    // compensates fov whenever the live viewport is narrower (see camera.ts).
    controller!.setReferenceAspect(demo.refAspect ?? 16 / 9);

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
    // Authoring: decode this scene's splat centers for snap-picking (CPU copy,
    // author mode only — visitors never pay this cost).
    if (authorMode) {
      picker.load(url).catch((e) => console.warn('[darilux] splat pick data unavailable:', e));
    }

    // filename hints the loader which parser to use (SOGS bundle = meta.json).
    const filename = url.split('/').pop() || 'meta.json';
    const asset = new Asset(demo.id, 'gsplat', { url, filename });
    currentAsset = asset;

    asset.once('load', () => {
      if (activeDemo !== demo) {
        // Superseded mid-load (visitor already switched scenes). The decoded
        // splat resource just landed in memory — free it, or every rapid
        // scene switch strands ~half a million splats and the site crawls.
        app!.assets.remove(asset);
        asset.unload();
        return;
      }
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
      if (activeDemo !== demo) {
        app!.assets.remove(asset);
        asset.unload();
        return;
      }
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
