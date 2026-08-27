/* ============================================================================
   joystick.ts — the two on-screen thumb sticks the mobile viewer walks on.
   ----------------------------------------------------------------------------
   WHY STICKS AT ALL
   WALK_IMPLEMENTATION_BRIEF §7 calls for tap-to-walk as the primary touch
   affordance. That is superseded here, and for a concrete reason rather than a
   preference: tap-to-walk can only ever deliver "go to this floor point", so it
   cannot look and move at once, cannot ease off, and cannot sidestep — it is a
   waypoint, not a body. §8's own verification list already asks the reviewer to
   "slide along a wall at full stick", which is a thing only a stick can do. Two
   sticks is what the room actually wants, and it is what every player of a phone
   game already knows how to hold.

   WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT
   It owns the widget and the gesture: where the ring is, where the knob sits, the
   dead zone, and turning a finger position into a vector on the unit disc. It
   knows NOTHING about the camera, walking or the scene — it just reports a
   screen-space vector (x right, y down), which is the same quantity a drag
   produces. camera.ts decides what that means. That split is what lets the look
   stick reuse the drag path wholesale, inheriting the hero yaw arcs, the walk
   region and the eye-plane pin instead of reimplementing any of them.

   AXIS CONVENTION — worth stating once, because it is the thing a reader will
   otherwise have to re-derive: y is DOWN, like every other screen coordinate in
   this project. So pushing a stick away from you is NEGATIVE y. The left stick's
   caller negates it to get "forward"; the look stick's caller passes it through
   unchanged, because a drag downward already means "look down".
   ========================================================================== */

/** A screen-space stick reading, clamped to the unit disc. (0,0) is at rest. */
export interface StickVector {
  x: number;
  y: number;
}

export interface JoystickOptions {
  /** Which corner, and which modifier class the CSS keys off. */
  side: 'left' | 'right';
  /** Screen-reader / debugging name. The pads themselves are aria-hidden. */
  label: string;
  /**
   * Fraction of the ring radius ignored around centre, rescaled so output stays
   * continuous from zero. 0.1 is enough to stop a resting thumb from drifting
   * the camera without the first tenth of the travel feeling dead.
   */
  deadzone?: number;
  /** Called on every change, and once with (0,0) on release. */
  onChange: (v: StickVector) => void;
}

/** How far the knob travels, as a fraction of the ring radius. Keeps a 34 px
    knob inside a 96 px ring with a hair of margin: (96-34)/2 / 48 = 0.65. */
const KNOB_TRAVEL = 0.6;

export class Joystick {
  readonly el: HTMLElement;
  private knob: HTMLElement;
  private opts: JoystickOptions;
  private deadzone: number;

  private pointerId: number | null = null;
  private cx = 0; // ring centre, viewport coords, captured on pointerdown
  private cy = 0;
  private radius = 1;
  private out: StickVector = { x: 0, y: 0 };

  constructor(host: HTMLElement, opts: JoystickOptions) {
    this.opts = opts;
    this.deadzone = opts.deadzone ?? 0.1;

    this.el = document.createElement('div');
    this.el.className = `stick stick-${opts.side}`;
    this.el.dataset.label = opts.label;
    this.knob = document.createElement('span');
    this.knob.className = 'stick-knob';
    this.el.appendChild(this.knob);
    host.appendChild(this.el);

    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
    // A capture lost to anything other than our own release (the element being
    // hidden mid-push, the browser reclaiming the pointer) has to spring the
    // stick back too, or the last vector stays installed and the visitor keeps
    // walking with no finger down.
    this.el.addEventListener('lostpointercapture', this.onUp);
  }

  /** Current reading. Live object — do not retain. */
  get value(): StickVector {
    return this.out;
  }

  /**
   * Spring to centre and report it. Safe to call at any time, including with a
   * finger still down: the pointerId is dropped, so the in-flight gesture stops
   * steering until the finger lifts and presses again.
   */
  reset(): void {
    this.pointerId = null;
    this.el.classList.remove('active');
    this.knob.style.transform = '';
    if (this.out.x !== 0 || this.out.y !== 0) {
      this.out = { x: 0, y: 0 };
      this.opts.onChange(this.out);
    }
  }

  /** Remove the pad from the DOM and release its listeners. */
  destroy(): void {
    this.reset();
    this.el.remove();
  }

  private onDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return; // one finger per pad
    // Measured on press rather than cached: the stage is reparented between
    // viewer windows and the page can rotate, so a cached centre goes stale in
    // exactly the situations a phone produces.
    const r = this.el.getBoundingClientRect();
    this.cx = r.left + r.width / 2;
    this.cy = r.top + r.height / 2;
    this.radius = Math.max(r.width, r.height) / 2 || 1;

