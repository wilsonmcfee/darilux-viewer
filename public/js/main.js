// Landing page: studio labels -> viewer window -> click to enter the room.
// Nothing graphics-related starts until the visitor clicks into the window.

import { STUDIOS } from './studios.js';

const coarse = matchMedia('(pointer: coarse)').matches;
// Phones enter rooms full screen: canvas, walk stick and an exit, nothing else.
// ?mobile forces that layout on a desktop for review (the stick then takes a mouse too).
const IMMERSIVE = coarse || new URLSearchParams(location.search).has('mobile');
// Desktop look works as in SuperSplat: clicking the view hides the cursor and the mouse turns the
// head until Esc. "Click to enter" only loads the room: it opens behind a closed iris with
// "Click to look around", and that second click takes the pointer and opens the iris.
const LOCKABLE = !IMMERSIVE && 'requestPointerLock' in Element.prototype;
const HINT = coarse
    ? 'Stick walks · drag to look'
    : LOCKABLE
        ? 'Click to look · WASD or arrows to walk · Shift to hurry · Esc frees the mouse'
        : 'Drag to look · WASD or arrows to walk · Shift to hurry';

const labels = document.getElementById('studio-labels');
const win = document.getElementById('viewer-window');
const panel = document.getElementById('viewer-panel');
const canvas = document.getElementById('viewer-canvas');
const gate = document.getElementById('viewer-gate');
const gateArt = gate.querySelector('.gate-art');
const gateLetter = gate.querySelector('.gate-letter');
const gateKicker = gate.querySelector('.gate-kicker');
const gateTitle = gate.querySelector('.gate-title');
const gateNote = gate.querySelector('.gate-note');
const loaderLabel = panel.querySelector('.loader-label');
const loaderFill = panel.querySelector('.loader-fill');
const loaderPct = panel.querySelector('.loader-pct');
const caption = document.getElementById('viewer-caption');
const stateText = document.getElementById('viewer-state');
const fullscreenBtn = panel.querySelector('[data-action="fullscreen"]');
const lookHint = panel.querySelector('.look-hint');

panel.classList.toggle('can-lock', LOCKABLE);

let current = null;
let hintTimer = 0;
let viewer = null;
let viewerPromise = null;
let loadToken = 0;
let roomIndex = 0;

// A studio is one scan unless it lists `rooms`. room() is the scan to load right now: the
// room's own fields over the studio's, with an id that keeps rooms' assets apart.
function room(studio = current) {
    if (!studio?.rooms) return studio;
    const r = studio.rooms[roomIndex] ?? studio.rooms[0];
    return { ...studio, rooms: undefined, ...r, id: `${studio.id}-${r.id}`, roomName: r.name };
}

// ---- labels --------------------------------------------------------------------------------

for (const studio of STUDIOS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'studio';
    btn.dataset.id = studio.id;
    if (!studio.placeholder) btn.dataset.live = '';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-controls', 'viewer-window');
    btn.innerHTML = `
        <span class="studio-kicker">Studio</span>
        <span class="studio-letter">${studio.letter}</span>
        <span class="studio-status">${studio.status}</span>`;
    btn.addEventListener('click', () => openStudio(studio, { scroll: true }));
    labels.appendChild(btn);
}

// ---- window states: gate -> loading -> inside (or error / unsupported) --------------------

function setState(state) {
    panel.dataset.state = state;
    viewer?.setActive(state === 'loading' || state === 'inside');
    viewer?.enableControls(state === 'inside');

    const here = room();
    const name = here?.roomName ? `${current.name} · ${here.roomName}` : current?.name ?? '';
    const captions = {
        gate: [`${name} · ${current?.status ?? ''}`, 'Click the window to enter'],
        loading: [`${name} · ${current?.status ?? ''}`, 'Loading'],
        inside: [hintFor(here), `In ${name}`],
        error: [`${name} · ${current?.status ?? ''}`, 'Could not load'],
        unsupported: [`${name} · ${current?.status ?? ''}`, '3D unavailable']
    };
    const [left, right] = captions[state];
    caption.textContent = left;
    stateText.textContent = right;
    updateLookHint();
}

// ---- pointer lock: the in-room hint follows it ----------------------------------------------

function lockPointer() {
    if (!LOCKABLE || document.pointerLockElement === panel) return;
    try {
        panel.requestPointerLock()?.catch?.(() => {});
    } catch {
        // refused; clicking the view inside the room asks again
    }
}

function unlockPointer() {
    if (document.pointerLockElement === panel) document.exitPointerLock();
}

