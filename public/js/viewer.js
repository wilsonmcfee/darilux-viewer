// The 3D side of the viewer window. This module (and the PlayCanvas engine it imports) is only
// fetched when a visitor first clicks into a room, so the landing page pays none of its cost.
// One scan is held in memory at a time: loading a room releases the previous one.

import * as pc from 'playcanvas';
import { WalkControls } from './walk-controls.js';

const SHELL = new pc.Color(0x14 / 255, 0x10 / 255, 0x0c / 255);
const DEG = Math.PI / 180;

// Full-screen phone view: a tall VERTICAL field of view so the floor and ceiling are both in
// frame while looking level. Per studio as `mobileFov`; ?fov=NN overrides it for A/B on a device.
// In landscape the horizontal span is capped instead, or a wide phone would go fisheye.
const MOBILE_FOV = 100;
const MOBILE_MAX_HFOV = 120;
const params = new URLSearchParams(location.search);
const FOV_OVERRIDE = Number(params.get('fov')) || null;
const AUTHOR = params.has('author');

export class Viewer {
    static async create(canvas, surface, options) {
        const device = await pc.createGraphicsDevice(canvas, {
            deviceTypes: [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2],
            antialias: false,
            depth: true,
            stencil: false,
            powerPreference: 'high-performance'
        });
        return new Viewer(canvas, surface, device, options);
    }

    asset = null;
    entity = null;
    _active = false;
    _visible = true;
    _cancelReady = null;
    _immersive = false;
    _studio = null;

    constructor(canvas, surface, device, { stick } = {}) {
        this.surface = surface;
        device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.deviceType = device.deviceType;

        const app = new pc.Application(canvas, { graphicsDevice: device });
        this.app = app;
        // cross-origin scans (e.g. streamed .sog textures) need anonymous CORS on image loads
        app.loader.getHandler('texture').imgParser.crossOrigin = 'anonymous';
        app.setCanvasFillMode(pc.FILLMODE_NONE);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);

        // scene-level splat settings, matched to the SuperSplat viewer
        const webgpu = device.deviceType === 'webgpu';
        const gsplat = app.scene.gsplat;
        gsplat.lodUpdateAngle = 90;
        gsplat.lodBehindPenalty = 5;
        gsplat.lodMode = pc.GSPLAT_LODMODE_DISTANCE;
        gsplat.minContribution = 1;
        gsplat.alphaClip = 1 / 255;
        gsplat.radialSorting = true;
        gsplat.colorUpdateAngle = 0.2;
        gsplat.renderer = webgpu ? pc.GSPLAT_RENDERER_RASTER_GPU_SORT : pc.GSPLAT_RENDERER_RASTER_CPU_SORT;
        // WebGL2 sorts on the CPU, so it gets a smaller splat budget
        gsplat.splatBudget = (pc.platform.mobile ? 2 : 4) * (webgpu ? 1 : 0.5) * 1e6;

        const camera = new pc.Entity('camera', app);
        camera.addComponent('camera', {
            clearColor: SHELL,
            fov: 90,
            nearClip: 0.03,
            farClip: 600,
            toneMapping: pc.TONEMAP_LINEAR
        });
        app.root.addChild(camera);
        this.camera = camera;

        this.controls = new WalkControls(surface, { stick });
        this.controls.free = AUTHOR;
        this._exposeHelpers();
        app.on('update', (dt) => {
            const c = this.controls;
            c.update(dt);
            camera.setPosition(c.position[0], c.position[1], c.position[2]);
            camera.setEulerAngles(c.pitch, c.yaw, 0);
        });

        this._resize = new ResizeObserver(() => this._fit());
        this._resize.observe(surface);
        this._intersect = new IntersectionObserver(([entry]) => {
            this._visible = entry.isIntersecting;
            this._updateRendering();
        });
        this._intersect.observe(surface);

