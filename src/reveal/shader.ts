/* ============================================================================
   reveal/shader.ts — the gsplatModifyVS override, in both shader languages.
   ----------------------------------------------------------------------------
   PlayCanvas 2.21 ships `gsplatModifyVS` as three empty stubs specifically so
   userland can transform splats in the vertex stage:

     void modifySplatCenter(inout vec3 center)
     void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter,
                                   inout vec4 rotation, inout vec3 scale)
     void modifySplatColor(vec3 center, inout vec4 color)

   Call order inside the final-render vertex shader (glsl/chunks/gsplat/vert/
   gsplat.js) is centre -> corner (rotation/scale) -> colour, and it is load
   bearing here: modifySplatCenter computes the phase and the eased progress ONCE
   and stashes them in file-globals for the other two. modifySplatColor is handed
   the ALREADY-MODIFIED centre, so it could not recompute phase correctly even if
   we wanted it to.

   WHY BOTH LANGUAGES: device.ts is WebGPU-first, and GSPLAT_RENDERER_AUTO
   resolves to RASTER_GPU_SORT on WebGPU / RASTER_CPU_SORT on WebGL2 (never the
   compute path — the setter coerces that back to AUTO). Both raster paths run
   this chunk, but WebGPU runs the WGSL collection and WebGL2 the GLSL one. A
   GLSL-only override is a silent no-op on the machine you are most likely
   testing on.

   WHY EVERYTHING IS A UNIFORM: setParameter does not recompile; setDefine does,
   and gsplat-shadow-renderer / gsplat-projector additionally cache the chunk
   SOURCE and rebuild when it changes. So the chunk text is generated once per
   session and never varies — every control is a uniform, including the
   phase-function and easing selectors, which branch on a float. A parameter
   explorer that recompiles on every dropdown change is unusable.

   SPACE: in unified rendering the mesh instance hangs off a fresh untransformed
   GraphNode ("GSplatManager"), so matrix_model is identity and getCenter()
   returns WORLD space — the scene entity's 180 degree roll is already baked in
   by the work-buffer copy. Bounds and camera position passed in must be world.
   ========================================================================== */

/** Packed uniform layout, shared by both languages and by driver.ts. */
export const UNIFORMS = {
  /** x: u (normalised time, 0..1+spread), y: spread, z: hashBlend, w: enabled */
  A: 'uRevealA',
  /** x: phaseMode, y: easeMode, z: seedScale, w: opacityLead */
  B: 'uRevealB',
  /** x: dispMag, y: dispMode, z: tintStrength, w: seedAlphaFloor */
  C: 'uRevealC',
  /** rgb: seed tint, w: seedGate */
  TINT: 'uRevealTint',
  /** xyz: scene aabb min (world), w: 1 / height */
  MIN: 'uRevealMin',
  /** xyz: radial origin = scene centre (world), w: 1 / radial max */
  ORG: 'uRevealOrg',
  /** xyz: camera position (world), w: 1 / camera range */
  CAM: 'uRevealCam',
} as const;

/* ---------------------------------------------------------------------------
   GLSL — WebGL2 path.
   `splat` is in scope: gsplatCommonVS includes gsplatStructsVS (which pulls in
   gsplatSplatVS, declaring `Splat splat;`) BEFORE gsplatModifyVS.
   --------------------------------------------------------------------------- */
