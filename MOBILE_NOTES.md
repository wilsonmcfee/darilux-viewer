# MOBILE_NOTES.md

Findings from the mobile viewer pass, 2026-08-22. Companion to `TEMPLATE.md`,
which is where the *durable* documentation for all of this lives — the touch
controls, the portrait layout, the tuning knobs and the performance baseline are
written up there, in the sections a person wiring a new scan would actually read.
This file is the record of what changed, why, and what is left.

**Status:** shipped and tested on a real phone. Four revisions came back from that
test and are all in. Typecheck and production build clean; both pages emit.

> **The lag pass happened, 2026-08-23. Read `TEMPLATE.md` → "Performance", not
> this file** — it is now measurement rather than arithmetic, and it carries the
> `?stats` / `?gl` / `?res` instrument, the dead-end list, and what is still
> open. Headline: the 2.37x fill regression §1 below records is not just undone,
> it is 4.0x BETTER than what preceded it (1,218,000 → 304,500 device px), phones
> load a 1.2M-splat bundle instead of 2.53M, and the depth sort went 20 ms → 8 ms.
> §7's first open item (the 80° fov ceiling) is untouched and still wants a real
> device; its "Lag" item is closed.

> **AND THAT PASS OVERSHOT — 2026-08-25. See `PHONE_DOCK_NOTES.md`.** The build
> the banner above describes came back from the phone as "resolution dropped
> much too drastically, lost the photoreal characteristics; culling much too
> aggressive". It had: five simultaneous quality cuts, against a benchmark
> (SuperSplat's own viewer, same `.sog`, same phone) that makes none of them.
> **The 304,500 device-pixel figure is not the win it reads as** — it is half
> SuperSplat's linear resolution on any DPR-3 phone, because SuperSplat's 0.5
> multiplies a ratio already capped at 1080px, not 1.0. Phones are back on the
> full 2.53M asset, the preset is quality-forward again, on-demand rendering has
> landed (the fix for the frame rate decaying over minutes), and there is a
> third page — `bluedio-phone.html` — where the scene is a 4:3 window with the
> controls docked underneath. **§7's 80° fov ceiling stops being a question on
> that page:** a 4:3 window never reaches the ceiling, so the authored 68.6°
> horizontal framing is shown intact rather than cropped to 42.4°.

**Both later passes are done.** Read `TEMPLATE.md` → "Performance — where the
frame time goes" first for anything performance-related, and
`PHONE_DOCK_NOTES.md` for the current state of the phone layout. Do not start
from this file.

---

## 1. What was asked for, and what shipped

Will's brief was four items: a vertical viewer, hero cards centred in the bottom
third with arrows either side, twin ghost joysticks for free roam, and touch
navigation copy behind the **i**. All four are in.

| Item | Shipped as |
|---|---|
| Vertical viewer | `.ratio-*` -> 9:16 under `(max-width: 820px) and (max-aspect-ratio: 1/1)`. Frame height on a 375px phone: **248px -> 588px (2.37x)** |
| Hero card centred | 275px wide, exactly centred, top at 72% of frame; arrows 36px, genuinely outside the card, 7px inside the frame edge |
| Joysticks | New `src/joystick.ts`. Left walks, right looks, both analog, opacity 0.55 at rest |
| Touch nav copy | New optional `guideTouch` field per demo in `demos.ts` |

## 2. The two things that were actually broken, not just missing

Worth separating from the feature work, because both were live defects rather
than absent features, and both are the kind that recur.

**The hero card hugging the left edge was a CSS specificity bug.**
`#hero-card.bottom[data-demo="bluedio"]` scores one id + one class + one
attribute; the mobile override was `#hero-card.bottom`, one id + one class. **A
media query contributes nothing to specificity**, so the desktop rule won on
phones too, and `width: min(620px, 100% - 180px)` resolved to **195px** on a
375px stage — with `left: 10px` also applying and `right: 10px` beaten by the
explicit width. Fixed by scoping the per-demo rules to `@media (min-width: 821px)`
rather than by escalating specificity on the mobile side, so the mobile block now
owns the card outright and a future per-demo rule cannot re-break it by being
written more specifically. **New per-demo card rules go in that block.**

**Portrait was rendering at a 112-degree vertical field of view.** `camera.ts`
compensates fov on any viewport narrower than `refAspect` to preserve the authored
*horizontal* coverage. That is correct for 16:9 -> 4:3 (Bluedio's fov 42 becomes
54, nobody notices) and pathological for portrait: holding 68.6 degrees horizontal
at aspect 0.46 costs **112 degrees vertical**. The old `maxEffectiveFov = 115`
never bound, so that fisheye was the shipped mobile behaviour. `maxEffectiveFov`
is now **80**, which binds only once a viewport is roughly square or taller, so
every landscape window is untouched.

|  | before | after |
|---|---|---|
| 16:9 desktop | v 42 / h 68.6 | unchanged |
| 4:3 | v 54 / h 68.6 | unchanged (ceiling not reached) |
| 9:16 frame | v 101 / h 68.6 | v 80 / h 50.6 |
| full-bleed 375x812 | v 112 / h 68.6 | v 80 / h 42.4 |

Horizontal coverage is what gets given up, and on a phone that is the right thing
to give up — a look stick turns your head in a fraction of a second, whereas
nothing recovers a frame that is already distorted.

## 3. Revisions from Will's phone test

1. **Tooltip removed on touch.** The "little description" was the `data-tip`
   hover chip on the **i**, not the help card (whose heading is "Moving around").
   A touch screen fires `:hover` on *tap* and leaves it stuck, so tapping the i
   printed `HOW TO MOVE AROUND` over the card the same tap had just opened.
   Suppressed with `content: none` under `(hover: none)`; desktop untouched.
2. **Pads 15% closer**, centre to centre: inset `16px -> 35px`, separation
   `251px -> 213px` (measured 15.1%). Separation is
   `frameW - 2*inset - padW`.
3. **Look rate 105 -> 75 deg/s** (28.6%, the deep end of the 25-30% asked for).
   The 105 came from matching a *drag's* throughput, which was the wrong target:
   a drag ends when the finger lifts, a stick keeps turning, so equal rates feel
   nothing alike.
4. **Hero framing lift** — see below. This one needed a correction to the
   suggested approach.

## 4. The hero framing lift, and why the sign is inverted from the request

Will asked to "translate the target ... about 25-30% higher so the object is
unobstructed". Raising the target does the **opposite**: the camera pitches up to
follow it, and the object moves *down* the frame. What is needed is to aim
slightly **below** the subject.

Implemented as a **look-at offset** in `apply()`, not as a change to the pose or
the target. That choice buys three things worth keeping:

- the camera still lands on the authored `position` **byte-for-byte** (verified)
- the orbit pivot stays *on* the object, so auto-orbit still circles the gear
  rather than a point beneath it
- `__logPose()` still reports the authored framing, so authoring is unaffected

Exact: `shift = 2 * f * distance * tan(vFov/2)` puts the pivot `f` of the **frame
height** above centre. Default `f = 0.27`; measured, the subject moves from 50%
to **23.0%** of the frame. Eased over 0.35s in both directions via one
exponential — applied instantly it jolts at the start of every fly-in, and easing
both ways means an interrupted fly-in cannot strand it. Mobile card layout only;
desktop gets 0 and was verified to still project the subject to dead centre.

Card heights across Bluedio's ten heroes, since the lift has to clear the worst:

| Card | Height | Top edge |
|---|---|---|
| DJ Sandman Theory | 269px | 59.7% |
| Ursa Major / Shelford | 249px | 62.2% |
| Jupiter-6 / Access Virus | 230px | 64.5% |
| Juno-6 | 211px | 66.9% |
| Space Echo / LA-3A / Pioneer | 191px | 69.3% |
| Dub Station | 172px | 71.7% |

None reach the 46% `max-height` cap, so nothing scrolls. Worst case leaves ~37%
of the frame clear.

**Known trade-off, not yet judged:** the lift is a fixed fraction, so it is tuned
for the tall cards and slightly over-lifts the short ones (172px vs 269px is a
wide spread). If 27% reads too high on the short cards, the other lever is
trimming the card's `max-height` and using a smaller lift — try `?lift=0.18`.

## 5. Decisions taken

- **Joysticks replace tap-to-walk**, overruling `WALK_IMPLEMENTATION_BRIEF` §7
  (annotated there). Tap-to-walk can only express "go to that floor point": it
  cannot look and move at once, ease off, sidestep, or stop halfway. §8's own
  check 2 already asks the reviewer to "slide along a wall at full stick".
- **The i and the points toggle stay bottom-left.** Will named the i by its
  position, so the pads sit *above* the controls row (`bottom: 74px`) rather than
  the row moving out of the thumb's way.
- **Pads hide for the whole of a hero close-up** — a close-up is a modal reading
  state and the camera is on rails.
- **Landscape phones keep 4:3**; only portrait goes vertical.
- **Analog magnitude is preserved by clamping, not normalising** — with one
  exception. `handleWalk`'s basis is orthonormal so `|wish| == hypot(strafe,
  advance)` and a clamp is exactly equivalent to the old normalise for every key
  combination. The free fly's is **not**: `worldUp` is not perpendicular to a
  pitched `forward`, so clamping would have quietly slowed W+E to 77% while
  looking down. It scales a normalised direction by `min(1, hypot(axes))` instead.

## 6. Fixed in passing

Both pre-existing, both the same class of bug, both found while measuring:

- The 4:3 mobile frame **had always overflowed a landscape phone** — 467px tall
  in a 375px viewport — and since the page freezes on entry, the visitor was
  stuck viewing the middle band with no way to scroll. Now capped.
- `.ratio-tall` (synths) was worse: **1008px tall** on the same phone.

## 7. Open items

- **The 80-degree fov ceiling is a judgement, not a derivation.** It is the one
  number in this pass that wants a second opinion on a real device. `?fov=70` /
  `?fov=95` to A/B; `?fov=115` reproduces what shipped before.
- **The hero lift fraction** has the fixed-vs-variable trade-off in §4 above.
- **Lag.** The next session. `TEMPLATE.md` → "Performance".
- **Not touched, and not needed by this pass:** the reel page's mobile window is
  still an embedded frame rather than going full-bleed on a phone. It would give
  another ~40% of frame area, but it is a layout decision nobody has asked for,
  and it would make the fill-cost problem in §7 above worse rather than better.
- `README.md`'s opening still describes three demos and no walk mode. Stale
  before this pass, deliberately left — `TEMPLATE.md` is the authority and now
  says so explicitly at the top of the README's file table.

## Files

Touched: `src/camera.ts`, `src/main.ts`, `src/style.css`, `src/stage.ts`,
`src/ui.ts`, `src/demos.ts`, `TEMPLATE.md`, `README.md`, `RESTYLE_HANDOFF.md`,
`../Bluedio Experience/WALK_IMPLEMENTATION_BRIEF.md`.
New: `src/joystick.ts`, this file.