        this._fit();
        app.start();
        this._updateRendering();
    }

    // true while loading or inside; false stops drawing while the gate covers the canvas
    setActive(on) {
        this._active = on;
        if (!on) this.controls.setEnabled(false);
        this._updateRendering();
    }

    enableControls(on) {
        this.controls.setEnabled(on);
    }

    // full-screen phone mode: switches the camera to the tall vertical field of view
    setImmersive(on) {
        this._immersive = on;
        this.controls.setLockable(!on);
        this._fit();
    }

    resetView() {
        this.controls.reset();
    }

    load(studio, onProgress) {
        this.unload();

        const url = studio.src;
        const filename = url.split('?')[0].split('/').pop();
        const asset = new pc.Asset(`${studio.id}/${filename}`, 'gsplat', { url, filename });
        this.asset = asset;

        this._studio = studio;
        this._fit();
        this.controls.setPose(studio.start, studio.bounds ?? null, studio.walk ?? null);

        const cancelled = () => this.asset !== asset;

        return new Promise((resolve, reject) => {
            asset.on('progress', (received, length) => {
                if (!cancelled() && length > 0) onProgress?.(Math.min(1, received / length), 'download');
            });

            asset.once('load', () => {
                if (cancelled()) return;
                const entity = new pc.Entity('scan', this.app);
                entity.setLocalEulerAngles(...(studio.rotation ?? [0, 0, 180]));
                entity.addComponent('gsplat', { unified: true, asset });
                entity.gsplat.lodRangeMin = 0;
                entity.gsplat.lodRangeMax = 1000;
                this.app.root.addChild(entity);
                this.entity = entity;
                onProgress?.(1, 'stream');

                // resolve once the first view is fully streamed and sorted (or after a grace period)
                const system = this.app.systems.gsplat;
                const finish = () => {
                    this._cancelReady?.();
                    if (!cancelled()) resolve();
                };
                const onReady = (cam, layer, ready, loading) => {
                    if (ready && loading === 0) finish();
                };
                const timer = setTimeout(finish, 20000);
                system.on('frame:ready', onReady);
                this._cancelReady = () => {
                    system.off('frame:ready', onReady);
                    clearTimeout(timer);
                    this._cancelReady = null;
                };
            });

            asset.once('error', (err) => {
                if (cancelled()) return;
                this.unload();
                reject(new Error(typeof err === 'string' ? err : err?.message ?? 'Failed to load scan'));
            });

            this.app.assets.add(asset);
            this.app.assets.load(asset);
        });
    }

    unload() {
        this._cancelReady?.();
        this.controls.setEnabled(false);
        this.controls.releaseLock();
        if (this.entity) {
            this.entity.destroy();
            this.entity = null;
        }
        if (this.asset) {
            const asset = this.asset;
            this.asset = null;
            this.app.assets.remove(asset);
            asset.unload();
        }
    }

    destroy() {
        this.unload();
        this._resize.disconnect();
        this._intersect.disconnect();
        this.controls.destroy();
        this.app.destroy();
    }

    _fit() {
        const w = this.surface.clientWidth;
        const h = this.surface.clientHeight;
        if (!w || !h) return;
        this.app.resizeCanvas(w, h);
        const cam = this.camera.camera;
        let vfov;
        if (this._immersive) {
            // vertical fov, unless that would push the horizontal span past the cap
            const want = FOV_OVERRIDE ?? this._studio?.mobileFov ?? MOBILE_FOV;
            const capped = 2 * Math.atan(Math.tan((MOBILE_MAX_HFOV * DEG) / 2) * (h / w)) / DEG;
            vfov = Math.min(want, capped);
            cam.horizontalFov = false;
            cam.fov = vfov;
        } else {
            // SuperSplat's convention: fov spans the wider side of the window
            const fov = this._studio?.fov ?? 90;
            cam.horizontalFov = w >= h;
            cam.fov = fov;
            vfov = w >= h ? 2 * Math.atan(Math.tan((fov * DEG) / 2) * (h / w)) / DEG : fov;
        }
        // a touch drag moves the scene with the finger: the window height spans the vertical fov
        this.controls.touchDegPerPx = vfov / h;
        // locked mouse look at SuperSplat's rate: orbitSpeed 18 x 0.5 sensitivity / 60, scaled by fov / 120
        this.controls.mouseDegPerPx = 0.15 * cam.fov / 120;
        this.app.renderNextFrame = true;
    }

    // Console helpers for authoring, in the Bluedio viewer's idiom:
    //   __logPose()   paste-ready { position, target, fov } for a studio's `start` or a hero pose
    //   __walk(0|1)   drop / restore the eye-height lock and region (?author starts with it off)
    //   __walkDebug() distance to the region edge in metres, and the backstop count
    _exposeHelpers() {
        const c = this.controls;
        const fmt = (v) => `[${v.join(', ')}]`;
        window.__logPose = () => {
            const p = c.getPose(this.camera.camera.fov);
            console.log(`{ position: ${fmt(p.position)}, target: ${fmt(p.target)}, fov: ${p.fov} }`);
            return p;
        };
        window.__walk = (on) => {
            c.free = !on;
            if (on) c.reset();
            return c.walking;
        };
        window.__walkDebug = () => {
            if (!c.region) return c.walk ? 'height-locked, no region' : 'no walk block for this studio';
            const d = c.region.distanceAt(c.position[0], c.position[2]);
            return { distance: Math.round(d * 1000) / 1000, inside: d >= 0, backstops: c.region.backstops };
        };
        if (AUTHOR) console.info('Studio viewer: authoring mode, walk lock off (Q / E for height). __logPose() prints the current pose.');
    }

    _updateRendering() {
        this.app.autoRender = this._active && this._visible;
        if (this.app.autoRender) this.app.renderNextFrame = true;
    }
}
