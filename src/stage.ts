/* ============================================================================
   stage.ts — the shared viewer chrome, as markup.
   ----------------------------------------------------------------------------
   Every page that hosts a viewer needs the same ~40 lines: the canvas, the hero
   layer, both card variants, the loading veil, the bottom-left controls, the
   help card, and the X. It lives here as ONE string rather than being pasted
   into each page's HTML, because it is not static in practice — the bottom-left
   controls were added to it mid-project, and a second copy would have silently
   missed them.

   A page supplies only a mount point:

       <div id="stage-dock" hidden></div>

   and mountChrome() fills it before UI is constructed. UI resolves every one of
   these ids eagerly and throws on a miss, so the order matters.

   CAREFUL: the markup below lives inside template literals, so it must contain
   no backticks and no ${...}. An HTML comment quoting a field name in
   backticks is enough to end the string early — which is exactly what happened
   the first time.
   ========================================================================== */

/** The shared stage: canvas plus every overlay that sits on top of it. */
export const STAGE_HTML = `
<div id="stage">
  <canvas id="viewer"></canvas>

  <!-- Hero-point markers are injected here and positioned each frame. -->
  <div id="hero-layer" aria-hidden="true"></div>

  <!-- Hero-point description card (HUD variants). -->
  <aside id="hero-card" class="hidden" role="dialog" aria-label="Gear details">
    <button id="hero-card-close" class="modal-close" type="button" aria-label="Close">×</button>
    <!-- Step to the previous / next hero without leaving the card. Shown by
         ui.ts only when the live demo has more than one hero point. -->
    <button id="hero-card-prev" class="hero-card-nav prev" type="button" aria-label="Previous point">&lsaquo;</button>
    <button id="hero-card-next" class="hero-card-nav next" type="button" aria-label="Next point">&rsaquo;</button>
    <div id="hero-card-body"></div>
  </aside>

  <!-- Anchored variant: pinned to the hero's 3D point each frame. -->
  <aside id="hero-card-anchored" class="hidden" role="dialog" aria-label="Gear details">
    <button id="hero-card-anchored-close" class="modal-close" type="button" aria-label="Close">×</button>
    <div id="hero-card-anchored-body"></div>
  </aside>

  <!-- Loading veil shown while a splat streams in. -->
  <div id="loading" class="hidden">
    <div class="spinner" role="status" aria-label="Loading scene"></div>
    <div id="loading-label">Loading…</div>
  </div>

  <!-- Bottom-left stage controls. Both have to live INSIDE the stage:
       while a scene is open the page beneath is frozen, so the guide copy
       under the viewer is out of reach exactly when it is wanted. -->
  <div id="stage-controls">
    <button id="stage-info" class="stage-ctl" type="button"
            aria-label="How to move around" aria-expanded="false"
            aria-controls="info-card" data-tip="How to move around">i</button>
    <button id="points-toggle" class="stage-ctl" type="button"
            role="switch" aria-checked="true" aria-label="Point visibility"
            data-tip="Point visibility">
      <span class="switch-track"><span class="switch-knob"></span></span>
    </button>
  </div>

  <!-- Navigation help, opened by the i. Content comes from the live demo's
       guide field in demos.ts, not from markup. -->
  <aside id="info-card" class="hidden" role="dialog" aria-label="How to move around">
    <button id="info-card-close" class="modal-close" type="button" aria-label="Close">×</button>
    <div id="info-card-body"></div>
  </aside>

  <!-- Returns the active window to its poster (and frees the scene). -->
  <button id="stage-exit" type="button" aria-label="Leave the room">×</button>
</div>
`;

/** Page-level modals. Their triggers stay per-page; only the shells are here. */
export const MODALS_HTML = `
<!-- Disclaimer modal (content set in ui.ts; copy lives in DISCLAIMER-DRAFT.md). -->
<div id="disclaimer" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
  <div class="modal-card">
    <button id="disclaimer-close" class="modal-close" type="button" aria-label="Close">×</button>
    <div id="disclaimer-body"></div>
  </div>
</div>

<!-- Fallback overlay when the device can't render splats at all. -->
<div id="unsupported" class="modal hidden" role="dialog" aria-modal="true">
  <div class="modal-card">
    <h2>This experience needs a modern browser</h2>
    <p>
      These interactive captures render with WebGL2 / WebGPU. Your current browser
      doesn't support them — most often this happens inside an in-app browser
      (opening the link from a chat app) or on an older device.
    </p>
    <p><strong>Try:</strong> open this link directly in Chrome or Safari, or update to a recent version.</p>
  </div>
</div>
`;

/**
 * Inject the chrome into the page. Idempotent, and a no-op for anything a page
 * already provides, so a page MAY still hand-roll a piece if it needs to.
 */
export function mountChrome(): void {
  const dock = document.getElementById('stage-dock');
  if (!dock) throw new Error('Missing #stage-dock in the page HTML');
  if (!document.getElementById('stage')) dock.insertAdjacentHTML('beforeend', STAGE_HTML);
  if (!document.getElementById('disclaimer')) {
    document.body.insertAdjacentHTML('beforeend', MODALS_HTML);
  }
}
