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

import type { Demo, DemoGuide, HeroPoint } from '../types';
import { disclaimerHtml } from './disclaimer';
import { wantsTouchControls } from '../nav/joystick';

interface UICallbacks {
  /** Visitor clicked "Enter" on a window. */
  onEnterViewer: (demoId: string) => void;
  /** Visitor clicked the × on the live stage — return to the poster. */
  onExitViewer: () => void;
  onSelectHero: (hero: HeroPoint) => void;
  onExitCloseup: () => void;
  /** The bottom-left switch: show or hide the hero-point markers. */
  onTogglePoints: (on: boolean) => void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
};

/** Guide copy is plain text authored in demos.ts, so it is escaped rather
    than injected — unlike a hero card description, which allows inline markup
    on purpose for its links. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class UI {
  private demos: Demo[];
  private cb: UICallbacks;
  private windows = new Map<string, HTMLElement>(); // demoId → .viewer-window
  private cardHero: HeroPoint | null = null; // hero the open #hero-card describes
  private cardTimer?: number;
  private anchoredTimer?: number;
  private loadingTimer?: number;
  private infoTimer?: number;
  // Both of the live demo's guides are held, and the choice between them is made
  // at RENDER time rather than at set time. A phone that rotates, or a desktop
  // window dragged across the breakpoint, changes the answer — and latching it
  // when the scene loaded would leave a visitor reading about W A S D on a
  // touch screen (or about thumb sticks on a laptop) with no way to correct it.
  private guide: DemoGuide | null = null;      // desktop / keyboard copy
  private guideTouch: DemoGuide | null = null; // touch copy, when the demo has one

  constructor(demos: Demo[], cb: UICallbacks) {
    this.demos = demos;
    this.cb = cb;
    this.wireWindows();
    this.wireStageExit();
    this.wireStageControls();
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
    this.lockPageScroll(demoId === null ? null : this.windows.get(demoId) ?? null);
    if (demoId === null) this.hideInfoCard(); // never leave help hanging over a poster
  }

  /**
   * Freeze the page while a viewer is open, and release it on exit.
   *
   * The viewer is a window embedded partway down a long editorial page, so a
   * stray wheel or trackpad flick used to slide the whole thing out from under
   * the visitor mid-scene. While a scene is live the page does not move at all;
   * the only way out is the stage's own X, which calls setLive(null).
   *
   * This is the single choke point on purpose: setLive is already called on
   * every enter path, every exit path, AND the unsupported-device bail-out, so
   * the lock cannot be left on by a route that forgot about it.
   *
   * Locking with overflow:hidden rather than position:fixed — fixed would need
   * the scroll offset saved and restored, and jumps on release. Hiding overflow
   * removes the scrollbar, which would reflow the page sideways, so its width is
   * paid back as padding. Nested scrollers are untouched: a hero card whose copy
   * overflows still scrolls on its own #hero-card-body.
   */
  private scrollLock: { overflow: string; paddingRight: string } | null = null;

  private lockPageScroll(liveWindow: HTMLElement | null): void {
    const html = document.documentElement;
    if (liveWindow) {
      if (this.scrollLock) return; // already locked; do not stack saved values
      // Bring the window fully into view BEFORE freezing, or a visitor who
      // entered from a half-scrolled position is stranded with a clipped scene
      // and no way to move the page.
      // 'instant' is load-bearing: style.css sets html { scroll-behavior: smooth },
      // so the default would ANIMATE this scroll — and the freeze on the next
      // line cancels it at its starting position, stranding the visitor exactly
      // where this is meant to rescue them from.
      const r = liveWindow.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        liveWindow.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      const gutter = window.innerWidth - html.clientWidth;
      this.scrollLock = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
      html.style.overflow = 'hidden';
      if (gutter > 0) html.style.paddingRight = `${gutter}px`;
    } else {
      if (!this.scrollLock) return;
      html.style.overflow = this.scrollLock.overflow;
      html.style.paddingRight = this.scrollLock.paddingRight;
      this.scrollLock = null;
    }
  }

  private wireStageExit(): void {
    $('stage-exit').addEventListener('click', () => this.cb.onExitViewer());
  }

  /* ---- Bottom-left stage controls ---------------------------------------- */

  private wireStageControls(): void {
    const info = $('stage-info');
    info.addEventListener('click', () => {
      if ($('info-card').classList.contains('hidden')) this.showInfoCard();
      else this.hideInfoCard();
    });
    $('info-card-close').addEventListener('click', () => this.hideInfoCard());

    // A button with role="switch": aria-checked is the single source of truth
    // for both the state and the knob position (CSS keys off the attribute), so
    // the two can never disagree.
    const toggle = $('points-toggle');
    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(on));
      this.cb.onTogglePoints(on);
    });
  }

  /**
   * Install the live demo's navigation help. Null (for both) hides the i.
   * `touch` is optional; without it a touch visitor falls back to `guide`.
   */
  setGuide(guide: DemoGuide | null, touch: DemoGuide | null = null): void {
    this.guide = guide;
    this.guideTouch = touch;
    const any = Boolean(guide ?? touch);
    $('stage-info').classList.toggle('hidden', !any);
    if (!any) this.hideInfoCard();
    else if (!$('info-card').classList.contains('hidden')) this.renderGuide();
  }

  private renderGuide(): void {
    // Touch copy wins on a touch-shaped viewport, and either falls back to the
    // other so a demo that has only one still gets its i button.
    const g = wantsTouchControls()
      ? this.guideTouch ?? this.guide
      : this.guide ?? this.guideTouch;
    if (!g) return;
    const rows = g.keys
      .map(
        (k) =>
          '<dt>' + esc(k.key) + '</dt><dd>' + esc(k.action) + '</dd>',
      )
      .join('');
    $('info-card-body').innerHTML =
      '<h3 class="info-card-title">' + esc(g.title ?? 'Moving around') + '</h3>' +
      '<dl class="info-keys">' + rows + '</dl>' +
      (g.note ? '<p class="info-note">' + esc(g.note) + '</p>' : '');
  }

  private showInfoCard(): void {
    if (!this.guide && !this.guideTouch) return;
    if (this.infoTimer) window.clearTimeout(this.infoTimer);
    this.renderGuide();
    const card = $('info-card');
    card.classList.remove('hidden');
    $('stage-info').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => card.classList.add('open'));
  }

  private hideInfoCard(): void {
    const card = $('info-card');
    if (card.classList.contains('hidden')) return;
    card.classList.remove('open');
    $('stage-info').setAttribute('aria-expanded', 'false');
    this.infoTimer = window.setTimeout(() => card.classList.add('hidden'), 300);
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
      // The help card is the shallowest thing open, so it closes first: one
      // Escape should not both dismiss it AND drop the visitor out of a close-up.
      if (!$('info-card').classList.contains('hidden')) {
        this.hideInfoCard();
        return;
      }
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
    /* The two cards are mutually exclusive, and THIS is the choke point that
       makes them so. Nothing enforced it before: showInfoCard() never hid the
       gear card and this never hid the help card. That was survivable
       full-bleed, where the two sat at opposite corners of a tall stage. The
       docked layout centres BOTH on the same point in the dock, and #info-card
       (z-index 29) paints over #hero-card (28) — so reading the help card and
       then tapping a piece of gear flew the camera to it and left the help copy
       sitting on top, hiding the gear card completely INCLUDING its close
       button. The only way out was the other card's × in the opposite corner,
       which is not something a visitor would find.

       Fixed here rather than at the call site because every route into a gear
       card goes through this method, and the reverse direction is closed
       differently: the i is not reachable during a close-up at all on the
       docked page (the dock's data-state hides the controls row), so the help
       card can no longer be raised over a gear card in the first place. */
    this.hideInfoCard();
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
    $('disclaimer-body').innerHTML = disclaimerHtml();
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
