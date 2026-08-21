/* ============================================================================
   ui.ts — page wiring for the editorial layout: viewer windows ("bespoke
   frames"), their posters and Enter buttons, the loading veil, hero-point
   description cards, the synth collection list, and the disclaimer modal.
   ----------------------------------------------------------------------------
   This module owns the DOM. It knows nothing about rendering — it calls back
   into main.ts when the visitor enters a window, taps a hero point, or exits
   a close-up. The viewer itself (canvas + overlays) lives in one shared
   #stage element that main.ts moves into whichever window is live.
   ========================================================================== */

import type { Demo, HeroPoint } from './demos';
import { DISCLAIMER_HTML } from './disclaimer';

interface UICallbacks {
  /** Visitor clicked "Enter" on a window. */
  onEnterViewer: (demoId: string) => void;
  /** Visitor clicked the × on the live stage — return to the poster. */
  onExitViewer: () => void;
  onSelectHero: (hero: HeroPoint) => void;
  onExitCloseup: () => void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
};

export class UI {
  private demos: Demo[];
  private cb: UICallbacks;
  private windows = new Map<string, HTMLElement>(); // demoId → .viewer-window
  private cardHero: HeroPoint | null = null; // hero the open #hero-card describes
  private cardTimer?: number;
  private anchoredTimer?: number;
  private loadingTimer?: number;

  constructor(demos: Demo[], cb: UICallbacks) {
    this.demos = demos;
    this.cb = cb;
    this.wireWindows();
    this.wireStageExit();
    this.wireDisclaimer();
    this.wireHeroCard();
    this.renderSynthList();
  }

  // ---- Viewer windows (the bespoke frames) ---------------------------------
  private wireWindows(): void {
    document.querySelectorAll<HTMLElement>('.viewer-window[data-demo]').forEach((win) => {
      const id = win.dataset.demo!;
      this.windows.set(id, win);
      win.querySelector<HTMLButtonElement>('.enter')?.addEventListener('click', () => {
        this.cb.onEnterViewer(id);
      });
    });
  }

  /** The window element for a demo id (main.ts parents the stage into it). */
  windowFor(demoId: string): HTMLElement {
    const win = this.windows.get(demoId);
    if (!win) throw new Error(`No .viewer-window[data-demo="${demoId}"] in index.html`);
    return win;
  }

  /** Mark one window live (poster hides via CSS); all others revert to posters. */
  setLive(demoId: string | null): void {
    this.windows.forEach((win, id) => win.classList.toggle('live', id === demoId));
  }

  private wireStageExit(): void {
    $('stage-exit').addEventListener('click', () => this.cb.onExitViewer());
  }

  // ---- Synth collection list (rendered from demos.ts, the single source
  //      of truth — the list always matches the scene's hero points) --------
  private renderSynthList(): void {
    const list = document.getElementById('synth-list');
    const demo = this.demos.find((d) => d.id === 'synths');
    if (!list || !demo) return;

    list.innerHTML = demo.heroPoints
      .map((h) => {
        const year = h.specs?.find((s) => s.label === 'Released')?.value;
        const tone = h.specs?.find((s) => s.label === 'Sound')?.value;
        const meta = [year, tone].filter(Boolean).join(' · ');
        return `<li data-hero="${h.id}">
          <span class="s-name">${h.label}</span>
          ${meta ? `<span class="s-meta">${meta}</span>` : ''}
        </li>`;
      })
      .join('');

    // Clicking a synth in the list enters the viewer (if needed) and flies to it.
    list.querySelectorAll<HTMLElement>('li[data-hero]').forEach((li) => {
      const hero = demo.heroPoints.find((h) => h.id === li.dataset.hero);
      if (hero) li.addEventListener('click', () => this.cb.onSelectHero(hero));
    });
  }

  // ---- Loading veil (fades in/out for a soft cross-fade) -------------------
  showLoading(label = 'Loading…'): void {
    const el = $('loading');
    if (this.loadingTimer) window.clearTimeout(this.loadingTimer);
    $('loading-label').textContent = label;
    el.classList.remove('hidden');
    el.style.display = 'flex';
    el.style.opacity = '1';
  }
  hideLoading(): void {
    const el = $('loading');
    el.style.opacity = '0';
    this.loadingTimer = window.setTimeout(() => {
      el.style.display = 'none';
    }, 450);
  }

  // ---- Unsupported overlay --------------------------------------------------
  showUnsupported(): void {
    $('unsupported').classList.remove('hidden');
  }

