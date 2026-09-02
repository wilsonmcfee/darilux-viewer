/* ============================================================================
   knobs.ts — the live tuning surface: URL params and console handles.
   ----------------------------------------------------------------------------
   Split out of main.ts. Every "feel" number in the mobile pass was judged by
   holding a phone, so every one is reachable FROM a phone as a URL param — a
   console is not. Params survive a reload; the console twins do not. None of
   these changes what a visitor sees by default.
   ========================================================================== */

import { CameraFrame, TONEMAP_NONE, type Application, type Entity } from 'playcanvas';
import type { OrbitFlyCamera } from './camera';
import type { PerfHud } from '../ui/perfhud';
import {
  MOBILE_PRESET,
  LAST_PASS_PRESET,
  ENGINE_DEFAULTS,
  type SplatQuality,
  type SplatQualityControl,
} from './splatquality';

export interface KnobDeps {
  app: Application;
  camera: Entity;
  controller: OrbitFlyCamera;
  perf: PerfHud;
  quality(): SplatQualityControl | null;
  /** Redraw request for changes that do not move the camera. */
  wake(): void;
  refreshSticks(): void;
  refreshHeroFraming(): void;
  getHeroLift(): number;
  setHeroLift(n: number): void;
  setStickOverride(on: boolean): void;
  /** The sort gate: metres of translation / degrees of rotation before a re-sort. */
  getSortGate(): { distance: number; angle: number };
  setSortGate(g: { distance?: number; angle?: number }): void;
  /** WebGL2 order-texture upload path A/B (see gsplatinternals.ts). */
  setOrderUploadPath(p: 'direct' | 'pbo'): void;
  /** Hold colour re-bakes while a fly-in is in the air. */
  setHoldBakeInFlight(on: boolean): void;
}

