/* ============================================================================
   index.ts — THE PUBLIC API. The only file a client site imports from.
   ----------------------------------------------------------------------------
   A site is a page, a Demo[] config, and a brand stylesheet:

     import { createViewer } from '@darilux/viewer';
     import { SCENES } from './scenes';

     createViewer({ mount: document.body, scenes: SCENES,
                    brand: { name: 'Darilux Studio', tag: 'darilux' } });

   Engine CSS rides along with createViewer (core/main.ts imports
   styles/index.css); the page links its own brand.css beside it.
   ========================================================================== */

export { createViewer } from './core/main';
export type { Viewer, ViewerOptions } from './core/main';
export type { Brand } from './core/brand';
export type {
  Demo,
  HeroPoint,
  Pose,
  DemoGuide,
  WalkConfig,
  WalkRegion,
  WalkHole,
  WalkFalloffZone,
} from './types';
