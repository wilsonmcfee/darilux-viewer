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
  Color,
  TONEMAP_NONE,
  FILLMODE_NONE,
  RESOLUTION_AUTO,
} from 'playcanvas';
import '../styles/index.css';

import type { Demo, HeroPoint } from '../types';
import { setBrand, logTag, type Brand } from './brand';
import { createDevice, canRender } from './device';
import { OrbitFlyCamera } from './camera';
import { SceneLoader } from './sceneloader';
import type { AuthoringRig } from './authoring';
import { HeroPointManager } from '../nav/heropoints';
import { mountChrome } from './stage';
import { TouchSticks, wantsTouchControls } from '../nav/joystick';
import { PerfHud } from '../ui/perfhud';
import { SplatQualityControl, MOBILE_PRESET, BASE_PRESET } from './splatquality';
import { installKnobs } from './knobs';
import { installSortGate, setOrderUploadPath, type SortGateThresholds } from './gsplatinternals';
import { AdaptiveResolution } from './adaptive';
import { mountPhoneDock, isPhoneLandscape, PHONE_LANDSCAPE_QUERY } from '../ui/phonedock';
import { UI } from '../ui/ui';
import { targetPixelRatio, renderBudgetMpx, setRenderBudgetMpx } from './device';

/* The two mobile sharpness scales, named once because the docked page uses
   BOTH in one session (see the ResizeObserver). Each multiplies a ratio already
   capped at 1080 physical pixels across the panel's short axis — SuperSplat's
   model, adopted verbatim in device.ts — so on a 390x844 DPR-3 phone:

     0.5   -> 1.385   SuperSplat's own mobile default; the full-bleed canvas
     0.75  -> 2.077   the docked window, which is ~35% of the screen's area

   Same frame cost, spent on area or on sharpness. */
const FULLBLEED_PERF_SCALE = 0.5;
const DOCKED_PERF_SCALE = 0.75;

/* How far, in CSS px, a finger may land from a hero dot's centre and still pick
   it. A thumb lands within roughly 7 mm of where it is aimed; at the ~5.7 CSS
   px/mm of a 403px-wide phone, 30px is a little over 5 mm of radius — a 10 mm
   target around a 22px dot that is itself under 4 mm. Nearest dot wins inside
   it, so two close dots still pick deterministically. See
   HeroPointManager.hitTest for why the tap is resolved here and not by the dot's
   own element. */
const TOUCH_HERO_RADIUS = 30;

/* Authoring is a TOOL, not a viewer feature, and it is gated at BUILD time as
   well as at runtime: with this false, the dynamic import below is dead code,
   so core/authoring.ts — and the SplatPicker it owns — tree-shake out of the
   bundle and visitors stop downloading a rig they can never open. Dev keeps
   it; VITE_AUTHORING=1 forces it into a production build that needs the rig. */
const AUTHORING = import.meta.env.DEV || import.meta.env.VITE_AUTHORING === '1';

export interface ViewerOptions {
  /**
   * The element whose `.viewer-window[data-demo]` frames this viewer serves.
   * Usually document.body. NOTE the chrome still resolves ids globally
   * (#stage-dock, #stage, the modals), so there is at most ONE viewer per
   * page at a time — destroy() releases everything so a second can mount.
   */
  mount: HTMLElement;
  /** This deployment's scene config — what demos.ts holds today. */
  scenes: Demo[];
  /** Console log prefix + disclaimer signature. Defaults to a neutral 'viewer'. */
  brand?: Brand;
  /** A visitor entered a scene (analytics hook). */
  onEnter?: (sceneId: string) => void;
  /** A visitor opened a hero close-up (analytics hook). */
  onHeroOpen?: (sceneId: string, heroId: string) => void;
}

export interface Viewer {
  /** Enter a scene by id, exactly as clicking its window's Enter would. */
  load(sceneId: string): Promise<void>;
  /** Fly to a hero point by id (entering its scene first if needed). */
  goToHero(heroId: string): void;
  /**
   * Tear the viewer down completely: unload the scene, destroy the engine and
   * its GPU device, remove the injected chrome and every listener — including
   * the window-level ones. Without this the viewer cannot mount twice in one
   * page lifetime: the WebGL context leaks and the second mount fails, which
   * kills any client-side-routed embedding.
   */
  destroy(): void;
}

