# Restyle handoff — Morisot × JFTR demo viewer

Context for an agent restyling this page toward JFTR's brand. A separate style
guide covers the visual direction; this doc covers **how the code is wired** so
the reskin doesn't break the 3D viewer or its interactions. Read the "Don't
break these" section before touching anything.

---

## What this is (30 seconds)

A single-page app: a fullscreen PlayCanvas (WebGPU/WebGL2) Gaussian-splat viewer
with three demos (Legendary Synthesizers, Studio E, Common Room). HTML/CSS UI is
layered *over* a `<canvas>`. Stack: Vite + TypeScript + PlayCanvas engine. No
framework, no Tailwind — plain CSS in one file.

## Run & verify

```bash
npm install
npm run dev      # local dev server; open in CHROME (WebGPU). Vite hot-reloads.
npm run build    # MUST pass — runs `tsc --noEmit` then `vite build`
```

Always finish with `npm run build`; if it fails, the styling change likely
touched a class name that TypeScript builds into markup (see below).

---

## Where styling lives (safe to edit freely)

- **`src/style.css`** — 100% of the styling. Start here.
- **`:root` CSS variables** at the top of `style.css` — the fastest reskin lever.
  Colors, fonts, radius, shadows, blur, easing all flow from here. Retheming is
  mostly: change these variables + the font `<link>`.
- **`index.html` `<head>`** — the Google Fonts `<link>`. To change typefaces,
  update this link AND `--font-display` / `--font-body` in `style.css`.
- Component sizes (card widths, paddings, etc.) are inline in `style.css`.

Everything visual — palette, type, spacing, borders, glass/blur, animations,
card dimensions, the mobile layout — is fair game to change.

---

## Don't break these (CSS ↔ JavaScript couplings)

The TypeScript queries elements by **id** and builds markup with specific
**class names**. You may restyle these freely, but do **not rename** an id or
class without updating the matching `.ts` file, or the app breaks silently.

### Element IDs the code depends on (keep the ids)
`viewer`, `hero-layer`, `brand`, `rail`, `drawer`, `disclaimer-open`,
`disclaimer`, `disclaimer-close`, `disclaimer-body`, `unsupported`, `loading`,
`loading-label`, `hero-card`, `hero-card-close`, `hero-card-body`,
`hero-card-anchored`, `hero-card-anchored-close`, `hero-card-anchored-body`.
(`author-crosshair` is injected by JS only when the URL has `?author`.)

### Class names built in JS (in `src/ui.ts` and `src/heropoints.ts`)
These are written via template strings, so a rename must happen in **both** the
`.ts` and the CSS: `rail-item`, `rail-index`, `rail-title`, `active`,
`drawer-scale`, `drawer-title`, `drawer-desc`, `hero-menu-label`, `hero-menu`,
`hero-chip`, `hero-marker`, `hero-dot`, `hero-caption`, `hero-card-title`,
`hero-card-icon`, `hero-card-sub`, `hero-card-desc`, `hero-card-placeholder`,
`hero-card-specs`, `spinner`, `modal`, `modal-card`, `modal-close`.

Prefer restyling by targeting these existing classes. If you want new structure,
edit the template strings in `ui.ts` and keep them in sync.

### State classes toggled by JS (style the states, keep the names)
- `.hidden` — global `display:none !important`; JS shows/hides with it.
- `.open` — on `#hero-card`: triggers the slide-in transition.
- `.show` — on `#hero-card-anchored`: fade-in.
- `.bottom` — on `#hero-card`: the bottom-center placement variant (vs left).
- `.active` — on the current `.rail-item`.

### Animation timing is coupled to JS timeouts
When a card/veil hides, JS waits a fixed time before adding `.hidden`, matched to
the CSS transition. If you change these **CSS durations**, keep the **JS
timeouts in `ui.ts`** ≥ the CSS duration (otherwise elements vanish before they
finish fading):

| Element | CSS transition | JS timeout (`ui.ts`) |
|---|---|---|
| `#loading` | `opacity .45s` | `450ms` |
| `#hero-card` (`.open`) | `.4s` | `400ms` |
| `#hero-card-anchored` (`.show`) | `.3s` | `320ms` |

### Positioned-by-JS elements (don't fight them with CSS)
`.hero-marker` and `#hero-card-anchored` get their `left`/`top` set **every
frame** by `heropoints.ts` (they track 3D points). Style their look, but don't
set `left`/`top`/`position` in CSS in a way that conflicts. `transform` offsets
are fine (the anchored card uses `translateY(-50%)`; keep that pattern).

### The canvas background is set in code, not CSS ⚠️
The 3D canvas clear color is set in **`src/main.ts`**, not CSS:

```ts
clearColor: new Color(16 / 255, 19 / 255, 25 / 255, 1), // matches --bg #101319
```

If you change `--bg`, update this line to match, or the splat's background won't
match the UI. This is the one styling value that lives outside `style.css`.

---

## Files NOT to touch for a reskin

`camera.ts`, `device.ts`, `heropoints.ts` (logic), `demos.ts` (content/data).
The **only** non-CSS file a reskin should touch is `main.ts`, and only the
`clearColor` line above. Everything else is behavior/data.

---

## Card styles (already built — reuse, don't reinvent)

Per-demo `cardStyle` in `demos.ts` picks how a hero's description card appears:
- `'hud'` — fixed glass panel, left-center
- `'hud-bottom'` — same panel, bottom-center (synths + Studio E use this)
- `'anchored'` — small callout pinned to the 3D point, tracks the camera (Common Room)

All three share `.hero-card-*` / `#hero-card-anchored` styling, so restyling those
classes updates every variant consistently.

---

## Responsive

One breakpoint: `@media (max-width: 720px)`. It moves the rail to a bottom strip
and turns the left card into a bottom sheet. Keep a mobile pass in your reskin.

## Accessibility niceties to preserve

`aria-*` attributes and `role="dialog"` on the modals/cards, focus-visible
behavior, and sufficient text contrast over the glass panels.

---

## Quick reskin recipe

1. Edit `:root` variables in `style.css` (palette, `--font-*`, radius, shadow, blur).
2. Swap the font `<link>` in `index.html` to match `--font-*`.
3. Update `clearColor` in `main.ts` to match the new `--bg`.
4. Restyle components by their existing classes/ids (don't rename).
5. `npm run build`, then `npm run dev` in Chrome; click a hero point in each of
   the three demos and resize to mobile to confirm nothing broke.
