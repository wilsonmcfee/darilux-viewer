/* ============================================================================
   heropoints.ts — floating 3D-anchored markers for hero gear.
   ----------------------------------------------------------------------------
   Each hero point gets a DOM marker (a glowing dot + caption) that is PINNED to
   a 3D world position. Every frame we project that world point to the screen
   with camera.worldToScreen() and move the DOM element there, so the label
   appears to "stick" to the object as the visitor orbits. Clicking a marker
   flies the camera to that hero point's authored pose.

   Why DOM instead of in-scene 3D text: crisp typography, trivial styling, and
   perfect accessibility — the splat stays pure geometry, the labels stay HTML.

   TWO WAYS TO PICK A DOT, BY POINTER TYPE. A mouse clicks the marker element
   itself: it is precise, it gets the hover caption, and the 22px dot is a fine
   target for a cursor. A FINGER does not go through the element at all —
   markers.css makes every marker inert under `(pointer: coarse)` — and the
   canvas resolves its tap against the projected dot positions by distance
   (hitTest, driven from main.ts via the camera's onTap). See hitTest for why.
   ========================================================================== */

import { Entity, Vec3 } from 'playcanvas';
import type { Demo, HeroPoint } from '../types';

interface Marker {
  hero: HeroPoint;
  el: HTMLElement;
  anchor: Vec3;
  /* Where the dot was last drawn, in the canvas's CSS pixels — the same numbers
     written to left/top — so a tap can be resolved without re-projecting. */
  sx: number;
  sy: number;
  onScreen: boolean;
}

export class HeroPointManager {
  private cam: Entity;
  private layer: HTMLElement;
  private markers: Marker[] = [];
  // The hero currently being viewed up close. Its dot would otherwise sit dead
  // centre in front of the very object it labels.
  private hiddenHero: HeroPoint | null = null;
  private screen = new Vec3();
  private visible = true;        // scene gate: false while a splat streams in
  private pointsEnabled = true;  // the visitor's own toggle; survives scene loads

  // Optional anchored description card that tracks a hero's 3D point.
  private cardEl: HTMLElement | null;
  private activeAnchor: Vec3 | null = null;

  onSelect?: (hero: HeroPoint) => void;

  constructor(cameraEntity: Entity, layer: HTMLElement) {
    this.cam = cameraEntity;
    this.layer = layer;
    this.cardEl = document.getElementById('hero-card-anchored');
  }

  /** Pin the anchored card to a 3D point (null to stop tracking). */
  setActiveAnchor(anchor: [number, number, number] | null): void {
    this.activeAnchor = anchor ? new Vec3(anchor[0], anchor[1], anchor[2]) : null;
  }

  /** Rebuild markers for a demo (called on scene switch). */
  setDemo(demo: Demo): void {
    this.clear();
    for (const hero of demo.heroPoints) {
      const a = hero.anchor ?? hero.pose.target;
      const el = document.createElement('div');
      el.className = 'hero-marker';
      // 'info' variant: a larger ?-circle for notes about the capture itself.
      const dot =
        hero.variant === 'info'
          ? '<span class="hero-dot hero-dot-info">?</span>'
          : '<span class="hero-dot"></span>';
      el.innerHTML = `${dot}<span class="hero-caption">${hero.caption}</span>`;
      el.addEventListener('click', () => this.onSelect?.(hero));
      this.layer.appendChild(el);
      this.markers.push({
        hero,
        el,
        anchor: new Vec3(a[0], a[1], a[2]),
        sx: 0,
        sy: 0,
        onScreen: false,
      });
    }
  }

  /** Suppress one hero's marker (null shows them all again). */
  setHiddenHero(hero: HeroPoint | null): void {
    this.hiddenHero = hero;
  }

  /**
   * Scene gate — markers are hidden while a splat streams in and shown once it
   * lands. Deliberately SEPARATE from the visitor's preference below: a scene
   * load calling setVisible(true) must not quietly switch the points back on
   * for someone who turned them off.
   */
  setVisible(v: boolean): void {
    this.visible = v;
    this.applyDisplay();
  }

  /** The visitor's point-visibility toggle. Persists across scene loads. */
  setPointsEnabled(v: boolean): void {
    this.pointsEnabled = v;
    this.applyDisplay();
  }