    this.pointerId = e.pointerId;
    this.el.setPointerCapture?.(e.pointerId);
    this.el.classList.add('active');
    this.track(e);
    // The page is frozen while a scene is live, so this is not about scrolling:
    // it suppresses the long-press callout and the synthetic mouse events an
    // uncancelled touch would still fire at the canvas underneath.
    e.preventDefault();
    e.stopPropagation();
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.track(e);
    e.preventDefault();
    e.stopPropagation();
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.reset();
  };

  /** Finger position -> unit-disc vector, dead zone applied, knob moved. */
  private track(e: PointerEvent): void {
    let x = (e.clientX - this.cx) / this.radius;
    let y = (e.clientY - this.cy) / this.radius;

    // Clamp to the disc BEFORE the dead zone, so a finger dragged well past the
    // ring reads as full deflection in that direction rather than as an
    // ever-growing vector. This is also what lets the slop area around the ring
    // work: pressing just outside it starts at full push, not at 1.4.
    const len = Math.hypot(x, y);
    if (len > 1 && len > 0) {
      x /= len;
      y /= len;
    }

    // Rescale past the dead zone so the output still starts at 0 and reaches 1.
    // Without the rescale the stick would jump to `deadzone` the moment it woke,
    // which reads as a lurch on a control whose whole point is being analog.
    const mag = Math.min(len, 1);
    if (mag <= this.deadzone) {
      if (this.out.x !== 0 || this.out.y !== 0) {
        this.out = { x: 0, y: 0 };
        this.opts.onChange(this.out);
      }
      this.knob.style.transform = '';
      return;
    }
    const k = (mag - this.deadzone) / (1 - this.deadzone) / mag;
    this.out = { x: x * k, y: y * k };
    this.opts.onChange(this.out);

    // The knob follows the RAW clamped position, not the dead-zoned output, so
    // the graphic stays glued to the thumb. Showing the rescaled value instead
    // would make the knob lag the finger for the first tenth of the travel.
    const px = x * this.radius * KNOB_TRAVEL;
    const py = y * this.radius * KNOB_TRAVEL;
    this.knob.style.transform = `translate(-50%, -50%) translate(${px}px, ${py}px)`;
  }
}

/**
 * The pair, plus the one rule that governs whether they are on screen.
 *
 * They are a UNIT rather than two independent widgets because their visibility
 * is a single decision — free roam, or not — and because hiding them has to
 * spring both to centre in the same breath. A pad that vanished mid-push while
 * still reporting its last vector would leave the visitor walking into a wall
 * with nothing on screen to explain why.
 */
export class TouchSticks {
  private host: HTMLElement;
  readonly move: Joystick;
  readonly look: Joystick;
  private shown = false;

  constructor(
    host: HTMLElement,
    onMove: (v: StickVector) => void,
    onLook: (v: StickVector) => void,
  ) {
    this.host = host;
    this.move = new Joystick(host, { side: 'left', label: 'Walk', onChange: onMove });
    this.look = new Joystick(host, { side: 'right', label: 'Look', onChange: onLook });
    // Set the class outright rather than calling setVisible(false): `shown` is
    // already false, so setVisible would early-return and leave the class to
    // whatever the markup happened to carry. stage.ts does ship `hidden`, but
    // relying on that would make deleting one attribute a silent regression.
    this.host.classList.add('hidden');
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(on: boolean): void {
    if (this.shown === on) return;
    this.shown = on;
    // Spring BEFORE hiding: the callbacks have to land while the camera still
    // considers the sticks live, or the zeroing is lost.
    if (!on) {
      this.move.reset();
      this.look.reset();
    }
    this.host.classList.toggle('hidden', !on);
  }
}

/**
 * Should this session get touch controls?
 *
 * Two clauses, and the second is not redundant. `pointer: coarse` is the honest
 * test and catches every real phone. The width clause catches a desktop browser
 * narrowed to a phone width — which is how this layout actually gets reviewed,
 * and without it the reviewer sees the portrait frame with no sticks in it and
 * concludes they are broken. 820px is not a guess: it is the same breakpoint
 * style.css switches the mobile layout at, so the pads and the layout they are
 * designed against can never disagree.
 *
 * Re-evaluated on resize (main.ts drives it from the stage ResizeObserver)
 * rather than latched at load, because a phone rotating is a resize and a
 * laptop being dragged wider is the reviewer changing their mind.
 */
export function wantsTouchControls(): boolean {
  const forced = /(?:\?|&|#)touch=([01])/.exec(location.search + location.hash);
  if (forced) return forced[1] === '1';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse || window.innerWidth <= 820;
}