  // ---- Hero-point description card ------------------------------------------
  private wireHeroCard(): void {
    // Closing either card returns the camera home (main.exitCloseup).
    $('hero-card-close').addEventListener('click', () => this.cb.onExitCloseup());
    $('hero-card-anchored-close').addEventListener('click', () => this.cb.onExitCloseup());

    // Stepper: fly straight to the neighbouring hero, card still open.
    $('hero-card-prev').addEventListener('click', () => this.stepHero(-1));
    $('hero-card-next').addEventListener('click', () => this.stepHero(1));

    window.addEventListener('keydown', (e) => {
      const cardOpen = !$('hero-card').classList.contains('hidden');
      if (cardOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Camera fly keys are WASD/QE, so the arrows are free for the stepper.
        e.preventDefault();
        this.stepHero(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (e.key !== 'Escape') return;
      const anyOpen = cardOpen || !$('hero-card-anchored').classList.contains('hidden');
      if (anyOpen) this.cb.onExitCloseup();
    });
  }

  /**
   * Move `delta` places through the OWNING demo's heroPoints array and fly there.
   * Array order is authoring order — the order the points appear in demos.ts —
   * which is deliberate, so the stepper reads as a slideshow. Wraps at both ends.
   */
  private stepHero(delta: number): void {
    if (!this.cardHero) return;
    const owner = this.demos.find((d) => d.heroPoints.includes(this.cardHero!));
    if (!owner || owner.heroPoints.length < 2) return;
    const i = owner.heroPoints.indexOf(this.cardHero);
    const n = owner.heroPoints.length;
    const next = owner.heroPoints[(i + delta + n) % n];
    this.cb.onSelectHero(next);
  }

  // Anchored variant: pinned to the 3D point (positioned by HeroPointManager).
  showAnchoredCard(hero: HeroPoint): void {
    const card = $('hero-card-anchored');
    if (this.anchoredTimer) window.clearTimeout(this.anchoredTimer);
    $('hero-card-anchored-body').innerHTML = this.buildCardHTML(hero);
    card.style.visibility = 'visible';
    card.classList.remove('hidden');
    requestAnimationFrame(() => card.classList.add('show'));
  }

  hideAnchoredCard(): void {
    const card = $('hero-card-anchored');
    card.classList.remove('show');
    this.anchoredTimer = window.setTimeout(() => card.classList.add('hidden'), 320);
  }

  showHeroCard(hero: HeroPoint, placement: 'left' | 'bottom' = 'left', demoId = ''): void {
    const card = $('hero-card');
    if (this.cardTimer) window.clearTimeout(this.cardTimer);
    this.cardHero = hero;
    // Only offer the stepper when there is somewhere to step to.
    const owner = this.demos.find((d) => d.heroPoints.includes(hero));
    const steppable = (owner?.heroPoints.length ?? 0) > 1;
    card.classList.toggle('has-nav', steppable);
    $('hero-card-prev').classList.toggle('hidden', !steppable);
    $('hero-card-next').classList.toggle('hidden', !steppable);
    $('hero-card-body').innerHTML = this.buildCardHTML(hero);
    card.classList.toggle('bottom', placement === 'bottom'); // left panel vs bottom bar
    card.dataset.demo = demoId; // lets CSS size the card per demo
    card.classList.remove('hidden');
    requestAnimationFrame(() => card.classList.add('open')); // trigger slide-in
  }

  hideHeroCard(): void {
    const card = $('hero-card');
    this.cardHero = null;
    card.classList.remove('open');
    this.cardTimer = window.setTimeout(() => card.classList.add('hidden'), 400);
  }

  // Minimal inline glyphs for hero.icon (currentColor so they inherit the accent).
  private static ICONS: Record<string, string> = {
    speaker:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="15" r="3.2"/><circle cx="12" cy="6.5" r="1"/></svg>',
  };

  private buildCardHTML(hero: HeroPoint): string {
    const iconSvg = hero.icon ? UI.ICONS[hero.icon] : undefined;
    const icon = iconSvg ? `<span class="hero-card-icon">${iconSvg}</span>` : '';
    const sub = hero.subtitle ? `<div class="hero-card-sub">${hero.subtitle}</div>` : '';
    const desc = hero.description
      ? `<p class="hero-card-desc">${hero.description}</p>`
      : `<p class="hero-card-desc hero-card-placeholder">Description coming soon.</p>`;
    const specs = hero.specs?.length
      ? `<dl class="hero-card-specs">${hero.specs
          .map((s) => `<div><dt>${s.label}</dt><dd>${s.value}</dd></div>`)
          .join('')}</dl>`
      : '';
    return `<h2 class="hero-card-title">${icon}${hero.label}</h2>${sub}${desc}${specs}`;
  }

  // ---- Disclaimer modal ------------------------------------------------------
  private wireDisclaimer(): void {
    $('disclaimer-body').innerHTML = DISCLAIMER_HTML;
    const modal = $('disclaimer');
    const open = () => modal.classList.remove('hidden');
    const close = () => modal.classList.add('hidden');
    $('disclaimer-open').addEventListener('click', open);
    $('disclaimer-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
  }
}