/** Read URL params, apply the ones present, and register the console handles. */
export function installKnobs(deps: KnobDeps): void {
  const { app, camera, controller, perf } = deps;

  /* Dev-only: the raw Application, so the documented hidden-pane workflow
     (TEMPLATE.md gotcha 13 — `app.update(1/60)` then `app.render()` when
     document.hidden stops rAF) is actually reachable from a console or a
     driver script. Gated at build time; production bundles never carry it. */
  if (import.meta.env.DEV) {
    (window as unknown as { __app: Application }).__app = app;
  }

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
    if (!camFrame) camFrame = new CameraFrame(app, camera.camera!);
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
  if (liftRaw !== null && Number.isFinite(Number(liftRaw))) deps.setHeroLift(Number(liftRaw));
  deps.refreshHeroFraming();

  // Walk-mode knobs. __eyeHeight() is the one to reach for: the 1.55 m in
  // demos.ts is a reasoned choice, not a measured fact, and it should be
  // settled against real WebGPU frames rather than argued about on paper.
  (window as unknown as { __walk: (on: unknown) => void }).__walk = (on) =>
    controller.setWalkEnabled(Boolean(Number(on)));
  (window as unknown as { __eyeHeight: (m?: number) => number | null }).__eyeHeight = (m) => {
    if (m === undefined) return controller.eyeHeightMetres;
    return controller.setEyeHeight(m);
  };
  // Signed distance to the walk boundary + the backstop counter (brief §8).
  (window as unknown as { __walkDebug: () => unknown }).__walkDebug = () =>
    controller.walkDebug;
  /* Portrait fov knob. The 80° ceiling in camera.ts is the one number in the
     mobile pass that is a judgement rather than a derivation, so it gets a
     live handle: hold the phone, run __maxFov(70) and __maxFov(95), and pick.
     __maxFov() with no argument just reports what is being rendered, which is
     the fastest way to tell an authored fov from a compensated one. */
  (window as unknown as { __maxFov: (n?: number) => unknown }).__maxFov = (n) => {
    if (n === undefined) return controller.fovDebug;
    controller.setMaxFov(n);
    return controller.fovDebug;
  };
  // Force the touch pads on or off regardless of the device (?touch=1 does the
  // same from the URL, which is the one that survives a page load on a phone).
  // Also re-decides the hero lift, which keys off the same override.
  (window as unknown as { __sticks: (on: unknown) => void }).__sticks = (on) => {
    deps.setStickOverride(Boolean(Number(on)));
    deps.refreshSticks();
    deps.refreshHeroFraming();
  };
  /* Look-stick top speed, degrees/second at full deflection. 105 tested "much
     too sensitive" on a phone and is now 75; this is how the next 10° gets
     found without a rebuild. ?look=N does the same from the URL. */
  (window as unknown as { __lookRate: (n?: number) => number }).__lookRate = (n) =>
    controller.setLookRate(n ?? NaN);
  /* How far a close-up lifts its subject above centre, as a fraction of frame
     height, so the card cannot cover the gear. Only active on the mobile card
     layout. __heroLift(0) turns it off for an immediate A/B. */
  (window as unknown as { __heroLift: (n?: number) => number }).__heroLift = (n) => {
    if (n !== undefined) deps.setHeroLift(Number(n));
    deps.refreshHeroFraming();
    return deps.getHeroLift();
  };

  /* ---- The 2026-09-02 profiling knobs ----------------------------------
     Three handles from the pass that found the WebGL2 order-texture upload
     (TEMPLATE.md → "Profiled 2026-09-02"). All three are A/B handles for a
     device that is not this one — the Firefox/Linux laptop, the phone — so
     all three are URL params first and console twins second.

       ?sortdist=N      metres of camera travel before a re-sort (default
                        0.05; 0 = engine stock, a third of a millimetre).
                        __sortGate({distance: N})
       ?sortangle=N     the directional-sort twin, degrees (default 0 = engine
                        stock 0.057°). Only matters after
                        __splat({radialSorting: false}). __sortGate({angle: N})
       ?pbo=1           WebGL2 only: upload the order through a PBO +
                        texSubImage2D instead of one texImage2D. The engine
                        picked texImage2D because the PBO path stalls Chrome;
                        this is for finding out what Firefox does.
       ?flybake=1       keep re-baking colour DURING fly-ins (the hold is the
                        default). __flyBake(0/1)

     `?sortdist` reads NaN-safely and 0 is meaningful (engine stock), so it
     uses the `!== null` form rather than the `> 0` guard the fov knobs use. */
  const params = new URLSearchParams(window.location.search);
  const sortDistRaw = params.get('sortdist');
  if (sortDistRaw !== null && Number.isFinite(Number(sortDistRaw)) && Number(sortDistRaw) >= 0) {
    deps.setSortGate({ distance: Number(sortDistRaw) });
  }
  const sortAngleRaw = params.get('sortangle');
  if (sortAngleRaw !== null && Number.isFinite(Number(sortAngleRaw)) && Number(sortAngleRaw) >= 0) {
    deps.setSortGate({ angle: Number(sortAngleRaw) });
  }
  if (/(^|[?&#])pbo(=1|[&#]|$)/i.test(window.location.search + window.location.hash)) {
    deps.setOrderUploadPath('pbo');
  }
  if (/(^|[?&#])flybake(=1|[&#]|$)/i.test(window.location.search + window.location.hash)) {
    deps.setHoldBakeInFlight(false);
  }
  (
    window as unknown as {
      __sortGate: (g?: { distance?: number; angle?: number }) => { distance: number; angle: number };
    }
  ).__sortGate = (g) => {
    if (g && typeof g === 'object') deps.setSortGate(g);
    return deps.getSortGate();
  };
  (window as unknown as { __flyBake: (on: unknown) => void }).__flyBake = (on) =>
    deps.setHoldBakeInFlight(Boolean(Number(on)));
  (window as unknown as { __pbo: (on: unknown) => void }).__pbo = (on) =>
    deps.setOrderUploadPath(Number(on) ? 'pbo' : 'direct');

  /* ---- The frame-time readout -----------------------------------------
     `?stats` from the URL, `__stats(1)` from a console. The URL form is the
     one that matters: it is the only one that survives being typed on a
     phone, and the phone is the only place the number is interesting.

     This is deliberately NOT gated behind ?author. Authoring mode turns walk
     mode OFF, and walking is exactly when the sort and fill costs peak — so
     measuring under ?author would measure the wrong thing. The two flags are
     orthogonal and both are usable at once. */
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
    const quality = deps.quality();
    if (!quality) return 'no engine yet — enter a viewer first';
    if (q === 'mobile') quality.apply(MOBILE_PRESET);
    else if (q === 'lastpass' || q === 'old') quality.apply(LAST_PASS_PRESET);
    else if (q === 'off' || q === 'reset') quality.apply(ENGINE_DEFAULTS);
    else if (q && typeof q === 'object') quality.apply(q as SplatQuality);
    // Every path above can change what is on screen without moving the
    // camera, which under on-demand rendering means nothing would redraw and
    // the knob would look broken. This is the whole reason wake() is not
    // private to the frame loop.
    deps.wake();
    return quality.report();
  };
}
