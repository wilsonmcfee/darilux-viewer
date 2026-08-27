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

import { BRAND, DEMOS } from './demos';
import type { Demo, HeroPoint, Pose } from './types';
import { setBrand, logTag } from './brand';
import { createDevice, canRender } from './device';
import { OrbitFlyCamera } from './camera';
import { HeroPointManager } from './heropoints';
import { SplatPicker } from './splatpick';
import { mountChrome } from './stage';
import { TouchSticks, wantsTouchControls } from './joystick';
import { PerfHud } from './perfhud';
import {
  SplatQualityControl,
  MOBILE_PRESET,
  LAST_PASS_PRESET,
  ENGINE_DEFAULTS,
  type SplatQuality,
} from './splatquality';
import { mountPhoneDock } from './phonedock';
import { UI } from './ui';

// Hand the deployment's identity to the engine before anything logs or renders
// brand-flavoured copy. Module top-level so it precedes every boot path.
setBrand(BRAND);

function boot(): void {
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
  // anchor picking. The picker decodes each scene's splat centers on the CPU —
  // author-only cost, never paid by visitors.
  const authorMode = /author/i.test(location.search + location.hash);
  const picker = new SplatPicker();

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

  let activeDemo: Demo | null = null;
  let currentSplat: Entity | null = null;
  let currentAsset: Asset | null = null;
  let homePose: Pose | null = null; // the opening framing to return to on "Exit close-up"
  let pendingFrame = false; // true while we wait for a scene's bounds to auto-frame it
  let pendingHero: HeroPoint | null = null; // fly here once the scene finishes loading
  let closeupHero: HeroPoint | null = null; // hero currently being viewed up close
  let stickOverride: boolean | null = null; // __sticks(0/1); null = decide by device
  /* Fraction of the frame height a hero close-up lifts its subject on the mobile
     card layout. 0.27 is the middle of the 25-30% Will judged by eye on a phone.
     Overridable with ?lift=N / __heroLift(n) — see camera.setHeroFrameLift(). */
  let heroLift = 0.27;

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
        activeDemo === null ? 'poster' : closeupHero !== null ? 'hero' : 'roam';
    }

    if (!sticks) return;
    const want =
      activeDemo !== null &&
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
   * THE DOCKED PHONE PAGE GETS 0, and it is worth saying why rather than
   * treating it as one more special case. The lift is a workaround for a card
   * that covers the middle of the frame; on bluedio-phone.html the card is not
   * in the frame at all, it is in the strip underneath. So the workaround has
   * nothing to work around, and turning it off restores every hero pose to the
   * framing that was actually authored — a small, free quality win that comes
   * out of the layout rather than out of any tuning.
   */
  function refreshHeroFraming(): void {
    if (!controller) return;
    const cardOverScene = !phoneDock && (stickOverride ?? wantsTouchControls());
    controller.setHeroFrameLift(cardOverScene ? heroLift : 0);
  }

  const ui = new UI(DEMOS, {
    onEnterViewer: (demoId) => enterViewer(demoId),
    onExitViewer: () => exitViewer(),
    onSelectHero: (hero) => selectHero(hero),
    onExitCloseup: () => exitCloseup(),
    // Persists across scene loads — HeroPointManager keeps it separate from the
    // load gate, so streaming a new splat cannot switch the points back on.
    onTogglePoints: (on) => heroes?.setPointsEnabled(on),
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
  for (const q of ['(max-width: 820px)', '(pointer: coarse)']) {
    const mq = window.matchMedia?.(q);
    // addEventListener on MediaQueryList is Safari 14+; addListener is the
    // fallback for the older WKWebView this project explicitly still targets.
    const onChange = (): void => {
      refreshSticks();
      refreshHeroFraming();
    };
    if (mq?.addEventListener) mq.addEventListener('change', onChange);
    else mq?.addListener?.(onChange);
  }

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
      perfScale: phoneDock ? 0.75 : 0.5,
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
    };
    heroes = new HeroPointManager(camera, document.getElementById('hero-layer')!);
    heroes.onSelect = (hero) => selectHero(hero);

    // ---- Touch thumb sticks --------------------------------------------------
    // Built once alongside the camera, then shown or hidden by refreshSticks().
    // The pads only translate a finger into a vector; the camera decides what
    // that means, which is why both callbacks are one line each.
    sticks = new TouchSticks(
      document.getElementById('touch-controls')!,
      (v) => controller!.setMoveAxis(v.x, v.y),
      (v) => controller!.setLookAxis(v.x, v.y),
    );

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

    /* ?fov=70 — the portrait field-of-view ceiling, as a URL param.
       It duplicates __maxFov() on purpose. The 80° default in camera.ts is the
       one number in the mobile pass that is a judgement rather than a
       derivation, so it has to be settled by holding a PHONE — and a phone is
       exactly where a console knob is out of reach. A param can be typed into
       the address bar and A/B'd by editing one character, which is the whole
       difference between "tunable" and "tunable in principle".
       Same reading as ?sharpen: absent or unparseable leaves the default. */
    const fovParam = Number(new URLSearchParams(window.location.search).get('fov') ?? '0');
    if (fovParam > 20) controller.setMaxFov(fovParam);

    /* ?look=60 and ?lift=0.2 — the two remaining feel numbers, on the same
       reasoning as ?fov: both were judged by holding a phone, so both have to be
       adjustable from one. `lift` reads NaN-safely because 0 is a MEANINGFUL
       value here (it turns the lift off), so it cannot use the `> 0` guard the
       other two do. */
    const lookParam = Number(new URLSearchParams(window.location.search).get('look') ?? '0');
    if (lookParam > 0) controller.setLookRate(lookParam);

    const liftRaw = new URLSearchParams(window.location.search).get('lift');
    if (liftRaw !== null && Number.isFinite(Number(liftRaw))) heroLift = Number(liftRaw);
    refreshHeroFraming();

    // Walk mode is OFF in authoring mode: you cannot author a hero pose 2.4 m
    // up from a body that cannot leave the floor, and orbit/fly exist precisely
    // as authoring tools. __walk(1) puts it back so a framing can be checked at
    // standing height without dropping ?author.
    controller.setWalkEnabled(!authorMode);

    // Expose the pose/anchor authoring helpers for the browser console.
    (window as unknown as { __logPose: () => void }).__logPose = () => controller!.logPose();
    (window as unknown as { __logAnchor: () => void }).__logAnchor = () => controller!.logAnchor();
    // Walk-mode knobs. __eyeHeight() is the one to reach for: the 1.55 m in
    // demos.ts is a reasoned choice, not a measured fact, and it should be
    // settled against real WebGPU frames rather than argued about on paper.
    (window as unknown as { __walk: (on: unknown) => void }).__walk = (on) =>
      controller!.setWalkEnabled(Boolean(Number(on)));
    (window as unknown as { __eyeHeight: (m?: number) => number | null }).__eyeHeight = (m) => {
      if (m === undefined) return controller!.eyeHeightMetres;
      return controller!.setEyeHeight(m);
    };
    // Signed distance to the walk boundary + the backstop counter (brief §8).
    (window as unknown as { __walkDebug: () => unknown }).__walkDebug = () =>
      controller!.walkDebug;
    /* Portrait fov knob. The 80° ceiling in camera.ts is the one number in the
       mobile pass that is a judgement rather than a derivation, so it gets a
       live handle: hold the phone, run __maxFov(70) and __maxFov(95), and pick.
       __maxFov() with no argument just reports what is being rendered, which is
       the fastest way to tell an authored fov from a compensated one. */
    (window as unknown as { __maxFov: (n?: number) => unknown }).__maxFov = (n) => {
      if (n === undefined) return controller!.fovDebug;
      controller!.setMaxFov(n);
      return controller!.fovDebug;
    };
    // Force the touch pads on or off regardless of the device (?touch=1 does the
    // same from the URL, which is the one that survives a page load on a phone).
    // Also re-decides the hero lift, which keys off the same override.
    (window as unknown as { __sticks: (on: unknown) => void }).__sticks = (on) => {
      stickOverride = Boolean(Number(on));
      refreshSticks();
      refreshHeroFraming();
    };
    /* Look-stick top speed, degrees/second at full deflection. 105 tested "much
       too sensitive" on a phone and is now 75; this is how the next 10° gets
       found without a rebuild. ?look=N does the same from the URL. */
    (window as unknown as { __lookRate: (n?: number) => number }).__lookRate = (n) =>
      controller!.setLookRate(n ?? NaN);
    /* How far a close-up lifts its subject above centre, as a fraction of frame
       height, so the card cannot cover the gear. Only active on the mobile card
       layout. __heroLift(0) turns it off for an immediate A/B. */
    (window as unknown as { __heroLift: (n?: number) => number }).__heroLift = (n) => {
      if (n !== undefined) heroLift = Number(n);
      refreshHeroFraming();
      return heroLift;
    };

    /* ---- The frame-time readout -----------------------------------------
       `?stats` from the URL, `__stats(1)` from a console. The URL form is the
       one that matters: it is the only one that survives being typed on a
       phone, and the phone is the only place the number is interesting.

       This is deliberately NOT gated behind ?author. Authoring mode turns walk
       mode OFF (see the note above), and walking is exactly when the sort and
       fill costs peak — so measuring under ?author would measure the wrong
       thing. The two flags are orthogonal and both are usable at once. */
    const statsParam = /(^|[?&#])stats(=1|[&#]|$)/i.test(
      window.location.search + window.location.hash,
    );
    if (statsParam) perf.setEnabled(true);
    (window as unknown as { __stats: (on?: unknown) => boolean }).__stats = (on) =>
      perf.setEnabled(on === undefined ? !perf.isEnabled : Boolean(Number(on)));

    /* ---- The splat cost/quality knobs, live ------------------------------
       These are the numbers that trade image quality for frame time, and every
       one of them is a judgement that wants the phone it is for. Before this
       existed they could only be changed by editing source and redeploying,
       which is why the project got this far having never tuned one.

         __splat()                            report current values, and which
                                              of them this device honours
         __splat({ alphaClipForward: 0.06 })  set one or more
         __splat('mobile')                    the current preset
         __splat('off')                       engine stock
         __splat('lastpass')                  the OLD mobile preset — the one
                                              judged too aggressive on the phone

       Pair with `?stats` and read the effect on the same screen. The honest A/B
       is `__splat('lastpass')` against `__splat('mobile')` while walking: that
       is the exact change this pass made, in one call each way, and it is the
       one to run if the pendulum is ever suspected of having swung too far back
       toward quality.

       Safe to call interactively with ONE exception: `antiAlias` forces a
       shader recompile (not a work-buffer rebuild), so expect a hitch on the
       call that changes it. Everything else routes through paths that do not
       set `scene.gsplat.dirty`. Checked and noted in splatquality.ts — do not
       add a knob here without checking which bucket it is in. */
    (window as unknown as { __splat: (q?: unknown) => unknown }).__splat = (q) => {
      if (!quality) return 'no engine yet — enter a viewer first';
      if (q === 'mobile') quality.apply(MOBILE_PRESET);
      else if (q === 'lastpass' || q === 'old') quality.apply(LAST_PASS_PRESET);
      else if (q === 'off' || q === 'reset') quality.apply(ENGINE_DEFAULTS);
      else if (q && typeof q === 'object') quality.apply(q as SplatQuality);
      // Every path above can change what is on screen without moving the
      // camera, which under on-demand rendering means nothing would redraw and
      // the knob would look broken. This is the whole reason wake() is not
      // private to the frame loop.
      wake();
      return quality.report();
    };

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
          console.log(logTag() + ' copy blocked — paste from here:\n' + snippet);
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

      console.info(logTag() + ' authoring mode — Copy pose for framings; Snap anchor (or double-click) pins to the splat surface');
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
    app.on('frameend', () => perf.sample());

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
    const demo = DEMOS.find((d) => d.id === demoId);
    if (!demo) {
      console.error(`${logTag()} unknown demo "${demoId}"`);
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
    // Show whatever was hidden before (stepping between heroes) and record the
    // new one so an interrupted fly-in still hides it (see onUserInteract).
    heroes!.setHiddenHero(null);
    closeupHero = hero;
    // flyToHero enters constrained close-up mode (auto-orbit + view limits).
    // Per-hero autoOrbit config (spin vs sway, direction, pivot) rides along.
    const ao = hero.autoOrbit;
    const pivot = orbitPivot(hero);
    const direction = orbitDirection(ao);
    /* ---- No idle motion on a phone ---------------------------------------
       Auto-orbit is the reason a close-up on a phone never stops costing
       anything, and a close-up is the state a visitor sits in LONGEST — it is
       the reading state. With on-demand rendering (see the frame loop) a still
       camera costs literally zero, so dropping the orbit is what converts the
       longest state in the experience from "full splat fill at 60 fps" into
       "free". That is the fix for the frame rate decaying over several minutes:
       the decay was thermal, and a phone that never heats up never throttles.

       Mode 'none' rather than skipping the options object entirely — the yaw
       and pitch LIMITS come through the same path, and those are what keep a
       close-up pointed at the gear instead of at the wall behind it.

       Desktop keeps the orbit: it is plugged in, it is not thermally limited,
       and the slow sway is a real part of how the close-ups read there. */
    const stillCloseups = stickOverride ?? wantsTouchControls();
    controller!.flyToHero(
      hero.pose,
      1.6,
      ao
        ? {
            mode: stillCloseups ? 'none' : ao.mode,
            direction,
            pivot,
            speed: ao.speed,
            ease: ao.ease,
            amplitude: ao.amplitude,
            yawLimit: ao.yawLimit,
            arc: ao.arc,
          }
        : stillCloseups
          ? { mode: 'none' }
          : undefined,
      // Hide this hero's own dot on ARRIVAL, not on click: while the camera is
      // still flying the dot is the thing you are flying at, but once landed it
      // sits dead centre in front of the object it labels. Restored by
      // exitCloseupUI(). Stepping to another hero re-shows the previous one
      // because closeupHero is reset just below on every fly.
      () => heroes!.setHiddenHero(hero),
    );
    // The pads go away for the duration of the close-up. closeupHero was set at
    // the top of this function, so the rule reads it as "a card is open" —
    // called BEFORE the card animates in, so the swap looks like one movement.
    refreshSticks();
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
    heroes?.setHiddenHero(null); // the dot comes back with the card closed
    closeupHero = null;
    // The sticks come back with the card closed, for the same reason the dot
    // does — free roam has resumed. Must follow the closeupHero reset above.
    refreshSticks();
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

    /* Render continuously for the whole load. The splat streams in, bakes and
       sorts over many frames, and none of that moves the camera — so under
       on-demand rendering the visitor would watch a frozen loading veil over a
       black canvas. Re-armed when the scene lands. SuperSplat does exactly
       this: autoRender true while loading, false once ready. */
    if (app) app.autoRender = true;
    armIn = 0;

    // Poses are authored at this demo's desktop window aspect; the camera
    // compensates fov whenever the live viewport is narrower (see camera.ts).
    controller!.setReferenceAspect(demo.refAspect ?? 16 / 9);
    // Height-locked movement, for the demos that declare a floor and a scale.
    // Explicitly null for the others, so swapping scenes can never leave the
    // previous demo's walk plane installed under the new one.
    controller!.setWalk(demo.walk ?? null);

    exitCloseupUI();
    // Both guides go in; ui.ts picks between them when the card is rendered, so
    // the copy still matches the device if the phone is rotated meanwhile.
    ui.setGuide(demo.guide ?? null, demo.guideTouch ?? null);
    ui.showLoading(`Loading ${demo.title}…`);
    heroes!.setVisible(false);
    pendingFrame = false; // cancel any auto-frame still pending from a prior scene

    // Tear down the previous scene so only one splat is ever in memory.
    unloadScene();

    /* ---- Pick the bundle ---------------------------------------------------
       THE DEFAULT FLIPPED 2026-08-25: phones now get the FULL scene.

       The reduced `srcMobile` bundle (1.2M gaussians against 2.53M) was built
       on the reasoning that splat count is the one mobile cost no renderer
       setting can reduce, which is true. What was missing was a control: the
       SAME 2.53M asset is what SuperSplat's viewer serves from the same file,
       on the same phone, without lagging — so 2.53M is demonstrably survivable
       and the reduction was never the thing standing between this viewer and a
       smooth frame. Half the gaussians was simply the third of three
       simultaneous quality cuts, and the picture that came back was judged too
       soft and too aggressively culled. The other two are undone in device.ts
       and splatquality.ts; this is the third.

       The bundle is NOT deleted, and neither is the pipeline that builds it.
       Splat count is still the only lever that touches the depth sort, so if
       `?stats` shows the sort running longer than a frame on a real device —
       the failure mode where the picture SWIMS rather than merely running
       slow — this is the switch to reach for. It is one URL parameter away:

         ?lite=1   the 1.2M bundle, i.e. what shipped before this change
         ?full=1   the 2.53M bundle explicitly (now also the default)

       Authoring mode still forces the full asset unconditionally: a hero pose
       judged against a decimated cloud is a pose judged against a picture no
       visitor will ever see, and __logPose() output has to stay valid for it. */
    const flags = window.location.search + window.location.hash;
    const useMobile =
      !authorMode &&
      !!demo.srcMobile &&
      /(^|[?&#])lite(=1|[&#]|$)/i.test(flags) &&
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
    if (authorMode) {
      picker.load(url).catch((e) => console.warn(logTag() + ' splat pick data unavailable:', e));
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

      /* Resident gaussian count, straight off the decoded resource rather than
         from the meta.json this file never parses. Optional-chained through
         `unknown` because `numSplats` is typed `any` on GSplatResourceBase and
         the readout is diagnostic — a HUD that could throw during a scene load
         would be worse than a HUD that prints 0.00M. */
      perf.setSplatCount(
        Number((asset.resource as { numSplats?: number } | null)?.numSplats ?? 0),
      );

      heroes!.setDemo(demo);
      heroes!.setVisible(true);
      ui.hideLoading();

      // Pads in with the scene, not with the Enter tap: setWalk() has landed by
      // now, so walkActive is finally truthful, and there is something to walk
      // through. A pendingHero fly-in below immediately takes them away again.
      refreshSticks();

      /* Start the countdown to on-demand rendering. NOT a flip to false here:
         `load` fires when the asset has decoded, which is several frames before
         the work buffer is baked, the first depth sort has come back and (for a
         bounds-framed scene) the camera has been aimed at all. Going to sleep
         in that window is how this shows a black or half-sorted room. */
      if (onDemand) armIn = ARM_FRAMES;
      wake();

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
      console.error(`${logTag()} failed to load ${url}:`, err);
      ui.showLoading(
        `Couldn't load ${demo.title}. Check public/${demo.src} exists — see README.`,
      );
    });

    app!.assets.add(asset);
    app!.assets.load(asset);
  }
}

boot();