export const REVEAL_GLSL = /* glsl */ `
uniform vec4 uRevealA;
uniform vec4 uRevealB;
uniform vec4 uRevealC;
uniform vec4 uRevealTint;
uniform vec4 uRevealMin;
uniform vec4 uRevealOrg;
uniform vec4 uRevealCam;

// Stashed by modifySplatCenter for the two calls that follow it.
float gRevealE = 1.0;   // eased scale progress
float gRevealA = 1.0;   // eased alpha progress (leads gRevealE)
float gRevealFloor = 0.0; // seed alpha floor after gating

// Dave Hoskins hash11, keyed on splat.index rather than position: adjacent
// splats are millimetres apart, and a position hash at any sane frequency gives
// neighbours near-identical values -- a smooth noise field, not per-splat
// sparkle. index is the work-buffer slot, stable for a single static scene.
float revealHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float revealEase(float t, float mode) {
  float inv = 1.0 - t;
  if (mode < 0.5) return 1.0 - inv * inv * inv;                     // cubic
  if (mode < 1.5) return 1.0 - inv * inv * inv * inv * inv;         // quint
  if (mode < 2.5) {                                                  // back
    float c1 = 1.70158;
    return 1.0 - (c1 + 1.0) * inv * inv * inv + c1 * inv * inv;
  }
  return t >= 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * t);                // expo
}

float revealPhase(vec3 c) {
  float h = revealHash11(float(splat.index) + 0.5);
  float mode = uRevealB.x;
  float s;
  if (mode < 0.5)      s = clamp((c.y - uRevealMin.y) * uRevealMin.w, 0.0, 1.0);
  else if (mode < 1.5) s = clamp(length(c.xz - uRevealOrg.xz) * uRevealOrg.w, 0.0, 1.0);
  else if (mode < 2.5) s = clamp(distance(c, uRevealCam.xyz) * uRevealCam.w, 0.0, 1.0);
  else                 s = h;
  return mix(s, h, uRevealA.z);
}

void modifySplatCenter(inout vec3 center) {
  if (uRevealA.w < 0.5) { gRevealE = 1.0; gRevealA = 1.0; return; }

  float phase = revealPhase(center);
  float t = clamp(uRevealA.x - phase * uRevealA.y, 0.0, 1.0);
  gRevealE = revealEase(t, uRevealB.y);
  gRevealA = revealEase(clamp(t + uRevealB.w, 0.0, 1.0), uRevealB.y);

  // Gate: how much of the alpha floor a splat whose window has not opened yet
  // gets. At 1 every splat in the scene is drawn as a dot from the first frame,
  // which on a 2.5M-splat room is not a point cloud, it is fog — millions of
  // 1px quads blending over a 1MP viewport saturate it. At 0 an unstarted splat
  // is invisible, so the bloom is a genuine advancing front with empty space
  // ahead of it, and the GPU only pays for splats actually in flight.
  gRevealFloor = uRevealC.w * (t > 0.0 ? 1.0 : uRevealTint.w);

  // Coupled to (1-e) on purpose. The depth sort runs on work-buffer centres, so
  // displacement here is invisible to it -- but splats are tiny while the offset
  // is large, so they barely overlap and the error cannot be seen. By the time
  // they are big enough to overlap, the offset is gone: the artifact window
  // never opens. Large fly-ins from off-screen WILL break this; small settles
  // will not.
  float mag = uRevealC.x * (1.0 - gRevealE);
  if (mag > 0.0) {
    float dm = uRevealC.y;
    vec3 dir;
    if (dm < 0.5)      dir = normalize(center - uRevealOrg.xyz + vec3(1e-5));
    else if (dm < 1.5) dir = normalize(uRevealCam.xyz - center + vec3(1e-5));
    else               dir = vec3(0.0, -1.0, 0.0);
    center += dir * mag;
  }
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
  scale *= mix(uRevealB.z, 1.0, gRevealE);
}

void modifySplatColor(vec3 center, inout vec4 color) {
  float e = gRevealE;
  if (e >= 1.0) return;
  color.rgb = mix(color.rgb, uRevealTint.rgb, uRevealC.z * (1.0 - e));
  // The floor fights the AA alpha crush on sub-pixel splats and decays out of
  // the way as they reach full size; gRevealA is the lead-ahead opacity ramp.
  color.a = mix(max(color.a, gRevealFloor), color.a, e) * gRevealA;
}
`;

/* ---------------------------------------------------------------------------
   WGSL — WebGPU path. Uniforms are declared `uniform name: type;` and read back
   as `uniform.name`; `splat` is a var<private> declared by gsplatSplatVS.
   --------------------------------------------------------------------------- */
