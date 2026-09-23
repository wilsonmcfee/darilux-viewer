// First-person controls for walking a room: WASD / arrows to walk, Shift to hurry, wheel to step
// forward.
//
// Desktop look, as in SuperSplat: a click on the view locks the pointer, the cursor disappears and
// the mouse turns the head directly (right looks right) until Esc hands the cursor back. Where
// pointer lock isn't available, a drag looks instead (the world follows the pointer, as in
// Street View or Matterport).
//
// Touch: a fixed, translucent thumb-stick in the bottom-left corner walks; a drag anywhere else
// (the right thumb) turns the head, scaled to the field of view so the scene stays under the
// finger. Both enter the same movement path as the keyboard, so the walk region, the eye-height
// lock and the easing apply to every input identically.
//
// Walk mode (a studio with a `walk` block): the eye is pinned at a fixed height above the floor,
// Q / E do nothing, and movement is kept inside the walkable region by walk-region.js. Without a
// walk block the old behaviour stands: free height with Q / E, clamped to `bounds` if given.

import { WalkRegion } from './walk-region.js';

const DEG = Math.PI / 180;
const WALK_SPEED = 1.25;        // m/s, an unhurried indoor walk
const FAST_MULTIPLIER = 2;      // Shift: brisk, not a sprint
const LOOK_MOUSE = 0.18;        // degrees per pixel, drag fallback
const LOCK_DAMPING = 0.95;      // SuperSplat's rotate damping: each ms keeps 95% of the turn still to come
const LOCK_SPIKE = 300;         // px; some drivers report one wild delta as the lock engages
const POINTER_LOCK = typeof Element !== 'undefined' && 'requestPointerLock' in Element.prototype;
const STICK_DEADZONE = 0.1;     // fraction of the ring ignored at rest, rescaled so output stays continuous
const STICK_SLOP = 1.6;         // a press within this many ring radii grabs the stick
const KNOB_TRAVEL = 0.6;        // knob travel as a fraction of the ring radius
const PITCH_LIMIT = 85;

const KEYMAP = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    KeyE: 'up', PageUp: 'up',
    KeyQ: 'down', PageDown: 'down',
    ShiftLeft: 'fast', ShiftRight: 'fast'
};

export class WalkControls {
    enabled = false;
    position = [0, 0, 0];
    yaw = 0;                    // degrees about +Y; 0 faces -Z
    pitch = 0;                  // degrees; positive looks up
    bounds = null;
    walk = null;                // resolved walk config, or null for free height
    region = null;              // WalkRegion, or null for unbounded
    free = false;               // ?author: ignore the walk lock so poses can be flown to
    touchDegPerPx = 0.28;       // set by the viewer from the live fov and window height
    mouseDegPerPx = 0.1125;     // locked mouse look; set by the viewer from the live fov
    lockable = POINTER_LOCK;    // off in the full-screen touch layout

    _turn = [0, 0];             // yaw / pitch still to apply from locked mouse movement
    _velocity = [0, 0, 0];
    _wheel = 0;
    _keys = new Set();
    _look = null;               // { id, x, y, touch }
    _stick = null;              // { id, cx, cy, r, dx, dy }
    _home = null;
    _move = { x: 0, z: 0 };

    constructor(surface, { stick } = {}) {
        this.surface = surface;
        this.stickEl = stick;
        this.knobEl = stick?.querySelector('.stick-knob');
        const block = (e) => { if (this.enabled) e.preventDefault(); };
        this._listeners = [
            [surface, 'pointerdown', this._onPointerDown, { passive: false }],
            [surface, 'pointermove', this._onPointerMove, { passive: false }],
            [surface, 'mousemove', this._onLockedMove],
            [document, 'pointerlockchange', this._onLockChange],
            [surface, 'pointerup', this._onPointerUp],
            [surface, 'pointercancel', this._onPointerUp],
            [surface, 'lostpointercapture', this._onPointerUp],
            [surface, 'wheel', this._onWheel, { passive: false }],
            [surface, 'keydown', this._onKeyDown],
            [surface, 'keyup', this._onKeyUp],
            [surface, 'blur', this._release],
            // iOS Safari claims pinches and some drags through its own channels even under
            // touch-action: none; refusing them on the surface keeps the gestures ours
            [surface, 'touchmove', block, { passive: false }],
            [surface, 'gesturestart', block],
            [surface, 'gesturechange', block]
        ];
        for (const [target, type, fn, opts] of this._listeners) target.addEventListener(type, fn, opts);
    }