export function createViewer(opts: ViewerOptions): Viewer {
  const scenes = opts.scenes;
  // Hand the deployment's identity to the engine before anything logs or
  // renders brand-flavoured copy.
  setBrand(opts.brand ?? { name: 'Viewer', tag: 'viewer' });

  // The stage chrome is shared markup, injected rather than pasted into each
  // page (see stage.ts). This MUST run before anything resolves an id from it:
  // UI's constructor looks every one of them up eagerly and throws on a miss.
  mountChrome();

  /* bluedio-phone.html: move the pads, the cards and the i/points row out of
     the stage and into the strip beneath it. Between mountChrome() and `new
     UI(...)` because both of those resolve ids eagerly — a move is invisible to
     them, but a missing element is not. Null on every other page. */
  const phoneDock = mountPhoneDock();

  const stage = document.getElementById('stage') as HTMLElement;
  const canvas = document.getElementById('viewer') as HTMLCanvasElement;

  // Authoring mode (?author / #author): crosshair, pose panel, splat-snap
  // anchor picking — mounted from core/authoring.ts, build-gated by AUTHORING.
  const authorMode = /author/i.test(location.search + location.hash);
  let authoring: AuthoringRig | null = null;

  // ---- App state (the app itself is created lazily on first Enter) ---------
  let app: Application | null = null;
  let controller: OrbitFlyCamera | null = null;
  let heroes: HeroPointManager | null = null;
  let sticks: TouchSticks | null = null;
  /* The frame-time readout. Constructed eagerly — it is an inert object until
     shown — so ?stats is honoured the instant the engine exists rather than
     once a scene lands. That ordering matters: a slow LOAD and a slow FRAME
     look identical from outside, and the HUD is what separates them. */
  const perf = new PerfHud(stage);
  let quality: SplatQualityControl | null = null;

  let closeupHero: HeroPoint | null = null; // hero currently being viewed up close
  let stickOverride: boolean | null = null; // __sticks(0/1); null = decide by device
  /* Fraction of the frame height a hero close-up lifts its subject on the mobile
     card layout. 0.27 is the middle of the 25-30% Will judged by eye on a phone.
     Overridable with ?lift=N / __heroLift(n) — see camera.setHeroFrameLift(). */
  let heroLift = 0.27;

  /* ---- The sort gate ------------------------------------------------------
     How far the camera moves before the engine re-sorts — the knob the engine
     does not expose (its own is a hard-coded 1e-3), installed over the live
     manager by gsplatinternals.ts. In METRES, converted through the active
     scene's unitsPerMetre so the number means the same thing in every room.

     0.05 m is the default, and it is chosen from the sort's own latency rather
     than taste. On WebGL2 a completed sort lands 20-37 ms after it was asked
     for (the 2.53M sort takes ~20 ms in the worker, plus a frame), so at
     walking speed (1.25 m/s) the order drawn on screen is ALREADY 3-5 cm
     behind the camera. A 5 cm gate roughly doubles that staleness at full
     walking speed and removes it entirely for the small motions — a gentle
     stick push, the close-up sway — that used to re-sort every frame. Measured
     while walking, 2.53M, radial, colorUpdateAngle 30:

       gate        sorts/s   upload mean   worst frame
       engine      28        4.9 ms        33 ms
       5 cm        18        0.8 ms        20 ms
       25 cm        4        0.5 ms         2 ms

     The upload mean falling six-fold on a 35% cut in count is the important
     line: texImage2D is where the main thread waits for the GPU, and at 28
     uploads a second the GPU queue never drains. Inert on WebGPU (GPU sort,
     every frame, no test). `?sortdist=N` / `__sortGate({distance})`; 0 = engine
     stock. `angle` is the directional-sort twin, only reachable after
     __splat({radialSorting:false}). */
  let sortDistanceMetres = 0.05;
  let sortAngleDegrees = 0;
  const readSortGate = (): SortGateThresholds => ({
    distanceMetres: sortDistanceMetres,
    angleDegrees: sortAngleDegrees,
    unitsPerMetre: loader.activeDemo?.walk?.unitsPerMetre ?? 1,
  });
  /* `?pbo=1` — the WebGL2 order upload through a PBO instead of texImage2D.
     Re-applied every frame while set, because the engine recreates the work
     buffer on a renderer change. See setOrderUploadPath() for who this is for. */
  let orderUploadPath: 'direct' | 'pbo' = 'direct';
  /* Hold colour re-bakes for the duration of a fly-in (see
     SplatQualityControl.suspendColorBake). `?flybake=1` turns the hold off for
     an A/B on the device. */
  let holdBakeInFlight = true;

  /* ---- The frame-time governor ----------------------------------------------
     A 30 fps floor on every device, bought with resolution: adaptive.ts
     watches the pacing of rendered frames and scales the device-decided pixel
     ratio down (never up past it) until the frame fits, then climbs back when
     there is headroom. It multiplies into applyRenderRatio() below, so it
     composes with the mobile cap, the render budget and ?perf, and is applied
     through the same resize path a window resize takes.

     Off when `?res=N` is present — an absolute ratio is an A/B, and a governor
     silently moving it would make the A/B a lie — and with `?adapt=0`.
     `?minfps=N` moves the floor. The HUD's `res` reading is its scale. */
  const flagsAtBoot = window.location.search + window.location.hash;
  const minFpsRaw = /(^|[?&#])minfps=(\d+(?:\.\d+)?)/i.exec(flagsAtBoot);
  const adaptive = new AdaptiveResolution({
    targetFps: minFpsRaw ? Number(minFpsRaw[2]) : 30,
  });
  adaptive.enabled =
    !/(^|[?&#])adapt=0/i.test(flagsAtBoot) && !/(^|[?&#])res=/i.test(flagsAtBoot);

  /* ---- On-demand rendering state ----------------------------------------
     At boot scope rather than inside ensureApp() because loadDemo() has to arm
     it when a scene lands, and loadDemo is a sibling. The long explanation of
     WHY any of this exists is at the point of use in the frame loop; these are
     just the three values it needs to keep between frames. */
  let onDemand = false; // decided in ensureApp() once the device is known
  /* Frames still to draw after the last thing that changed the picture.
     A HOLD RATHER THAN A SINGLE FRAME, because the work a render kicks off is
     not finished when that render returns: the depth sort runs on a worker and
     the colour re-bake is consumed by the NEXT frame. Three is enough for both
     to land and is imperceptible — 50 ms of rendering after the visitor stops
     moving, once. */
  const RENDER_HOLD = 3;
  let holdFrames = RENDER_HOLD;
  /* Frames before on-demand arms after a scene lands; 0 means already armed.
     Counted in frames, not milliseconds — what has to finish is a fixed number
     of frame-driven steps, and on a slow phone a wall-clock timer would expire
     while they were still in flight, which is precisely the device this is for.
     Generous on purpose: being wrong this way costs a second of rendering
     nobody notices, and being wrong the other way shows a black room. */
  const ARM_FRAMES = 90;
  let armIn = 0;
  /** Called by everything OUTSIDE the camera that changes the picture. */
  const wake = (): void => {
    controller?.wake();
    holdFrames = RENDER_HOLD;
  };

  /**
   * The ONE rule for whether the thumb sticks are on screen. Every path that can
   * change the answer calls this rather than toggling the pads itself, because
   * the states overlap: a hero can be entered from a list click while the scene
   * is still loading, and a phone can rotate in the middle of a close-up.
   *
   * Four clauses, each earning its place:
   *   • a scene is live            — no pads over a poster
   *   • this device wants them     — see wantsTouchControls(); re-checked on
   *                                  resize, so rotating a phone is enough
   *   • the demo is walkable       — sticks that cannot move anything are a lie.
   *                                  Bluedio is the only walk demo; the older
   *                                  three fall through to their free fly
   *   • no hero card is open       — Will's rule, and the right one: a close-up
   *                                  is a modal reading state, the camera is on
   *                                  rails, and the pads would sit under the card
   */
  function refreshSticks(): void {
    /* ---- The docked page's three states, published to CSS -----------------
       BEFORE the `!sticks` guard, because the dock has a correct state to be in
       from first paint — long before the engine (and therefore `sticks`) exists.

       This exists because re-parenting quietly removed a gate nobody had
       written down. On every other page #stage-controls lives inside #stage,
       and #stage parks in `<div id="stage-dock" hidden>` until a viewer opens —
       so the [hidden] attribute kept the i and the points toggle off screen
       before entry, for free. #stage-controls is the one id in DOCKED_IDS that
       ships with no class of its own, so moving it into the permanently-visible
       dock removed its only gate and nothing replaced it. The result was a
       points switch sitting on the poster that flipped its own knob and its own
       aria-checked while `heroes` was still null — a control that lied, and
       then took two taps to actually work once a scene was live.

         poster  no scene    -> hint visible, no controls
         roam    free roam   -> pads + controls
         hero    close-up    -> the card owns the dock, alone

       `hero` hiding the controls row is not only a fix, it is what the layout
       was drawn as: the mockup's second state is the card and nothing else. It
       also closes the other half of the help-card collision — with no i to
       tap, the help card cannot be raised over a gear card at all. */
    if (phoneDock) {
      phoneDock.dataset.state =
        loader.activeDemo === null ? 'poster' : closeupHero !== null ? 'hero' : 'roam';
    }

    if (!sticks) return;
    const want =
      loader.activeDemo !== null &&
      (stickOverride ?? wantsTouchControls()) &&
      (controller?.walkActive ?? false) &&
      closeupHero === null;
    sticks.setVisible(want);
    // Belt and braces: setVisible already springs the pads on the way down, but
    // the camera is the thing that must end up at rest, and it is cheap to say so.
    if (!want) controller?.releaseSticks();
  }

  /**
   * Install the hero framing lift for whichever card layout is live.
   *
   * It belongs to the LAYOUT, not the device: the lift exists because the mobile
   * card is centred across the bottom third and covers frame centre, so the test
   * is the same breakpoint the card's CSS uses. On desktop the card is a wide,
   * shallow bar that clears the subject, and lifting there would recompose every
   * hero pose Will authored — so desktop gets 0.
   *
   * Called from the same places as refreshSticks(), including on resize, so a
   * phone rotating or a window crossing the breakpoint re-decides it.
   *
   * THE DOCKED PHONE PAGE GETS 0 IN PORTRAIT, and it is worth saying why rather
   * than treating it as one more special case. The lift is a workaround for a
   * card that covers the middle of the frame; on bluedio-phone.html upright the
   * card is not in the frame at all, it is in the strip underneath. So the
   * workaround has nothing to work around, and turning it off restores every
   * hero pose to the framing that was actually authored — a small, free quality
   * win that comes out of the layout rather than out of any tuning.
   *
   * TURNED SIDEWAYS, THE SAME PAGE GETS A SMALLER LIFT. Landscape puts the card
   * back over the picture as a bottom bar, on a frame only ~400px tall, so the
   * bar's top edge sits at roughly 56% of the frame — right where a fly-in
   * parks its subject. 0.15 puts the subject at 35%, clear of the bar; the
   * portrait 0.27 would push it to 23% of a frame this short, hard against the
   * ceiling with a dead band above the card. It applies whenever the landscape
   * arrangement is live, touch or not: it is the CARD's position that the lift
   * answers to, and a laptop reviewing the layout has the same card in the
   * same place. Not driven by ?lift, which tunes the portrait card.
   */
  const LANDSCAPE_HERO_LIFT = 0.15;

  function refreshHeroFraming(): void {
    if (!controller) return;
    let lift = 0;
    if (!phoneDock && (stickOverride ?? wantsTouchControls())) lift = heroLift;
    else if (phoneDock && isPhoneLandscape()) lift = LANDSCAPE_HERO_LIFT;
    controller.setHeroFrameLift(lift);
  }

  const ui = new UI(scenes, {
    onEnterViewer: (demoId) => enterViewer(demoId),
    onExitViewer: () => exitViewer(),
    onSelectHero: (hero) => selectHero(hero),
    onExitCloseup: () => exitCloseup(),
    // Persists across scene loads — HeroPointManager keeps it separate from the
    // load gate, so streaming a new splat cannot switch the points back on.
    onTogglePoints: (on) => heroes?.setPointsEnabled(on),
  });

  /* The scene lifecycle — load/swap/fade, one splat at a time — lives in
     sceneloader.ts. Everything it needs from this page comes through here, so
     the loader owns the scene and main.ts keeps the page. */
  const loader = new SceneLoader({
    app: () => app!,
    controller: () => controller!,
    heroes: () => heroes!,
    ui,
    perf,
    authorMode,
    renderContinuously: () => {
      if (app) app.autoRender = true;
      armIn = 0;
      // A load's opening frames say nothing about the GPU; the governor holds.
      adaptive.reset();
    },
    armOnDemand: () => {
      if (onDemand) armIn = ARM_FRAMES;
    },
    wake,
    refreshSticks: () => refreshSticks(),
    exitCloseupUI: () => exitCloseupUI(),
    flyToHero: (hero) => flyToHero(hero),
    onSceneUrl: (url) => authoring?.onSceneUrl(url),
  });

  /* ---- Re-decide the touch layout when the CONDITION changes, not when a
     proxy for it does.

     `refreshSticks()` and `refreshHeroFraming()` were driven only by the
     ResizeObserver on #stage, on the reasonable theory that a viewport change
     always resizes the stage. The docked page broke that theory: its review
     shell pins `.phone-shell` to a fixed 400px, and the window's height comes
     from a `svh` expression, so #stage is EXACTLY the same size at 900px wide
     as at 700px. Dragging a review window across the 820px breakpoint therefore
     changed #stage by zero pixels in both axes, the observer never fired, and
     the pads never appeared — which is precisely the outcome the 820px clause
     in wantsTouchControls() was added to prevent.

     Listening to the media queries themselves is the fix, because they ARE the
     condition: the same two tests wantsTouchControls() runs. Registered here
     rather than beside the ResizeObserver so it is live from boot rather than
     from the first Enter, and kept alongside it rather than replacing it — the
     observer still owns the case this cannot see, which is the stage being
     reparented between two differently-sized windows at one viewport size. */
  const mqDisposers: Array<() => void> = [];
  // The landscape query is in the list for the hero lift: on the docked page a
  // rotation also resizes the stage, so the observer would catch it too, but a
  // laptop window dragged across the height threshold at a fixed stage size
  // would not — the same shape of gap the 820px clause closes.
  for (const q of ['(max-width: 820px)', '(pointer: coarse)', PHONE_LANDSCAPE_QUERY]) {
    const mq = window.matchMedia?.(q);
    // addEventListener on MediaQueryList is Safari 14+; addListener is the
    // fallback for the older WKWebView this project explicitly still targets.
    const onChange = (): void => {
      refreshSticks();
      refreshHeroFraming();
    };
    if (mq?.addEventListener) {
      mq.addEventListener('change', onChange);
      mqDisposers.push(() => mq.removeEventListener('change', onChange));
    } else if (mq?.addListener) {
      mq.addListener(onChange);
      mqDisposers.push(() => mq.removeListener?.(onChange));
    }
  }

  /**
   * Re-decide the render pixel ratio from the canvas's CURRENT CSS size.
   *
   * Two things feed it, both decided on the same resize event because both
   * are about the canvas's share of the screen:
   *
   * - The mobile SCALE. The docked page paints two very different canvases in
   *   one session — the square window upright, the whole screen turned
   *   sideways, ~2.3x the CSS area — so landscape takes the full-bleed page's
   *   scale and portrait keeps the docked one. Every other page uses the
   *   full-bleed scale it booted with.
   * - The render BUDGET (device.ts). A desktop page is a 0.9 Mpx window one
   *   moment and an 8 Mpx fullscreen the next, and the budget can only be
   *   honoured by whoever knows the size — which is this observer, not the
   *   device constructor. This is the 2026-09-02 (pm) fix for "fullscreen on
   *   a desktop lags, and so does SuperSplat": `?res=0.7` fixed it outright,
   *   so the ceiling is fill, and the budget puts a ceiling on fill.
   *
   * Must run BEFORE resizeCanvas, which is what sizes the backing store from
   * maxPixelRatio. ?res and ?perf still win — folded in by targetPixelRatio().
   */
  function applyRenderRatio(): void {
    if (!app) return;
    const scale =
      phoneDock && !isPhoneLandscape() ? DOCKED_PERF_SCALE : FULLBLEED_PERF_SCALE;
    // The governor's scale multiplies LAST, so it can only take pixels away
    // from what the device rules and the budget decided, never add them.
    app.graphicsDevice.maxPixelRatio =
      Math.min(
        window.devicePixelRatio,
        targetPixelRatio(scale, stage.clientWidth, stage.clientHeight),
      ) * adaptive.scale;
    perf.setRenderScale(adaptive.scale);
  }

  /* The governor's changes take the exact path a window resize does — ratio,
     backing store, redraw — so there is one way the canvas ever changes size.

     BUT NOT AT THE MOMENT THEY ARE DECIDED. The governor samples on
     `frameend`, i.e. after the frame has been drawn into the old-size buffer.
     Resizing the canvas right there CLEARS it, and the compositor shows an
     empty canvas until the next frame lands 16-33 ms later — one black frame
     per resolution change, which on the phone read as "the screen flickers
     black when I move quickly", because fast motion is exactly when the
     governor changes resolution. So the change is only FLAGGED here and
     applied at the top of the next `update`, which runs before that frame's
     render: the buffer is resized and immediately redrawn inside one tick, and
     nothing blank is ever presented. */
  let renderScaleDirty = false;
  adaptive.onChange = (scale, reason) => {
    renderScaleDirty = true;
    console.info(`${logTag()} adaptive resolution ${reason} → ×${scale.toFixed(2)}`);
  };
  function applyPendingRenderScale(): void {
    if (!renderScaleDirty || !app || !stage.clientWidth || !stage.clientHeight) return;
    renderScaleDirty = false;
    applyRenderRatio();
    app.resizeCanvas(stage.clientWidth, stage.clientHeight);
    wake();
  }

  // Set by destroy(); makes every entry point a no-op afterwards, so a stray
  // reference to a dead viewer cannot resurrect half of it.
  let destroyed = false;
  // The stage's ResizeObserver, created in ensureApp — hoisted so destroy()
  // can disconnect it.
  let ro: ResizeObserver | null = null;

  // ---- Lazy engine creation -------------------------------------------------
  async function ensureApp(): Promise<boolean> {
    if (app) return true;

    // Backstop — if the device can render nothing, show the overlay and stop.
    if (!canRender()) {
      ui.showUnsupported();
      return false;
    }

    /* Graphics device (WebGPU first, silent WebGL2 fallback).

       `perfScale` is the mobile sharpness dial, and the two pages take
       different values for a reason that is arithmetic rather than taste. The
       scale multiplies a ratio already capped at 1080 physical pixels across
       the short axis of the screen — SuperSplat's model, adopted verbatim, see
       device.ts — so on a 390x844 DPR-3 phone:

         0.5   -> 1.385   SuperSplat's own mobile default
         0.75  -> 2.077   here, docked
         1.0   -> 2.769   SuperSplat with performance mode switched off

       The docked page paints a 4:3 window that is ~35% of the area of a
       full-bleed portrait screen, so at 0.75 it renders about 1.5x the pixels
       the full-bleed page does at 0.5 while being 1.5x SHARPER per CSS pixel.
       That trade is the entire performance argument for the docked layout.
       Override either page with ?perf=N, or the final ratio with ?res=N. */
    const { device, renderer } = await createDevice(canvas, {
      perfScale: phoneDock ? DOCKED_PERF_SCALE : FULLBLEED_PERF_SCALE,
      // The stage is already parented into its window (enterViewer does that
      // first), so the size is real and the pixel budget binds from frame one.
      cssWidth: stage.clientWidth,
      cssHeight: stage.clientHeight,
    });

    // The canvas is sized by its host window (CSS 100%), not the browser window:
    // FILLMODE_NONE + RESOLUTION_AUTO track the element's client size.
    app = new Application(canvas, { graphicsDevice: device });

    /* The HUD learns the renderer here and nowhere else. Which of the two
       pipelines resolved is the first thing to establish about a slow phone:
       WebGPU sorts on the GPU, WebGL2 sorts 2.5M splats on a worker thread, and
       several of the engine's culling knobs are WGSL-only and silently inert on
       the second. Every other number the HUD prints is read differently
       depending on this one. */
    perf.attach(app, renderer);

    /* ---- Splat cost/quality knobs -----------------------------------------
       Applied ONCE here, before any asset is added, and never from the frame
       loop — see the note on SplatQualityControl.apply() for why that is an
       engine constraint rather than a style preference.

       The mobile preset only lands on devices that need it, decided by the
       same coarse-pointer / narrow-viewport test the render resolution uses.
       Desktop keeps engine defaults so the authoring view stays honest: a pose
       judged against culled splats is a pose judged against a picture the
       client will not see on a laptop. */
    quality = new SplatQualityControl(app, renderer);
    const mobile = window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth <= 820;
    /* BASE on every device — the two knobs that only govern how often work is
       redone in MOTION (radial sort trigger, colour re-bake cadence), so the
       picture at rest, and the authoring view, are exactly what they were.
       The mobile preset is a superset and lands on top. */
    quality.apply(BASE_PRESET);
    if (mobile) quality.apply(MOBILE_PRESET);
    console.info(`${logTag()} splat quality: ${quality.activePathNote}`);
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
    // interrupt() drops the fly-in's onArrive when the visitor drags mid-flight,
    // which would leave the active hero's dot floating over its own object for
    // the rest of the close-up. Hide it here too.
    controller.onUserInteract = () => {
      if (closeupHero) heroes?.setHiddenHero(closeupHero);
      // A drag mid-flight cancels the fly AND its onArrive, so the colour-bake
      // hold would otherwise outlive the flight. Resume here, unconditionally.
      quality?.resumeColorBake();
    };
    heroes = new HeroPointManager(camera, document.getElementById('hero-layer')!);
    heroes.onSelect = (hero) => selectHero(hero);

    /* ---- A finger's tap on the canvas picks the nearest hero dot -------------
       On a coarse pointer the marker elements are inert (markers.css) and the
       canvas owns every gesture, tap included; the tap is matched against the
       projected dots by distance. A mouse is excluded here because it never
       needs this — it clicks the dot element itself, precisely, with the hover
       caption — and a click on empty canvas near a dot should stay a click on
       empty canvas for a pointer that can tell the difference.

       preventDefault() is the signal "this tap was spent": phonedock's × reveal
       listens on #stage, runs after the camera's canvas-level pointerup, and
       reads the flag rather than summoning the exit over a fly-in. */
    controller.onTap = (e) => {
      if (e.pointerType === 'mouse') return;
      const r = canvas.getBoundingClientRect();
      const hero = heroes?.hitTest(e.clientX - r.left, e.clientY - r.top, TOUCH_HERO_RADIUS);
      if (!hero) return;
      e.preventDefault();
      selectHero(hero);
    };

    // ---- Touch thumb sticks --------------------------------------------------
    // Built once alongside the camera, then shown or hidden by refreshSticks().
    // The pads only translate a finger into a vector; the camera decides what
    // that means, which is why both callbacks are one line each.
    sticks = new TouchSticks(
      document.getElementById('touch-controls')!,
      (v) => controller!.setMoveAxis(v.x, v.y),
      (v) => controller!.setLookAxis(v.x, v.y),
    );

    // Walk mode is OFF in authoring mode: you cannot author a hero pose 2.4 m
    // up from a body that cannot leave the floor, and orbit/fly exist precisely
    // as authoring tools. __walk(1) puts it back so a framing can be checked at
    // standing height without dropping ?author.
    controller.setWalkEnabled(!authorMode);

    /* The live tuning surface — URL params (?sharpen/?fov/?look/?lift/?stats)
       and every __knob console handle — lives in core/knobs.ts. */
    installKnobs({
      app,
      camera,
      controller,
      perf,
      quality: () => quality,
      wake,
      refreshSticks: () => refreshSticks(),
      refreshHeroFraming: () => refreshHeroFraming(),
      getHeroLift: () => heroLift,
      setHeroLift: (n) => {
        heroLift = n;
      },
      setStickOverride: (on) => {
        stickOverride = on;
      },
      getSortGate: () => ({ distance: sortDistanceMetres, angle: sortAngleDegrees }),
      setSortGate: (g) => {
        if (g.distance !== undefined) sortDistanceMetres = g.distance;
        if (g.angle !== undefined) sortAngleDegrees = g.angle;
      },
      setOrderUploadPath: (p) => {
        orderUploadPath = p;
      },
      setHoldBakeInFlight: (on) => {
        holdBakeInFlight = on;
        if (!on) quality?.resumeColorBake();
      },
      setRenderBudget: (mpx) => {
        const v = setRenderBudgetMpx(mpx);
        // Same sequence as the ResizeObserver: ratio first, then the backing
        // store, then a redraw so the change is visible without moving.
        applyRenderRatio();
        if (app && stage.clientWidth && stage.clientHeight) {
          app.resizeCanvas(stage.clientWidth, stage.clientHeight);
        }
        wake();
        return v;
      },
      getRenderBudget: () => renderBudgetMpx(),
      adaptive: () => adaptive,
      resetRenderScale: () => {
        adaptive.scale = 1;
        adaptive.onChange?.(1, 'reset from console');
        // A console call is outside the frame loop; under on-demand rendering
        // no update may be coming, so apply now rather than wait for one.
        applyPendingRenderScale();
      },
    });

    // The ?author rig — crosshair, pose panel, splat-snap anchor picking —
    // lives in core/authoring.ts and only exists in builds where AUTHORING is
    // true. The dynamic import is inside ensureApp on purpose: it resolves
    // before the first loadDemo, so the picker never misses a scene URL.
    if (AUTHORING && authorMode) {
      const { mountAuthoring } = await import('./authoring');
      authoring = mountAuthoring({
        app,
        camera,
        canvas,
        stage,
        controller,
        currentSplat: () => loader.currentSplat,
      });
    }

    /* ---- On-demand rendering -----------------------------------------------
       THE FIX FOR "THE FRAME RATE DROPS AFTER A FEW MINUTES".

       Until now `autoRender` was true for an entire session, so a phone showing
       a completely stationary picture still rasterised the whole splat cloud
       sixty times a second. Nothing about that frame changes, and the cost is
       not merely wasted — it is THERMAL. A phone held at full splat fill heats
       up, the SoC throttles, and every frame after that is slower than the ones
       before it. That is a decay curve over minutes, which is exactly the
       symptom that came back from the device, and no amount of per-frame tuning
       fixes it because the problem is the frames existing at all.

       SuperSplat renders on demand and this viewer did not. It is the single
       biggest remaining difference between the two, and TEMPLATE.md has carried
       it under "Still on the table" for two passes. It lands here.

       THE THREE THINGS THAT MAKE IT SAFE

       1. The motion test is a snapshot comparison inside camera.ts, not a set
          of flags — so it cannot miss a motion source, and its epsilons are
          sized to swallow the 1-ulp float residue from pinEyeTo() that
          TEMPLATE.md warns would defeat a naive idle detector. See
          `movedThisFrame` there.
       2. Anything that changes the picture WITHOUT moving the camera calls
          `controller.wake()`: a splat landing, a resize, and — the one that is
          easy to miss — a depth sort completing on the worker thread, which
          arrives asynchronously and would otherwise leave the last drawn frame
          holding a stale splat order.
       3. It does not arm until the scene has been in for a moment. The bake,
          the first sort and the auto-framing all resolve over several frames
          after `load` fires, and sleeping through them is how this optimisation
          shows a black or half-sorted room.

       Auto-orbit is dropped on touch (see flyToHero), which matters here rather
       than there: without that, a hero close-up — the state a visitor sits in
       longest — would keep the renderer awake permanently and this would buy
       nothing during the one state it most needs to.

       `?ondemand=0` turns it off for an A/B; `?ondemand=1` forces it on a
       desktop, where it is off by default because a plugged-in machine has no
       thermal problem to solve and authoring wants a continuously live view. */
    const onDemandRaw = /(^|[?&#])ondemand=([01])/i.exec(
      window.location.search + window.location.hash,
    );
    onDemand = onDemandRaw ? onDemandRaw[2] === '1' : mobile;

    /* A completed depth sort is the non-obvious one. It is produced on a worker
       and applied to the work buffer, so the frame that was drawn BEFORE it
       arrived is holding the previous ordering — visible as splats popping into
       the right depth order a beat late, or not at all if the page has gone to
       sleep in the meantime. perfhud.ts already listens to this event for its
       timing readout; this is the same event, used for correctness. */
    app.scene.on('gsplat:sorted', wake);

    // ---- Frame loop ----------------------------------------------------------
    app.on('update', (dt: number) => {
      // A resolution change the governor decided last frame lands here, before
      // this frame renders — see the note at adaptive.onChange.
      applyPendingRenderScale();
      // Auto-frame a bounds-only scene as soon as its bounding box is available.
      loader.tryAutoFrame();
      controller!.update(dt);

      /* The engine builds its gsplat manager lazily and rebuilds it on a
         renderer change, so the gate is (re)installed every frame — a
         two-level Map walk, patched objects skipped. See gsplatinternals.ts. */
      installSortGate(app!, readSortGate);
      if (orderUploadPath === 'pbo') setOrderUploadPath(app!, 'pbo');

      /* Off `update`, not `frameend`, so the readout keeps refreshing on frames
         that were not drawn — otherwise it freezes mid-number the moment
         on-demand rendering puts the page to sleep. See PerfHud.tick(). */
      perf.tick();

      if (!onDemand) return;

      /* Arm only once the scene has had time to bake, sort and auto-frame.
         Counted in FRAMES rather than milliseconds because what has to finish
         is a fixed number of frame-driven steps, and on a slow phone a
         wall-clock timer would expire while they were still in flight — which
         is precisely the device this is for. */
      if (armIn > 0) {
        armIn--;
        if (armIn === 0) app!.autoRender = false;
        return;
      }
      if (!app!.autoRender) {
        if (controller!.movedThisFrame) holdFrames = RENDER_HOLD;
        if (holdFrames > 0) {
          holdFrames--;
          app!.renderNextFrame = true;
        }
      }
      /* Cleared AFTER the decision, never inside the getter: the flag is
         written from two places (update() and any out-of-band wake()) and a
         getter with a side effect would silently make the order of those two
         reads matter. */
      controller!.clearMoved();
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

    /* Frame-time sampling hangs off `frameend`, not `update`. `update` fires
       before the scene is drawn, so consecutive update timestamps measure the
       gap between the starts of two frames and miss any render that overruns
       into the next one — precisely the case worth catching. `frameend` fires
       after the render has been submitted, so its deltas are true frame pacing.
       Disabled, the handler is one property read. */
    app.on('frameend', () => {
      perf.sample();
      // Same event, same reasoning: only RENDERED frames carry pacing
      // information, and `frameend` is the one hook that fires for exactly those.
      adaptive.sample(performance.now());
    });

    // ---- Resize: track the HOST WINDOW, not the browser window ---------------
    // The stage is reparented between differently-sized windows, so a
    // ResizeObserver (which also fires on reparent) keeps the buffer in sync.
    ro = new ResizeObserver(() => {
      // When the stage is parked in the hidden dock (viewer closed) it
      // measures 0×0. Resizing the swapchain to zero creates invalid WebGPU
      // textures and every subsequent frame submits an invalid command
      // buffer — the console spam that drags the whole page down. Skip it.
      if (!stage.clientWidth || !stage.clientHeight) return;
      applyRenderRatio();
      app?.resizeCanvas(stage.clientWidth, stage.clientHeight);
      // The frames after a swapchain reallocation are slow for their own
      // reasons; the governor must not read them as a slow device.
      adaptive.notifyResize();
      // The viewport shape changed (rotation / reparenting into another
      // window) — re-apply the camera so its aspect-compensated fov tracks it.
      controller?.refresh();
      // Same event, different consequence: a rotation or a resized desktop
      // window can cross the touch breakpoint, so the pads AND the hero framing
      // lift are re-decided here rather than latched when the scene loaded.
      refreshSticks();
      refreshHeroFraming();
      /* A resized swapchain holds nothing — under on-demand rendering the
         canvas would stay blank until the visitor happened to move. The camera
         has not changed, so only an explicit wake catches this. */
      wake();
    });
    ro.observe(stage);

    app.start();
    return true;
  }

  // ---- Entering / leaving a viewer window -----------------------------------
  async function enterViewer(demoId: string): Promise<void> {
    if (destroyed) return;
    const demo = scenes.find((d) => d.id === demoId);
    if (!demo) {
      console.error(`${logTag()} unknown demo "${demoId}"`);
      return;
    }
    if (loader.activeDemo?.id === demoId) return;
    opts.onEnter?.(demoId);

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

    await loader.load(demo);
  }

  // The × on the stage: unload the scene (frees GPU + JS memory) and give the
  // window its poster back. The engine stays warm for the next Enter.
  function exitViewer(): void {
    if (!loader.activeDemo) return;
    exitCloseupUI();
    loader.unload();
    loader.activeDemo = null;
    loader.pendingHero = null;
    // After activeDemo is cleared, so the "a scene is live" clause fails and the
    // pads come down with the scene rather than being left over a poster.
    refreshSticks();
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
    const owner = scenes.find((d) => d.heroPoints.includes(hero));
    if (!owner) return;
    if (loader.activeDemo?.id !== owner.id) {
      loader.pendingHero = hero;
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

  /**
   * autoOrbit.direction -> the ±1 the camera rig wants.
   *
   * 'right' maps to the rig's +1 because that is empirically the way every hero
   * set off before this parameter existed. If it ever reads inverted on screen,
   * swap these two cases — nothing else depends on the mapping.
   *
   * 'random' is drawn HERE, per click, not once at load, so the same hero sets
   * off a different way on a repeat visit.
   */
  function orbitDirection(ao: HeroPoint['autoOrbit']): 1 | -1 | undefined {
    switch (ao?.direction) {
      case 'left':
      case -1:
        return -1;
      case 'right':
      case 1:
        return 1;
      case 'random':
        return Math.random() < 0.5 ? -1 : 1;
      default:
        return undefined;
    }
  }

  function flyToHero(hero: HeroPoint): void {
    if (destroyed) return;
    opts.onHeroOpen?.(loader.activeDemo?.id ?? '', hero.id);
    // Show whatever was hidden before (stepping between heroes) and record the
    // new one so an interrupted fly-in still hides it (see onUserInteract).
    heroes!.setHiddenHero(null);
    closeupHero = hero;
    // flyToHero enters constrained close-up mode (auto-orbit + view limits).
    // Per-hero autoOrbit config (spin vs sway, direction, pivot) rides along.
    const ao = hero.autoOrbit;
    const pivot = orbitPivot(hero);
    const direction = orbitDirection(ao);
    /* ---- Idle motion runs on EVERY device, including phones ---------------
       This reverses the 2026-08 perf pass, which forced mode 'none' on touch so
       a close-up would go quiescent under on-demand rendering (a close-up is
       the longest-dwelled state, and the frame-rate decay it was fighting was
       thermal). The reversal is Will's call, made on the device: a perfectly
       still close-up READS AS BROKEN — nothing announces that the piece can be
       orbited, so visitors concluded interaction was disabled. The sway is the
       affordance, not garnish.

       What the perf pass bought is not all given back: on-demand rendering
       still idles the roam state, the poster, and every second the visitor is
       actively reading a card mid-drag pause is unaffected — the cost returns
       only while a close-up sways. If thermals resurface, dial the DURATION of
       the sway rather than its existence. */
    /* Colour re-bakes are held for the flight and fire once on arrival — the
       fix for the fly-in frame drops in the iPhone 18 Pro recording. Resumed
       from onArrive below, from onUserInteract if the visitor grabs the camera
       mid-flight, and from exitCloseupUI on a scene swap. */
    if (holdBakeInFlight) quality?.suspendColorBake();
    controller!.flyToHero(
      hero.pose,
      1.6,
      ao
        ? {
            mode: ao.mode,
            direction,
            pivot,
            speed: ao.speed,
            ease: ao.ease,
            amplitude: ao.amplitude,
            yawLimit: ao.yawLimit,
            arc: ao.arc,
          }
        : undefined,
      // Hide this hero's own dot on ARRIVAL, not on click: while the camera is
      // still flying the dot is the thing you are flying at, but once landed it
      // sits dead centre in front of the object it labels. Restored by
      // exitCloseupUI(). Stepping to another hero re-shows the previous one
      // because closeupHero is reset just below on every fly.
      () => {
        heroes!.setHiddenHero(hero);
        // The colour bake held for the flight fires on this very frame: the
        // last easing step moved the camera, and the restored threshold is
        // far below the distance accumulated in the air.
        quality?.resumeColorBake();
      },
    );
    // The pads go away for the duration of the close-up. closeupHero was set at
    // the top of this function, so the rule reads it as "a card is open" —
    // called BEFORE the card animates in, so the swap looks like one movement.
    refreshSticks();
    // Card style is per-demo: HUD panel, or a callout pinned to the 3D point.
    const cardStyle = loader.activeDemo?.cardStyle;
    if (cardStyle === 'anchored') {
      ui.showAnchoredCard(hero);
      heroes!.setActiveAnchor(hero.anchor ?? hero.pose.target);
    } else {
      ui.showHeroCard(hero, cardStyle === 'hud-bottom' ? 'bottom' : 'left', loader.activeDemo?.id);
    }
  }

  // Closing the card (× / Esc) releases the constraints and returns home.
  function exitCloseup(): void {
    if (!controller) return;
    controller.exitHero();
    exitCloseupUI();
    if (loader.homePose) {
      // The fly-home is the other flight in the recording's frame drops; same
      // hold, released on arrival (or by onUserInteract if interrupted).
      if (holdBakeInFlight) quality?.suspendColorBake();
      controller.flyTo(loader.homePose, 1.3, () => quality?.resumeColorBake());
    }
  }

  function exitCloseupUI(): void {
    ui.hideHeroCard();
    ui.hideAnchoredCard();
    heroes?.setActiveAnchor(null);
    heroes?.setHiddenHero(null); // the dot comes back with the card closed
    closeupHero = null;
    // A scene swap or a destroy mid-flight ends the flight without onArrive;
    // this runs on both paths (SceneLoader.load, destroy), so the hold cannot
    // leak into the next scene. exitCloseup() re-holds AFTER this for the
    // fly-home.
    quality?.resumeColorBake();
    // The sticks come back with the card closed, for the same reason the dot
    // does — free roam has resumed. Must follow the closeupHero reset above.
    refreshSticks();
  }

  // ---- The public handle ------------------------------------------------------
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    // Scene first (frees GPU + JS memory), then the machinery.
    exitCloseupUI();
    loader.unload();
    loader.activeDemo = null;
    loader.pendingHero = null;
    ui.setLive(null); // releases the page scroll lock
    ro?.disconnect();
    ro = null;
    for (const d of mqDisposers) d();
    mqDisposers.length = 0;
    controller?.detach(); // the window-level key/pointer listeners
    controller = null;
    heroes = null;
    sticks = null;
    // Destroys the frame loop, the assets registry, and the graphics device —
    // this is what releases the WebGL/WebGPU context so a second mount can
    // create a fresh one.
    app?.destroy();
    app = null;
    // Remove the injected chrome and modals; a second createViewer() re-injects
    // them fresh, with fresh listeners. Page-owned listeners go via dispose().
    document.getElementById('stage')?.remove();
    document.getElementById('disclaimer')?.remove();
    document.getElementById('unsupported')?.remove();
    ui.dispose();
  }

  return {
    load: (sceneId: string) => enterViewer(sceneId),
    goToHero: (heroId: string) => {
      for (const demo of scenes) {
        const hero = demo.heroPoints.find((h) => h.id === heroId);
        if (hero) {
          selectHero(hero);
          return;
        }
      }
      console.error(`${logTag()} unknown hero "${heroId}"`);
    },
    destroy,
  };
}