export const REVEAL_WGSL = /* wgsl */ `
uniform uRevealA: vec4f;
uniform uRevealB: vec4f;
uniform uRevealC: vec4f;
uniform uRevealTint: vec4f;
uniform uRevealMin: vec4f;
uniform uRevealOrg: vec4f;
uniform uRevealCam: vec4f;

var<private> gRevealE: f32 = 1.0;
var<private> gRevealA: f32 = 1.0;
var<private> gRevealFloor: f32 = 0.0;

fn revealHash11(pIn: f32) -> f32 {
  var p: f32 = fract(pIn * 0.1031);
  p = p * (p + 33.33);
  p = p * (p + p);
  return fract(p);
}

fn revealEase(t: f32, mode: f32) -> f32 {
  let inv: f32 = 1.0 - t;
  if (mode < 0.5) { return 1.0 - inv * inv * inv; }
  if (mode < 1.5) { return 1.0 - inv * inv * inv * inv * inv; }
  if (mode < 2.5) {
    let c1: f32 = 1.70158;
    return 1.0 - (c1 + 1.0) * inv * inv * inv + c1 * inv * inv;
  }
  return select(1.0 - pow(2.0, -10.0 * t), 1.0, t >= 1.0);
}

fn revealPhase(c: vec3f) -> f32 {
  let h: f32 = revealHash11(f32(splat.index) + 0.5);
  let mode: f32 = uniform.uRevealB.x;
  var s: f32;
  if (mode < 0.5) {
    s = clamp((c.y - uniform.uRevealMin.y) * uniform.uRevealMin.w, 0.0, 1.0);
  } else if (mode < 1.5) {
    s = clamp(length(c.xz - uniform.uRevealOrg.xz) * uniform.uRevealOrg.w, 0.0, 1.0);
  } else if (mode < 2.5) {
    s = clamp(distance(c, uniform.uRevealCam.xyz) * uniform.uRevealCam.w, 0.0, 1.0);
  } else {
    s = h;
  }
  return mix(s, h, uniform.uRevealA.z);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
  if (uniform.uRevealA.w < 0.5) {
    gRevealE = 1.0;
    gRevealA = 1.0;
    return;
  }

  let c: vec3f = *center;
  let phase: f32 = revealPhase(c);
  let t: f32 = clamp(uniform.uRevealA.x - phase * uniform.uRevealA.y, 0.0, 1.0);
  gRevealE = revealEase(t, uniform.uRevealB.y);
  gRevealA = revealEase(clamp(t + uniform.uRevealB.w, 0.0, 1.0), uniform.uRevealB.y);

  // See the GLSL twin for what the gate is for.
  gRevealFloor = uniform.uRevealC.w * select(uniform.uRevealTint.w, 1.0, t > 0.0);

  // See the GLSL twin for why this is coupled to (1 - e).
  let mag: f32 = uniform.uRevealC.x * (1.0 - gRevealE);
  if (mag > 0.0) {
    let dm: f32 = uniform.uRevealC.y;
    var dir: vec3f;
    if (dm < 0.5) {
      dir = normalize(c - uniform.uRevealOrg.xyz + vec3f(1e-5));
    } else if (dm < 1.5) {
      dir = normalize(uniform.uRevealCam.xyz - c + vec3f(1e-5));
    } else {
      dir = vec3f(0.0, -1.0, 0.0);
    }
    *center = c + dir * mag;
  }
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
  *scale = *scale * mix(uniform.uRevealB.z, 1.0, gRevealE);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
  let e: f32 = gRevealE;
  if (e >= 1.0) { return; }
  var c: vec4f = *color;
  c = vec4f(mix(c.rgb, uniform.uRevealTint.rgb, uniform.uRevealC.z * (1.0 - e)), c.a);
  c.a = mix(max(c.a, gRevealFloor), c.a, e) * gRevealA;
  *color = c;
}
`;
