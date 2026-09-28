// Post-processing chain and image-based lighting. Loaded on demand (dynamic import) so the
// Low preset never downloads or compiles any of it. Addons are vendored from three r160 to
// match vendor/three.module.min.js exactly.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Colour grade + vignette, applied after OutputPass (display-space in, display-space out).
// Warm lantern highlights, slightly cooler shadows, gentle S-curve; never crushes the pieces.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.07);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.2, 0.8, l));
      s = s * 0.975 + 0.018;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Hides/shows objects between passes (keeps particles and flat selection decals out of the
// AO normal/depth pass, where they would read as solid geometry).
class VisibilityPass extends Pass {
  constructor(objects, visible) {
    super();
    this.objects = objects;
    this.visible = visible;
    this.needsSwap = false;
  }
  render() {
    for (const o of this.objects) if (o) o.visible = this.visible;
  }
}

/** Build the chain for resolved tiers `g`. Throws if any pass cannot be created. */
export function buildComposer(renderer, scene, camera, g, w, h, ratio, aoExclude = []) {
  const pw = Math.max(1, Math.round(w * ratio)), ph = Math.max(1, Math.round(h * ratio));
  const target = new THREE.WebGLRenderTarget(pw, ph, {
    type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(ratio);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  if (g.ao !== 'off') {
    composer.addPass(new VisibilityPass(aoExclude, false));
    const ao = new GTAOPass(scene, camera, pw, ph);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.blendIntensity = g.ao === 'high' ? 0.85 : 0.7;
    ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
    composer.addPass(ao);
    composer.addPass(new VisibilityPass(aoExclude, true));
  }
  if (g.bloom === 'on') {
    // High threshold: only brass glints, selection rings and sparks bloom.
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.3, 0.35, 0.9));
  }
  composer.addPass(new OutputPass());
  if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
  if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
  if (g.antialias === 'fxaa') {
    const fxaa = new ShaderPass(FXAAShader);
    fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
    composer.addPass(fxaa);
  }
  return composer;
}

/** Pre-filtered neutral room environment for PBR reflections. */
export function makeEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment(renderer);
  const tex = pmrem.fromScene(room, 0.04).texture;
  room.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  pmrem.dispose();
  return tex;
}
