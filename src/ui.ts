/* ============================================================================
   ui.ts — all the HTML overlay wiring: demo rail, info drawer, hero menu,
   loading veil, and the disclaimer modal.
   ----------------------------------------------------------------------------
   This module owns the DOM. It knows nothing about rendering — it just calls
   back into main.ts when the visitor picks a demo, taps a hero point, or exits
   a close-up. Keeping UI and rendering separate is what lets you restyle the
   whole thing without touching a line of PlayCanvas code.
   ========================================================================== */

import type { Demo, HeroPoint } from './demos';
import { DISCLAIMER_HTML } from './disclaimer';

interface UICallbacks {
  onSelectDemo: (index: number) => void;
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
  private railItems: HTMLButtonElement[] = [];
  private railToggle!: HTMLButtonElement;
  private cardTimer?: number;
  private anchoredTimer?: number;

  constructor(demos: Demo[], cb: UICallbacks) {
    this.demos = demos;
    this.cb = cb;
    this.buildRail();
    this.wireDrawer();
    this.wireDisclaimer();
    this.wireHeroCard();
  }

  // ---- Rail (top-right dropdown) ------------------------------------------
  private buildRail(): void {
    const rail = $('rail');

    // The always-visible pill: shows the current demo, toggles the menu.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'rail-toggle';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `<span class="rail-toggle-label">Explore</span><span class="rail-caret" aria-hidden="true"></span>`;

    // The dropdown menu holding the three demos.
    const menu = document.createElement('div');
    menu.className = 'rail-menu';

    this.demos.forEach((demo, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-item';
      btn.innerHTML = `
        <div class="rail-index">${String(i + 1).padStart(2, '0')} · ${demo.scale}</div>
        <div class="rail-title">${demo.title}</div>
      `;
      btn.addEventListener('click', () => {
        this.cb.onSelectDemo(i);
        this.closeRail();
      });
      menu.appendChild(btn);
      this.railItems.push(btn);
    });

    rail.appendChild(toggle);
    rail.appendChild(menu);
    this.railToggle = toggle;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rail.classList.contains('open')) this.closeRail();
      else this.openRail();
    });
    // Click anywhere else (or Escape) closes the menu.
    document.addEventListener('click', (e) => {
      if (rail.classList.contains('open') && !rail.contains(e.target as Node)) this.closeRail();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeRail();
    });
  }

  private openRail(): void {
    $('rail').classList.add('open');
    this.railToggle.setAttribute('aria-expanded', 'true');
  }

  private closeRail(): void {
    $('rail').classList.remove('open');
    this.railToggle.setAttribute('aria-expanded', 'false');
  }

  // ---- Drawer (per-demo context + hero menu) -----------------------------
  // The arrow tab slides the leaf horizontally off the left edge.
  private wireDrawer(): void {
    const drawer = $('drawer');
    const toggle = $('drawer-toggle');
    toggle.addEventListener('click', () => {
      const collapsed = drawer.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? 'Show panel' : 'Hide panel');
    });
  }

  setActiveDemo(index: number): void {
    this.railItems.forEach((b, i) => b.classList.toggle('active', i === index));
    const demo = this.demos[index];
    const drawer = $('drawer-content');

    // Reflect the current demo in the dropdown pill.
    const label = this.railToggle.querySelector<HTMLElement>('.rail-toggle-label');
    if (label) {
      label.innerHTML = `<span class="rail-toggle-index">${String(index + 1).padStart(2, '0')}</span>${demo.title}`;
    }

    const heroMenu =
      demo.heroPoints.length > 0
        ? `<div class="hero-menu-label">Hero points</div>
           <div class="hero-menu">
             ${demo.heroPoints
               .map(
                 (h) =>
                   `<button type="button" class="hero-chip" data-hero="${h.id}">${h.label}</button>`,
               )
               .join('')}
           </div>`
        : '';

    drawer.innerHTML = `
      <span class="drawer-scale">${demo.scale}</span>
      <h1 class="drawer-title">${demo.title}</h1>
      <p class="drawer-desc">${demo.blurb}</p>
      ${heroMenu}
    `;

    // Wire hero chips → open the description card (and fly in).
    drawer.querySelectorAll<HTMLButtonElement>('.hero-chip').forEach((chip) => {
      const id = chip.dataset.hero;
      const hero = demo.heroPoints.find((h) => h.id === id);
      if (hero) chip.addEventListener('click', () => this.cb.onSelectHero(hero));
    });
  }

  // ---- Loading veil (fades in/out for a soft cross-fade) -----------------
  private loadingTimer?: number;
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

  // ---- Unsupported overlay ----------------------------------------------
  showUnsupported(): void {
    $('unsupported').classList.remove('hidden');
  }

  // ---- Hero-point description card ---------------------------------------
  private wireHeroCard(): void {
    // Closing either card returns the camera home (main.exitCloseup).
    $('hero-card-close').addEventListener('click', () => this.cb.onExitCloseup());
    $('hero-card-anchored-close').addEventListener('click', () => this.cb.onExitCloseup());
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const anyOpen =
        !$('hero-card').classList.contains('hidden') ||
        !$('hero-card-anchored').classList.contains('hidden');
      if (anyOpen) this.cb.onExitCloseup();
    });
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

  showHeroCard(hero: HeroPoint, placement: 'left' | 'bottom' = 'left'): void {
    const card = $('hero-card');
    if (this.cardTimer) window.clearTimeout(this.cardTimer);
    $('hero-card-body').innerHTML = this.buildCardHTML(hero);
    card.classList.toggle('bottom', placement === 'bottom'); // left panel vs bottom bar
    $('drawer').classList.add('hidden'); // gear detail replaces demo context while open
    card.classList.remove('hidden');
    requestAnimationFrame(() => card.classList.add('open')); // trigger slide-in
  }

  hideHeroCard(): void {
    const card = $('hero-card');
    card.classList.remove('open');
    $('drawer').classList.remove('hidden');
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

  // ---- Disclaimer modal --------------------------------------------------
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