// While the mouse is free, the iris closes in around the centred prompt (all CSS, keyed off
// .is-locked). Once it's taken, the iris opens to the frame's edges and a brief note says how to
// get the cursor back.
function updateLookHint() {
    clearTimeout(hintTimer);
    const locked = document.pointerLockElement === panel;
    panel.classList.toggle('is-locked', locked);
    const show = LOCKABLE && locked && panel.dataset.state === 'inside';
    lookHint.classList.toggle('is-visible', show);
    if (show) hintTimer = setTimeout(() => lookHint.classList.remove('is-visible'), 2600);
}

document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === panel) panel.focus({ preventScroll: true });
    updateLookHint();
});
document.addEventListener('pointerlockerror', updateLookHint);

function hintFor(studio) {
    const n = studio?.heroes?.length ?? 0;
    if (!n) return HINT;
    const keys = n === 1 ? '1' : `1–${Math.min(n, 9)}`;
    return coarse ? `${HINT} · tap a number for a hero view` : `${HINT} · ${keys} hero views`;
}

// ---- hero views: numbered buttons that glide the camera to an authored pose -----------------

const heroNav = panel.querySelector('.heroes');

function renderHeroes(studio) {
    const heroes = studio.heroes ?? [];
    heroNav.hidden = heroes.length === 0;
    heroNav.replaceChildren(...heroes.map((hero, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.hero = String(i);
        const n = String(i + 1).padStart(2, '0');
        btn.innerHTML = `<span class="hero-n">${n}</span>${hero.label ? `<span class="hero-label">${hero.label}</span>` : ''}`;
        btn.setAttribute('aria-label', hero.label ? `Hero view ${i + 1}: ${hero.label}` : `Hero view ${i + 1}`);
        return btn;
    }));
}

function goToHero(i) {
    const hero = room()?.heroes?.[i];
    if (!hero || !viewer || panel.dataset.state !== 'inside') return;
    viewer.flyTo(hero.pose);
}

// ---- rooms: a studio with several scanned spaces gets buttons to move between them ----------

const roomNav = panel.querySelector('.rooms');

function renderRooms() {
    const rooms = current?.rooms ?? [];
    roomNav.hidden = rooms.length < 2;
    roomNav.replaceChildren(...rooms.map((r, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.room = String(i);
        btn.textContent = r.name;
        btn.setAttribute('aria-pressed', String(i === roomIndex));
        return btn;
    }));
}

// like walking through a door: the gate drops over the view, the next scan loads behind it
// (the previous one released first) and the room opens behind the closed iris again
function switchRoom(i) {
    if (!current?.rooms?.[i] || (i === roomIndex && panel.dataset.state === 'inside')) return;
    loadToken++;
    unlockPointer();
    viewer?.unload();
    roomIndex = i;
    renderRooms();
    renderHeroes(room());
    history.replaceState(null, '', hashFor(current));
    loadRoom();
}

function hashFor(studio) {
    const r = studio.rooms && roomIndex > 0 ? `/${studio.rooms[roomIndex].id}` : '';
    return `#studio-${studio.id}${r}`;
}

function showGate(studio) {
    renderRooms();
    renderHeroes(room(studio));
    const here = room(studio);
    gateKicker.textContent = here.roomName && roomIndex > 0 ? `${studio.name} · ${here.roomName}` : studio.name;
    gateLetter.textContent = studio.letter;
    gateArt.classList.toggle('has-poster', !!studio.poster);
    gateArt.style.setProperty('--poster', studio.poster ? `url("${studio.poster}")` : 'none');
    gateTitle.textContent = 'Click to enter';
    gateNote.textContent = studio.placeholder ? 'Placeholder room until the scan is delivered' : '';
    gate.disabled = false;
    gate.setAttribute('aria-label', `Enter ${studio.name}`);
    setState('gate');
}

function setProgress(fraction, phase) {
    if (phase === 'stream') {
        panel.dataset.phase = 'stream';
        loaderPct.textContent = 'Streaming detail';
        return;
    }
    panel.dataset.phase = 'download';
    const pct = Math.round(fraction * 100);
    loaderFill.style.transform = `scaleX(${fraction})`;
    loaderPct.textContent = `${pct}%`;
}

function supportsGraphics() {
    if ('gpu' in navigator) return true;
    try {
        return !!document.createElement('canvas').getContext('webgl2');
    } catch {
        return false;
    }
}

// ---- actions -------------------------------------------------------------------------------

function openStudio(studio, { scroll = false, updateHash = true, roomId = null } = {}) {
    const wantRoom = Math.max(0, studio.rooms?.findIndex((r) => r.id === roomId) ?? 0);
    const same = current?.id === studio.id && !win.hidden && wantRoom === roomIndex;
    if (!same) {
        loadToken++;
        unlockPointer();
        viewer?.unload();
        current = studio;
        roomIndex = wantRoom;
        for (const btn of labels.children) {
            btn.setAttribute('aria-pressed', String(btn.dataset.id === studio.id));
        }
        showGate(studio);
        if (win.hidden) {
            win.hidden = false;
            win.classList.remove('is-open');
            void win.offsetWidth;   // restart the reveal animation
            win.classList.add('is-open');
        }
        if (updateHash) history.replaceState(null, '', hashFor(studio));
    }
    if (scroll) {
        const rect = win.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            win.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        }
    }
}

