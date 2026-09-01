/* ============================================================================
   sceneloader.ts — one splat at a time: load, swap, fade, unload.
   ----------------------------------------------------------------------------
   Split out of main.ts. Owns the scene lifecycle state — which demo is live,
   the splat entity and its asset, the home pose, the deferred auto-frame —
   and nothing about the page: UI, sticks and the on-demand render loop stay
   in main.ts and are reached through the deps object, so the loader cannot
   grow page opinions.
   ========================================================================== */

import { Asset, Entity, Vec3, type Application, type BoundingBox } from 'playcanvas';
import { logTag } from './brand';
import type { Demo, HeroPoint, Pose } from '../types';
import type { OrbitFlyCamera } from './camera';
import type { HeroPointManager } from '../nav/heropoints';
import type { PerfHud } from '../ui/perfhud';
import type { UI } from '../ui/ui';

export interface SceneLoaderDeps {
  app(): Application;
  controller(): OrbitFlyCamera;
  heroes(): HeroPointManager;
  ui: UI;
  perf: PerfHud;
  authorMode: boolean;
  /** Render continuously for the whole load (autoRender on, arm counter reset). */
  renderContinuously(): void;
  /** Start the countdown to on-demand rendering, once a scene has landed. */
  armOnDemand(): void;
  /** Redraw request for changes that do not move the camera. */
  wake(): void;
  refreshSticks(): void;
  exitCloseupUI(): void;
  /** Complete a list-click fly-in once the scene is in. */
  flyToHero(hero: HeroPoint): void;
  /** Authoring rig's chance to decode the scene's centers (no-op in client builds). */
  onSceneUrl(url: string): void;
}

export class SceneLoader {
  activeDemo: Demo | null = null;
  currentSplat: Entity | null = null;
  currentAsset: Asset | null = null;
  /** The opening framing to return to on "Exit close-up". */
  homePose: Pose | null = null;
  /** Fly here once the scene finishes loading (list click on a dormant window). */
  pendingHero: HeroPoint | null = null;
  /** True while we wait for a scene's bounds to auto-frame it. */
  private pendingFrame = false;

  constructor(private deps: SceneLoaderDeps) {}

  /** Tear down the current scene so only one splat is ever in memory. */
  unload(): void {
    if (this.currentSplat) {
      this.currentSplat.destroy();
      this.currentSplat = null;
    }
    if (this.currentAsset) {
      const app = this.deps.app();
      app.assets.remove(this.currentAsset);
      this.currentAsset.unload();
      this.currentAsset = null;
    }
  }

  /**
   * Auto-frame a bounds-only scene as soon as its bounding box is available.
   * Called every frame from the update loop; cheap no-op once framed.
   */
  tryAutoFrame(): void {
    if (!this.pendingFrame || !this.currentSplat) return;
    const bb =
      this.currentSplat.gsplat?.customAabb ??
      (this.currentAsset?.resource as { aabb?: BoundingBox } | null)?.aabb ??
      null;
    if (!bb) return;
    const app = this.deps.app();
    app.root.syncHierarchy(); // ensure the 180° roll is baked into the world transform
    const center = new Vec3();
    this.currentSplat.getWorldTransform().transformPoint(bb.center, center);
    const controller = this.deps.controller();
    controller.frameBounds(center, bb.halfExtents.length());
    this.homePose = controller.getPose();
    this.pendingFrame = false;
  }

