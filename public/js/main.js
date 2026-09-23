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

    const name = current?.name ?? '';
    const captions = {
        gate: [`${name} · ${current?.status ?? ''}`, 'Click the window to enter'],
        loading: [`${name} · ${current?.status ?? ''}`, 'Loading'],
        inside: [HINT, `In ${name}`],
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

function showGate(studio) {
    gateKicker.textContent = studio.name;
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

function openStudio(studio, { scroll = false, updateHash = true } = {}) {
    const same = current?.id === studio.id && !win.hidden;
    if (!same) {
        loadToken++;
        viewer?.unload();
        current = studio;
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
        if (updateHash) history.replaceState(null, '', `#studio-${studio.id}`);
    }
    if (scroll) {
        const rect = win.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            win.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        }
    }
}

async function enter() {
    if (!current || panel.dataset.state === 'loading' || panel.dataset.state === 'inside') return;
    const studio = current;

    if (!supportsGraphics()) {
        gateTitle.textContent = 'This browser can’t show 3D rooms';
        gateNote.textContent = 'The viewer needs WebGPU or WebGL2. Try a current version of Chrome, Edge, Safari or Firefox.';
        gate.disabled = true;
        setState('unsupported');
        return;
    }

    if (IMMERSIVE) setImmersive(true);

    const token = ++loadToken;
    loaderLabel.textContent = `Loading ${studio.name}`;
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
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'look') lockPointer();
    if (action === 'reset') viewer?.resetView();
    if (action === 'leave') leave();
    if (action === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen();
        else panel.requestFullscreen?.().catch(() => {});
    }
});

if (!document.fullscreenEnabled) fullscreenBtn.hidden = true;
document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    if (panel.dataset.state === 'inside') panel.focus({ preventScroll: true });
});

// ---- deep links: #studio-e opens that studio's window (it still waits for a click) --------

function fromHash() {
    const id = location.hash.match(/^#studio-([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const studio = STUDIOS.find((s) => s.id === id);
    if (studio) openStudio(studio, { updateHash: false });
}
window.addEventListener('hashchange', fromHash);
fromHash();