function enter() {
    if (!current || panel.dataset.state === 'loading' || panel.dataset.state === 'inside') return;

    if (!supportsGraphics()) {
        gateTitle.textContent = 'This browser can’t show 3D rooms';
        gateNote.textContent = 'The viewer needs WebGPU or WebGL2. Try a current version of Chrome, Edge, Safari or Firefox.';
        gate.disabled = true;
        setState('unsupported');
        return;
    }

    if (IMMERSIVE) setImmersive(true);
    loadRoom();
}

// loads room() into the window: from the gate on entry, or mid-visit when the room changes
async function loadRoom() {
    const studio = room();
    const token = ++loadToken;
    loaderLabel.textContent = `Loading ${studio.roomName ?? studio.name}`;
    setProgress(0, 'download');
    setState('loading');

    try {
        if (!viewer) {
            viewerPromise ??= import('./viewer.js').then(({ Viewer }) =>
                Viewer.create(canvas, panel, { stick: panel.querySelector('.stick') }));
            viewer = await viewerPromise;
            viewer.setActive(true);
            viewer.setImmersive(panel.classList.contains('is-immersive'));
            console.info(`Studio viewer: ${viewer.deviceType} renderer`);
            if (new URLSearchParams(location.search).has('debug')) window.viewer = viewer;
        }
        if (token !== loadToken) return;
        await viewer.load(studio, (fraction, phase) => {
            if (token === loadToken) setProgress(fraction, phase);
        });
        if (token !== loadToken) return;
        setState('inside');
        panel.focus({ preventScroll: true });
    } catch (err) {
        if (token !== loadToken) return;
        console.error(err);
        unlockPointer();
        viewerPromise = viewer ? viewerPromise : null;
        gateTitle.textContent = 'Try again';
        gateNote.textContent = `This room didn’t load. ${err?.message ?? ''}`.trim();
        setState('error');
    }
}

function leave() {
    loadToken++;
    unlockPointer();
    viewer?.unload();
    if (document.fullscreenElement) document.exitFullscreen();
    setImmersive(false);
    showGate(current);
}

// The window becomes a fixed full-viewport layer. Where the Fullscreen API exists for elements
// (Android, iPad) it also hides the browser chrome; iPhone Safari keeps its bars.
function setImmersive(on) {
    if (on && !panel.classList.contains('is-immersive') && document.fullscreenEnabled && coarse) {
        panel.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    }
    panel.classList.toggle('is-immersive', on);
    document.documentElement.classList.toggle('is-immersive', on);
    viewer?.setImmersive(on);
}

gate.addEventListener('click', enter);

panel.addEventListener('click', (e) => {
    const roomBtn = e.target.closest('[data-room]')?.dataset.room;
    if (roomBtn !== undefined) {
        switchRoom(Number(roomBtn));
        return;
    }
    const hero = e.target.closest('[data-hero]')?.dataset.hero;
    if (hero !== undefined) {
        goToHero(Number(hero));
        // take the mouse too, so the iris opens onto the flight rather than hiding it
        lockPointer();
        return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'look') lockPointer();
    if (action === 'reset') viewer?.resetView();
    if (action === 'leave') leave();
    if (action === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen();
        else panel.requestFullscreen?.().catch(() => {});
    }
});

// number keys jump to hero views, and keep working while the mouse is locked
panel.addEventListener('keydown', (e) => {
    const m = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
    if (!m || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!room()?.heroes?.[Number(m[1]) - 1]) return;
    e.preventDefault();
    goToHero(Number(m[1]) - 1);
});

if (!document.fullscreenEnabled) fullscreenBtn.hidden = true;
document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    if (panel.dataset.state === 'inside') panel.focus({ preventScroll: true });
});

// ---- deep links: #studio-e opens that studio's window, #studio-c/booth a room in it (both still
//      wait for a click) --------------------------------------------------------------------

function fromHash() {
    const m = location.hash.match(/^#studio-([a-z0-9]+)(?:\/([a-z0-9-]+))?$/i);
    const studio = STUDIOS.find((s) => s.id === m?.[1]?.toLowerCase());
    if (studio) openStudio(studio, { updateHash: false, roomId: m[2]?.toLowerCase() ?? null });
}
window.addEventListener('hashchange', fromHash);
fromHash();