  /** Both gates. Markers only exist on screen when each of them is open. */
  private get shown(): boolean {
    return this.visible && this.pointsEnabled;
  }

  private applyDisplay(): void {
    for (const m of this.markers) m.el.style.display = this.shown ? '' : 'none';
  }

  /** Reposition every marker; called each frame after the camera updates. */
  update(): void {
    if (!this.cam.camera) return;
    if (this.shown) {
      for (const m of this.markers) {
        /* Parked when it is the hero being viewed up close, or when the point is
           behind the camera (z <= 0). A CLASS, not inline opacity/pointer-events
           as it used to be: an inline `pointer-events: auto` rewritten here every
           frame outranks any stylesheet, which would silently undo the rule in
           markers.css that makes the dots inert to a finger. The stylesheet has
           to keep the last word on hit-testing, so this only names the state. */
        let off = m.hero === this.hiddenHero;
        if (!off) {
          this.cam.camera.worldToScreen(m.anchor, this.screen);
          off = this.screen.z <= 0;
        }
        m.el.classList.toggle('offscreen', off);
        m.onScreen = !off;
        if (off) continue;
        m.sx = this.screen.x;
        m.sy = this.screen.y;
        m.el.style.left = `${m.sx}px`;
        m.el.style.top = `${m.sy}px`;
      }
    }
    this.updateAnchoredCard();
  }

  /**
   * The hero whose dot is nearest to a point on the canvas, within `radius`
   * CSS pixels — or null. `x`/`y` are relative to the canvas's top-left, the
   * space worldToScreen() projects into (the engine divides by the device's
   * clientRect), which is also the space the markers are positioned in.
   *
   * WHY A DISTANCE TEST AND NOT THE ELEMENT'S OWN HIT BOX. The dot is 22 CSS px:
   * on a 403px-wide phone that is about 3.6 mm, against the ~7 mm a thumb
   * actually lands within. So most taps aimed at a dot landed beside it, on the
   * canvas, and became a zero-length drag that did nothing — "the points don't
   * respond". Growing the element's box would fix the miss but create a worse
   * bug: in a close-up the OTHER dots are still on screen, and a drag that
   * starts on any of their enlarged boxes would be eaten instead of orbiting.
   * Resolving on the canvas keeps every gesture where it is — a drag from a dot
   * still orbits — and only a TAP, which is not a drag, asks "which dot?".
   *
   * Nearest wins so two dots inside one radius (the LA-3A under the Neve, say)
   * still pick deterministically. Respects both visibility gates and skips the
   * hero already in close-up, exactly as the marker's own click did.
   */
  hitTest(x: number, y: number, radius: number): HeroPoint | null {
    if (!this.shown) return null;
    let best: HeroPoint | null = null;
    let bestD = radius * radius;
    for (const m of this.markers) {
      if (!m.onScreen) continue;
      const d = (m.sx - x) ** 2 + (m.sy - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = m.hero;
      }
    }
    return best;
  }

  /** Keep the anchored card pinned beside its 3D point, clamped on-screen. */
  private updateAnchoredCard(): void {
    const card = this.cardEl;
    if (!card || !this.activeAnchor || !this.cam.camera) return;
    this.cam.camera.worldToScreen(this.activeAnchor, this.screen);
    if (this.screen.z <= 0) {
      card.style.visibility = 'hidden'; // point is behind the camera
      return;
    }
    card.style.visibility = 'visible';
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const margin = 8;
    // Rest BENEATH the dot, horizontally centered on it; clamp so the card
    // never leaves the viewer window (the layer overlays the canvas exactly).
    const boundsW = this.layer.clientWidth || window.innerWidth;
    const boundsH = this.layer.clientHeight || window.innerHeight;
    let x = this.screen.x - w / 2;
    let y = this.screen.y + 22; // clear the dot; the tail points back up at it
    x = Math.min(Math.max(x, margin), boundsW - w - margin);
    y = Math.min(Math.max(y, margin), boundsH - h - margin);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  private clear(): void {
    for (const m of this.markers) m.el.remove();
    this.markers = [];
  }
}
