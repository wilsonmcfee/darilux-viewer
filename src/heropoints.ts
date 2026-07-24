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
   ========================================================================== */

import { Entity, Vec3 } from 'playcanvas';
import type { Demo, HeroPoint } from './demos';

interface Marker {
  hero: HeroPoint;
  el: HTMLElement;
  anchor: Vec3;
}

export class HeroPointManager {
  private cam: Entity;
  private layer: HTMLElement;
  private markers: Marker[] = [];
  private screen = new Vec3();
  private visible = true;

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
      this.markers.push({ hero, el, anchor: new Vec3(a[0], a[1], a[2]) });
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    for (const m of this.markers) m.el.style.display = v ? '' : 'none';
  }

  /** Reposition every marker; called each frame after the camera updates. */
  update(): void {
    if (!this.cam.camera) return;
    if (this.visible) {
      for (const m of this.markers) {
        this.cam.camera.worldToScreen(m.anchor, this.screen);
        // z <= 0 means the point is behind the camera — hide it.
        if (this.screen.z <= 0) {
          m.el.style.opacity = '0';
          m.el.style.pointerEvents = 'none';
          continue;
        }
        m.el.style.opacity = '1';
        m.el.style.pointerEvents = 'auto';
        m.el.style.left = `${this.screen.x}px`;
        m.el.style.top = `${this.screen.y}px`;
      }
    }
    this.updateAnchoredCard();
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
