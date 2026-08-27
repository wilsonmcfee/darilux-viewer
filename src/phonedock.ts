/* ============================================================================
   phonedock.ts — the docked phone layout, as a re-parenting pass.
   ----------------------------------------------------------------------------
   WHAT THIS IS

   bluedio-phone.html puts the scene in a 4:3 window and gives the controls
   their own strip UNDERNEATH it, rather than floating them over the picture.
   Everything that moves is already built by stage.ts and driven by main.ts and
   ui.ts; the only thing this module does is move three elements out of #stage
   and into #phone-dock, and tell the rest of the app which layout is live.

   WHY RE-PARENT RATHER THAN BUILD A SECOND SET OF CHROME

   Because a second copy would drift, and there is already a scar from exactly
   that: stage.ts exists because the stage markup was pasted into two pages and
   the bottom-left controls were silently added to only one of them. The thumb
   pads, the hero card and the i/points row all carry real behaviour — pointer
   capture, per-demo copy, aria state, the prev/next stepper — and duplicating
   the markup would duplicate every future fix to any of it.

   THE ONE THING THAT MAKES RE-PARENTING SAFE HERE

   UI resolves every element by id ONCE in its constructor and holds the
   references, and main.ts does the same for the touch layer. So moving a node
   after mountChrome() and before `new UI(...)` — or after, for that matter —
   changes where it draws and nothing else: the listeners, the ids and the
   held references all survive a move. What would NOT survive is re-creating
   the nodes, which is precisely what this module avoids.

   WHAT STAYS BEHIND, AND WHY

   - #hero-layer stays in #stage. The markers are projected onto canvas pixels
     every prerender; outside the canvas's own coordinate box they would be
     positioned against the wrong origin.
   - #stage-exit stays in #stage. It means "leave the room" and belongs to the
     window it closes, not to the control strip.
   - #loading stays in #stage. It veils the canvas.
   #info-card DOES move, unlike the other modal. It is opened by the i, the i is
   now in the dock, and over a 292px-tall scene the help card would cover most
   of the room it is explaining. Its trigger finds it by id through ui.ts rather
   than by DOM proximity, so moving it costs nothing.
   ========================================================================== */

/** Ids moved into the dock, in the order they should sit in it. */
import { logTag } from './brand';

const DOCKED_IDS = ['hero-card', 'info-card', 'touch-controls', 'stage-controls'] as const;

/**
 * Is the docked phone layout live on this page?
 *
 * Keyed off the DOM rather than off a URL or a media query on purpose. The
 * layout is a property of WHICH PAGE was opened, not of how wide the window
 * currently is: bluedio-phone.html is docked at every width, including on a
 * desktop where it is being reviewed, and bluedio.html is never docked even on
 * a phone. Anything that keys off viewport width here would flip the layout
 * mid-session on a rotation and strand the controls in a container that is no
 * longer displayed.
 */
export function isPhoneDock(): boolean {
  return document.body.classList.contains('phone');
}

/**
 * Move the control chrome out of the stage and into the dock beneath it.
 *
 * Must run AFTER mountChrome() (the elements do not exist before it) and is
 * idempotent, so a re-entrant call cannot shuffle the order.
 *
 * Returns the dock element, or null on a page that is not the docked layout —
 * so a caller can use the return value as the "is this layout live" test and
 * not have to ask twice.
 */
export function mountPhoneDock(): HTMLElement | null {
  if (!isPhoneDock()) return null;

  const dock = document.getElementById('phone-dock');
  if (!dock) throw new Error('body.phone requires a #phone-dock in the page HTML');

  for (const id of DOCKED_IDS) {
    const el = document.getElementById(id);
    // Not a throw: stage.ts owns this list, and a stage that legitimately drops
    // one of these later should degrade to "that control is not in the dock"
    // rather than to a blank page.
    if (!el) {
      console.warn(`${logTag()} phone dock: #${id} not found, leaving it where it is`);
      continue;
    }
    dock.appendChild(el);
  }

  /* Seed the state main.ts then keeps up to date (see refreshSticks). Set HERE
     rather than left to the first refresh, because between mount and the first
     Enter there is no engine, so nothing else runs — and an unset attribute
     would leave the i and the points toggle visible on the poster, which is the
     exact defect the state machine exists to close. */
  dock.dataset.state = 'poster';

  installWindowShapeKnob();
  return dock;
}

/**
 * `?win=N` / `__win(n)` — the viewer window's aspect ratio, live.
 *
 * On the same reasoning as `?fov`, `?look` and `?lift` before it: the shape of
 * this window is a judgement about how the page feels in a hand, and a phone
 * has no console to judge it from. A URL parameter can be typed into an address
 * bar and A/B'd by editing one character.
 *
 * The number is not purely taste, though, which is why it is worth reaching
 * for. Poses are authored at 68.6 degrees HORIZONTAL and camera.ts widens the
 * vertical fov on any narrower window to preserve that — until its 80-degree
 * vertical ceiling, past which it starts giving the horizontal away instead.
 * **0.85 is exactly where that ceiling starts to bind**, so it is the tallest
 * window that still shows everything the hero poses were composed to show, and
 * it lands the dock at ~371px on a 375x812 phone rather than 4:3's 531px. The
 * full table is in style.css beside the rule this writes to.
 *
 * Clamped to a sane band: the failure mode of a typo here is a window taller
 * than the screen with no dock under it, or one so short the scene is a letter
 * slot, and neither should be reachable by fat-fingering an address bar.
 */
function installWindowShapeKnob(): void {
  const set = (n: number): string => {
    const v = Math.min(Math.max(n, 0.5), 2);
    document.documentElement.style.setProperty('--viewer-aspect', String(v));
    return `${v} (window ${Math.round(window.innerWidth)}x${Math.round(
      window.innerWidth / v,
    )})`;
  };

  const raw = new URLSearchParams(window.location.search).get('win');
  const n = Number(raw);
  if (raw !== null && Number.isFinite(n) && n > 0) {
    console.info(`${logTag()} viewer window aspect: ${set(n)}`);
  }

  (window as unknown as { __win: (n?: number) => string }).__win = (v) =>
    v === undefined
      ? getComputedStyle(document.documentElement).getPropertyValue('--viewer-aspect') ||
        '4 / 3 (default)'
      : set(Number(v));
}
