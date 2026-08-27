/* ============================================================================
   authoring.ts — the ?author rig: crosshair, pose panel, splat-snap picking.
   ----------------------------------------------------------------------------
   Split out of main.ts, and loaded through a BUILD-GATED dynamic import — see
   the AUTHORING flag there. Pose authoring is a tool, not a viewer feature: a
   client build tree-shakes this module (and the SplatPicker it owns) out
   entirely, so visitors stop downloading the rig they can never open.

   Everything here is authoring-only cost: the picker decodes each scene's
   splat centers on the CPU, the panel polls the pose 6x a second, and the
   __logPose / __logAnchor console helpers are registered here so they exist
   exactly when the rig does.
   ========================================================================== */

import { Vec3, type Application, type Entity } from 'playcanvas';
import { logTag } from './brand';
import type { OrbitFlyCamera } from './camera';
import { SplatPicker } from './splatpick';

export interface AuthoringDeps {
  app: Application;
  camera: Entity;
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  controller: OrbitFlyCamera;
  /** The live splat entity, for snap-picking against its world transform. */
  currentSplat(): Entity | null;
}

export interface AuthoringRig {
  /** Decode this scene's splat centers for snap-picking (called per scene load). */
  onSceneUrl(url: string): void;
}

export function mountAuthoring(deps: AuthoringDeps): AuthoringRig {
  const { app, camera, canvas, stage, controller } = deps;

  // Expose the pose/anchor authoring helpers for the browser console.
  (window as unknown as { __logPose: () => void }).__logPose = () => controller.logPose();
  (window as unknown as { __logAnchor: () => void }).__logAnchor = () => controller.logAnchor();

  // The picker decodes each scene's splat centers on the CPU — author-only
  // cost, never paid by visitors (this module does not exist in their build).
  const picker = new SplatPicker();

  // Authoring aid: a center crosshair plus an on-screen panel with a live pose
  // readout and Copy pose / Copy anchor buttons (no console needed; works on
  // touch). The console helpers (__logPose / __logAnchor) still work as a
  // fallback.
  const cross = document.createElement('div');
  cross.id = 'author-crosshair';
  stage.appendChild(cross);

  const panel = document.createElement('div');
  panel.id = 'author-panel';
  panel.innerHTML =
    `<div id="author-readout"></div>
     <div class="author-btns">
       <button type="button" id="author-copy-pose">Copy pose</button>
       <button type="button" id="author-snap-anchor">Snap anchor</button>
       <button type="button" id="author-copy-anchor">Free anchor</button>
     </div>`;
  stage.appendChild(panel);

  // The last splat-snapped pick, shown as a live dot so you can verify it
  // sticks to the surface while orbiting/zooming (no parallax slide).
  let pickedWorld: Vec3 | null = null;
  const pickedDot = document.createElement('div');
  pickedDot.id = 'author-picked';
  stage.appendChild(pickedDot);
  const screenTmp = new Vec3();
  app.on('update', () => {
    if (!pickedWorld || !camera.camera) {
      pickedDot.style.display = 'none';
      return;
    }
    camera.camera.worldToScreen(pickedWorld, screenTmp);
    pickedDot.style.display = screenTmp.z > 0 ? '' : 'none';
    pickedDot.style.left = `${screenTmp.x}px`;
    pickedDot.style.top = `${screenTmp.y}px`;
  });

  const readout = panel.querySelector('#author-readout') as HTMLElement;
  const fmt = (v: number[]) => `[${v.join(', ')}]`;
  // Live readout — cheap, so just poll. getPose() is side-effect free.
  window.setInterval(() => {
    const p = controller.getPose();
    readout.textContent =
      `pos ${fmt(p.position)}\ntgt ${fmt(p.target)}\nfov ${p.fov}`;
  }, 150);

  // Copy → clipboard when available (localhost/https), console otherwise.
  const copy = async (snippet: string, btn: HTMLButtonElement) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(snippet);
    } catch {
      ok = false;
      console.log(logTag() + ' copy blocked — paste from here:\n' + snippet);
    }
    const original = btn.textContent;
    btn.textContent = ok ? 'Copied ✓' : 'See console';
    window.setTimeout(() => (btn.textContent = original), 1200);
  };
  panel.querySelector('#author-copy-pose')!.addEventListener('click', () => {
    const p = controller.getPose();
    void copy(
      `pose: { position: ${fmt(p.position)}, target: ${fmt(p.target)}, fov: ${p.fov} },`,
      panel.querySelector('#author-copy-pose') as HTMLButtonElement,
    );
  });
  panel.querySelector('#author-copy-anchor')!.addEventListener('click', () => {
    // "Free anchor": the raw orbit target (screen-center, but at the orbit
    // pivot's depth — may float off the surface). Prefer Snap anchor.
    const p = controller.getPose();
    void copy(
      `anchor: ${fmt(p.target)},`,
      panel.querySelector('#author-copy-anchor') as HTMLButtonElement,
    );
  });

  // ---- Splat-snapped anchor picking ------------------------------------
  // Casts a ray and snaps to the nearest actual splat center, so the
  // anchor sits ON the captured surface. A dot authored this way cannot
  // parallax-slide across the gear when the visitor zooms or orbits.
  const PICK_PX = 8; // screen-space pick tolerance
  const snapBtn = panel.querySelector('#author-snap-anchor') as HTMLButtonElement;
  const pickAt = (cssX: number, cssY: number): void => {
    const cc = camera.camera;
    const splat = deps.currentSplat();
    if (!cc || !splat) return;
    if (!picker.ready) {
      snapBtn.textContent = 'Decoding…';
      window.setTimeout(() => (snapBtn.textContent = 'Snap anchor'), 1200);
      return;
    }
    const far = cc.screenToWorld(cssX, cssY, cc.farClip);
    const origin = camera.getPosition();
    const dir = new Vec3().sub2(far, origin).normalize();
    const tanRadius =
      Math.tan((cc.fov * Math.PI) / 360) * ((2 * PICK_PX) / Math.max(canvas.clientHeight, 1));
    const hit = picker.pick(origin, dir, tanRadius, splat.getWorldTransform());
    if (!hit) return;
    pickedWorld = new Vec3(hit[0], hit[1], hit[2]);
    void copy(`anchor: [${hit.join(', ')}],`, snapBtn);
  };
  // Button: pick whatever is under the center crosshair.
  snapBtn.addEventListener('click', () =>
    pickAt(canvas.clientWidth / 2, canvas.clientHeight / 2),
  );
  // Double-click / double-tap: pick under the cursor (doesn't fight orbit-drag).
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    pickAt(e.clientX - rect.left, e.clientY - rect.top);
  });

  console.info(logTag() + ' authoring mode — Copy pose (or __logPose()) for framings; Snap anchor (or double-click) pins to the splat surface');

  return {
    onSceneUrl(url: string): void {
      picker.load(url).catch((e) => console.warn(logTag() + ' splat pick data unavailable:', e));
    },
  };
}