    destroy() {
        for (const [target, type, fn, opts] of this._listeners) target.removeEventListener(type, fn, opts);
    }

    setEnabled(on) {
        this.enabled = on;
        if (!on) this._release();
    }

    get locked() {
        return document.pointerLockElement === this.surface;
    }

    // must run inside a user gesture (a click); a refusal arrives as 'pointerlockerror'
    requestLock() {
        if (!this.lockable || this.locked) return;
        try {
            this.surface.requestPointerLock()?.catch?.(() => {});
        } catch {
            // older engines throw instead of rejecting; the drag fallback still works
        }
    }

    releaseLock() {
        if (this.locked) document.exitPointerLock();
    }

    setLockable(on) {
        this.lockable = on && POINTER_LOCK;
        if (!this.lockable) this.releaseLock();
    }

    // start = { position, target } in world units; walk = the studio's walk block or null
    setPose(start, bounds = null, walk = null) {
        const [px, py, pz] = start.position;
        const [tx, ty, tz] = start.target;
        const dx = tx - px, dy = ty - py, dz = tz - pz;
        this._home = {
            position: [px, py, pz],
            yaw: Math.atan2(-dx, -dz) / DEG,
            pitch: Math.atan2(dy, Math.hypot(dx, dz)) / DEG
        };
        this.bounds = bounds;
        this.walk = walk ? {
            speed: WALK_SPEED,
            runMultiplier: FAST_MULTIPLIER,
            unitsPerMetre: 1,
            ...walk
        } : null;
        this.region = walk?.region ? new WalkRegion(walk.region, this.walk.unitsPerMetre) : null;
        this.reset();
    }

    // true while the eye is height-locked and region-bound
    get walking() {
        return !!this.walk && !this.free;
    }

    get eyeY() {
        return this.walk.floorY + this.walk.eyeHeight * this.walk.unitsPerMetre;
    }

    reset() {
        if (!this._home) return;
        this.position = [...this._home.position];
        this.yaw = this._home.yaw;
        this.pitch = this._home.pitch;
        this._velocity = [0, 0, 0];
        this._wheel = 0;
        this._turn = [0, 0];
        if (this.walking) {
            // An opening pose may be authored for its framing, off the eye plane or outside the
            // region; the entry fade hides the correction, so it can be immediate.
            this.position[1] = this.eyeY;
            if (this.region && this.region.distanceAt(this.position[0], this.position[2]) < this.region.spawnMargin) {
                const p = this.region.nearestInside(this.position[0], this.position[2]);
                this.position[0] = p.x;
                this.position[2] = p.z;
            }
        }
    }

    // pose readout for authoring: { position, target, fov } with the target 1 unit ahead
    getPose(fov) {
        const yaw = this.yaw * DEG, pitch = this.pitch * DEG;
        const [x, y, z] = this.position;
        const dir = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
        const r = (v) => Math.round(v * 1000) / 1000;
        return {
            position: [r(x), r(y), r(z)],
            target: [r(x + dir[0]), r(y + dir[1]), r(z + dir[2])],
            fov: Math.round(fov)
        };
    }

