/* ============================================================================
   site-entry.ts — what a client site's main.ts looks like.
   ----------------------------------------------------------------------------
   All three pages boot through here: hand the engine this deployment's scenes
   and brand, and get a viewer. This file is the shape each per-client repo's
   ~20-line src/main.ts takes after the repo split — the engine itself never
   imports demos.ts.
   ========================================================================== */

import { createViewer } from './index';
import { BRAND, DEMOS } from './demos';

const viewer = createViewer({
  mount: document.body,
  scenes: DEMOS,
  brand: BRAND,
});

// Console handle — lets a session drive the public API directly
// (__viewer.goToHero('juno'), __viewer.destroy()) and is what the embed
// tiers will forward analytics events through.
(window as unknown as { __viewer: typeof viewer }).__viewer = viewer;