  async load(demo: Demo): Promise<void> {
    const { deps } = this;
    const app = deps.app();
    const controller = deps.controller();
    const heroes = deps.heroes();
    this.activeDemo = demo;

    /* Render continuously for the whole load. The splat streams in, bakes and
       sorts over many frames, and none of that moves the camera — so under
       on-demand rendering the visitor would watch a frozen loading veil over a
       black canvas. Re-armed when the scene lands. SuperSplat does exactly
       this: autoRender true while loading, false once ready. */
    deps.renderContinuously();

    // Poses are authored at this demo's desktop window aspect; the camera
    // compensates fov whenever the live viewport is narrower (see camera.ts).
    controller.setReferenceAspect(demo.refAspect ?? 16 / 9);
    // Height-locked movement, for the demos that declare a floor and a scale.
    // Explicitly null for the others, so swapping scenes can never leave the
    // previous demo's walk plane installed under the new one.
    controller.setWalk(demo.walk ?? null);

    deps.exitCloseupUI();
    // Both guides go in; ui.ts picks between them when the card is rendered, so
    // the copy still matches the device if the phone is rotated meanwhile.
    deps.ui.setGuide(demo.guide ?? null, demo.guideTouch ?? null);
    deps.ui.showLoading(`Loading ${demo.title}…`);
    heroes.setVisible(false);
    this.pendingFrame = false; // cancel any auto-frame still pending from a prior scene

    // Tear down the previous scene so only one splat is ever in memory.
    this.unload();

    /* ---- Pick the bundle ---------------------------------------------------
       Touch devices get the lite bundle; desktops get the full scene. The
       default has now moved three times, and each move was right about the
       evidence it had, so the lineage is worth keeping:

       2026-08-25, full for everyone: SuperSplat serves the same 2.53M asset
       smoothly, so count was not the bottleneck — true on the desktop it was
       observed on.

       2026-08-31 (am), decided by renderer: on WebGL2 the depth sort is a CPU
       counting sort over every gaussian, linear in count, untouched by any
       resolution or culling knob — so webgl2 phones got lite and WebGPU kept
       full, on the theory that the GPU sort carries it.

       2026-08-31 (pm), decided by DEVICE, which is where it lands: an iPhone
       16 Pro Max on iOS 26.5 (WebGPU) stuttered WORSE than the webgl2 phone —
       but it was rendering 2.53M against the other phone's 1.6M, a confound
       the renderer split itself created. Count is not only the sort: it is
       fill, bandwidth and the SH bake on EVERY path, and on WebGPU the sort
       shares the GPU with rendering, so extra count stretches the frame
       directly (stutter) rather than lagging asynchronously (swim). A phone
       is a phone; only a desktop has the headroom for the full asset by
       default.

       `?lite=1` and `?full=1` still override in both directions — ?full=1 on
       the WebGPU phone is the honest A/B for whether its GPU can in fact
       carry 2.53M. Authoring mode still forces the full asset
       unconditionally: a hero pose judged against a decimated cloud is a pose
       judged against a picture no visitor will ever see, and __logPose()
       output has to stay valid for it. */
    const flags = window.location.search + window.location.hash;
    const touchDevice =
      (window.matchMedia?.('(pointer: coarse)').matches ?? false) || window.innerWidth <= 820;
    const useMobile =
      !deps.authorMode &&
      !!demo.srcMobile &&
      (touchDevice || /(^|[?&#])lite(=1|[&#]|$)/i.test(flags)) &&
      !/(^|[?&#])full(=1|[&#]|$)/i.test(flags);
    const src = useMobile ? demo.srcMobile! : demo.src;

    // Host-agnostic: a demo's `src` may be a local path (bundled in public/splat/
    // and served from GitHub/Cloudflare Pages) OR a full URL (e.g. a large scene
    // served from Cloudflare R2 or any CDN). Absolute URLs are used as-is; local
    // paths resolve against the Vite base so they work under /<repo>/ on Pages.
    const isAbsolute = /^https?:\/\//i.test(src);
    const url = isAbsolute ? src : `${import.meta.env.BASE_URL}${src}`;
    if (useMobile) console.info(`${logTag()} mobile bundle: ${src}`);
    // Authoring: decode this scene's splat centers for snap-picking (CPU copy,
    // author mode only — visitors never pay this cost).
    deps.onSceneUrl(url);

    // filename hints the loader which parser to use (SOGS bundle = meta.json).
    const filename = url.split('/').pop() || 'meta.json';
    const asset = new Asset(demo.id, 'gsplat', { url, filename });
    this.currentAsset = asset;

    asset.once('load', () => {
      if (this.activeDemo !== demo) {
        // Superseded mid-load (visitor already switched scenes). The decoded
        // splat resource just landed in memory — free it, or every rapid
        // scene switch strands ~half a million splats and the site crawls.
        app.assets.remove(asset);
        asset.unload();
        return;
      }
      const entity = new Entity(demo.id);
      // SuperSplat / splat-transform exports are flipped; the starter corrects
      // with a 180° roll. Without this the scene renders upside-down.
      entity.setLocalEulerAngles(0, 0, 180);
      entity.addComponent('gsplat', { asset });
      app.root.addChild(entity);
      this.currentSplat = entity;

      if (demo.initialPose) {
        controller.setPose(demo.initialPose);
        this.homePose = controller.getPose();
      } else {
        // No authored pose — auto-frame from the splat's bounds. Those bounds may
        // not be ready on this exact tick, so we defer to the update loop, which
        // retries until they exist (see tryAutoFrame). Framing before bounds
        // are ready aims the camera at empty space.
        this.pendingFrame = true;
      }

      /* Resident gaussian count, straight off the decoded resource rather than
         from the meta.json this file never parses. Optional-chained through
         `unknown` because `numSplats` is typed `any` on GSplatResourceBase and
         the readout is diagnostic — a HUD that could throw during a scene load
         would be worse than a HUD that prints 0.00M. */
      deps.perf.setSplatCount(
        Number((asset.resource as { numSplats?: number } | null)?.numSplats ?? 0),
      );

      heroes.setDemo(demo);
      heroes.setVisible(true);
      deps.ui.hideLoading();

      // Pads in with the scene, not with the Enter tap: setWalk() has landed by
      // now, so walkActive is finally truthful, and there is something to walk
      // through. A pendingHero fly-in below immediately takes them away again.
      deps.refreshSticks();

      /* Start the countdown to on-demand rendering. NOT a flip to false here:
         `load` fires when the asset has decoded, which is several frames before
         the work buffer is baked, the first depth sort has come back and (for a
         bounds-framed scene) the camera has been aimed at all. Going to sleep
         in that window is how this shows a black or half-sorted room. */
      deps.armOnDemand();
      deps.wake();

      // A synth picked from the collection list while the window was dormant:
      // now that the scene is in, complete the fly-in.
      if (this.pendingHero && demo.heroPoints.includes(this.pendingHero)) {
        const hero = this.pendingHero;
        this.pendingHero = null;
        deps.flyToHero(hero);
      }
    });

    asset.on('progress', (received: number, length: number) => {
      if (this.activeDemo !== demo) return;
      if (length > 0) {
        const pct = Math.floor(Math.max(0, Math.min(1, received / length)) * 100);
        deps.ui.showLoading(`Loading ${demo.title}… ${pct}%`);
      }
    });

    asset.once('error', (err: string) => {
      if (this.activeDemo !== demo) {
        app.assets.remove(asset);
        asset.unload();
        return;
      }
      console.error(`${logTag()} failed to load ${url}:`, err);
      deps.ui.showLoading(
        `Couldn't load ${demo.title}. Check public/${demo.src} exists — see README.`,
      );
    });

    app.assets.add(asset);
    app.assets.load(asset);
  }
}