    update(dt) {
        dt = Math.min(dt, 0.1);

        // locked mouse look eases in over a few frames, as SuperSplat's damped camera angles do
        if (this._turn[0] !== 0 || this._turn[1] !== 0) {
            // the last sliver lands in full, so the head ends exactly where the mouse sent it
            const settled = Math.abs(this._turn[0]) < 1e-3 && Math.abs(this._turn[1]) < 1e-3;
            const t = settled ? 1 : 1 - Math.pow(LOCK_DAMPING, dt * 1000);
            const dYaw = this._turn[0] * t, dPitch = this._turn[1] * t;
            this.yaw += dYaw;
            this.pitch += dPitch;
            this._turn[0] -= dYaw;
            this._turn[1] -= dPitch;
            if (settled) this._turn = [0, 0];
        }

        const k = this._keys;
        const walking = this.walking;
        let strafe = 0, walk = 0, rise = 0;
        if (this.enabled) {
            walk = (k.has('forward') ? 1 : 0) - (k.has('back') ? 1 : 0);
            strafe = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
            if (!walking) rise = (k.has('up') ? 1 : 0) - (k.has('down') ? 1 : 0);
            if (this._stick) {
                strafe += this._stick.dx;
                walk -= this._stick.dy;
            }
        }

        // clamp rather than normalise: a half-pushed stick walks at half speed, a key diagonal
        // still can't exceed full speed
        const len = Math.hypot(strafe, walk);
        if (len > 1) { strafe /= len; walk /= len; }

        const upm = this.walk?.unitsPerMetre ?? 1;
        const speed = (this.walk?.speed ?? WALK_SPEED) * upm *
            (k.has('fast') ? (this.walk?.runMultiplier ?? FAST_MULTIPLIER) : 1);
        const yaw = this.yaw * DEG;
        const fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)];
        const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
        const target = [
            (fwd[0] * walk + right[0] * strafe) * speed,
            rise * speed * 0.7,
            (fwd[2] * walk + right[2] * strafe) * speed
        ];

        // ease towards the target velocity so starts and stops read as a body, not a cursor
        const blend = 1 - Math.exp(-dt * 9);
        for (let i = 0; i < 3; i++) this._velocity[i] += (target[i] - this._velocity[i]) * blend;

        let mx = this._velocity[0] * dt;
        let mz = this._velocity[2] * dt;

        // wheel steps are spread over a few frames
        if (this._wheel !== 0) {
            const step = this._wheel * (1 - Math.exp(-dt * 8));
            this._wheel -= step;
            if (Math.abs(this._wheel) < 1e-3) this._wheel = 0;
            mx += fwd[0] * step * upm;
            mz += fwd[2] * step * upm;
        }

        if (walking && this.region) {
            const m = this._move;
            m.x = mx;
            m.z = mz;
            this.region.applyMove(this.position[0], this.position[2], m);
            // write the allowed motion back as velocity, so momentum can't pile up against a
            // wall and release as a lurch when the visitor turns away
            if (dt > 0 && (m.x !== mx || m.z !== mz)) {
                this._velocity[0] = m.x / dt;
                this._velocity[2] = m.z / dt;
            }
            mx = m.x;
            mz = m.z;
        }

        this.position[0] += mx;
        this.position[2] += mz;
        if (walking) {
            this.position[1] = this.eyeY;
            this._velocity[1] = 0;
        } else {
            this.position[1] += this._velocity[1] * dt;
        }

        if (this.bounds && !(walking && this.region)) {
            const { min, max } = this.bounds;
            for (let i = 0; i < 3; i++) this.position[i] = Math.min(max[i], Math.max(min[i], this.position[i]));
        }
    }

    _release = () => {
        this._keys.clear();
        this._turn = [0, 0];
        this._endLook();
        this._endStick();
    };

    _onLockChange = () => {
        // a drag in progress when the lock engaged would otherwise keep turning the head
        if (this.locked) this._endLook();
    };

    _onLockedMove = (e) => {
        if (!this.locked || !this.enabled) return;
        const dx = e.movementX, dy = e.movementY;
        if (Math.abs(dx) > LOCK_SPIKE || Math.abs(dy) > LOCK_SPIKE) return;
        const s = this.mouseDegPerPx;
        this._turn[0] -= dx * s;
        // clamp the pitch the turn is heading for, not just the pitch shown this frame
        const goal = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + this._turn[1] - dy * s));
        this._turn[1] = goal - this.pitch;
    };

    _endLook() {
        this._look = null;
        this.surface.classList.remove('is-dragging');
    }

    _endStick() {
        this._stick = null;
        this.stickEl?.classList.remove('is-active');
        if (this.knobEl) this.knobEl.style.transform = '';
    }

    // is a touch at (x, y) close enough to the stick to grab it?
    _stickHit(x, y) {
        const el = this.stickEl;
        if (!el || !el.offsetParent) return null;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const radius = r.width / 2 || 1;
        return Math.hypot(x - cx, y - cy) <= radius * STICK_SLOP ? { cx, cy, r: radius } : null;
    }

    _onPointerDown = (e) => {
        if (!this.enabled || e.target.closest('button')) return;
        const touch = e.pointerType === 'touch';
        if (!touch && e.button !== 0) return;
        // desktop: a click takes the pointer; the mouse then looks until Esc
        if (!touch && this.lockable) {
            this.requestLock();
            return;
        }
        // iOS doesn't always deliver an up for a finger it retargeted around a suppressed
        // gesture; a new primary contact means anything still tracked is a leak, so start clean
        if (e.isPrimary && touch) {
            this._endLook();
            this._endStick();
        }
        // the stick only exists on screen in the full-screen layout, so any pointer may grab it
        const hit = !this._stick ? this._stickHit(e.clientX, e.clientY) : null;
        if (hit) {
            this._stick = { id: e.pointerId, ...hit, dx: 0, dy: 0 };
            this.stickEl.classList.add('is-active');
            this._trackStick(e);
        } else if (!this._look) {
            this._look = { id: e.pointerId, x: e.clientX, y: e.clientY, touch };
            this.surface.classList.add('is-dragging');
        } else {
            return;
        }
        this.surface.setPointerCapture?.(e.pointerId);
        if (touch) e.preventDefault();
    };

    _onPointerMove = (e) => {
        if (this.locked) return;    // locked movement is read from mousemove
        if (this._look && e.pointerId === this._look.id) {
            const sens = this._look.touch ? this.touchDegPerPx : LOOK_MOUSE;
            this.yaw += (e.clientX - this._look.x) * sens;
            this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + (e.clientY - this._look.y) * sens));
            this._look.x = e.clientX;
            this._look.y = e.clientY;
        } else if (this._stick && e.pointerId === this._stick.id) {
            this._trackStick(e);
        }
    };

    _onPointerUp = (e) => {
        if (this._look && e.pointerId === this._look.id) this._endLook();
        if (this._stick && e.pointerId === this._stick.id) this._endStick();
    };

    // finger position -> unit-disc vector with the dead zone rescaled out; knob follows the thumb
    _trackStick(e) {
        const s = this._stick;
        let x = (e.clientX - s.cx) / s.r;
        let y = (e.clientY - s.cy) / s.r;
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len; }
        const mag = Math.min(len, 1);
        const k = mag <= STICK_DEADZONE ? 0 : (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE) / mag;
        s.dx = x * k;
        s.dy = y * k;
        if (this.knobEl) {
            this.knobEl.style.transform = `translate(${x * s.r * KNOB_TRAVEL}px, ${y * s.r * KNOB_TRAVEL}px)`;
        }
    }

    _onWheel = (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        this._wheel = Math.max(-3, Math.min(3, this._wheel - e.deltaY * lines * 0.004));
    };

    _onKeyDown = (e) => {
        if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return;
        const action = KEYMAP[e.code];
        if (!action) return;
        e.preventDefault();
        this._keys.add(action);
    };

    _onKeyUp = (e) => {
        const action = KEYMAP[e.code];
        if (action) this._keys.delete(action);
    };
}
