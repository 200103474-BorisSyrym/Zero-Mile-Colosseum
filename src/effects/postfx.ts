import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BLOOM, BLOOM_HIGHPASS_FRAGMENT } from '../render/visualBudget';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';

/** Debug only: keeps a copy of the frame before bloom so the "bloom only" view can show bloom's contribution. */
class SnapshotPass extends Pass {
  rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private mat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms), vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader });
  private quad = new FullScreenQuad(this.mat);
  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = false;
  }
  setSize(w: number, h: number) {
    this.rt.setSize(w, h);
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    this.mat.uniforms.tDiffuse.value = read.texture;
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
  }
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    speed: { value: 0 },
    vignette: { value: 0.45 },
    damage: { value: 0 },
    lowHp: { value: 0 },
    chroma: { value: 0.0012 },
    glitch: { value: 0 },
    emp: { value: 0 },
    radial: { value: 1 },
    grade: { value: new THREE.Vector3(1, 1, 1) },
    contrast: { value: 1.04 },
    lift: { value: new THREE.Color(0.012, 0.012, 0.02) },
    tPre: { value: null as THREE.Texture | null },
    bloomOnly: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float speed; uniform float vignette; uniform float damage;
    uniform float lowHp; uniform float chroma; uniform float glitch; uniform float emp; uniform float radial; uniform vec3 grade; uniform float contrast; uniform vec3 lift; uniform sampler2D tPre; uniform float bloomOnly;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      if (bloomOnly > 0.5) {
        // debug: only what bloom added on top of the scene
        gl_FragColor = vec4(max(texture2D(tDiffuse, uv).rgb - texture2D(tPre, uv).rgb, 0.0) * 2.0, 1.0);
        return;
      }
      if (glitch > 0.0) {
        float row = floor(uv.y * 40.0);
        float g = step(1.0 - glitch * 0.12, h(vec2(row, floor(time * 12.0))));
        uv.x += (h(vec2(row, time)) - 0.5) * 0.06 * g;
      }
      vec2 c = uv - 0.5;
      float r = length(c);
      vec3 col;
      // radial speed blur: only the outer frame smears, the road ahead stays sharp
      float sp = min(speed, 1.0);
      if (radial > 0.5 && sp > 0.05) {
        vec3 acc = vec3(0.0);
        float amt = sp * 0.022 * smoothstep(0.28, 0.7, r);
        for (int i = 0; i < 6; i++) {
          float k = float(i) / 5.0;
          acc += texture2D(tDiffuse, uv - c * amt * k).rgb;
        }
        col = acc / 6.0;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      // chromatic aberration: none at rest — only a hint at top speed, a jolt on a hit, and the zero-mile glitch
      float ca = chroma * (sp * 1.2 + damage * 6.0 + glitch * 4.0);
      col.r = mix(col.r, texture2D(tDiffuse, uv + c * ca).r, 0.8);
      col.b = mix(col.b, texture2D(tDiffuse, uv - c * ca).b, 0.8);
      // grade
      col *= grade;
      // contrast around a low pivot + a tinted shadow lift: night is dark blue/amber, never black
      col = (col - 0.18) * contrast + 0.18;
      col += lift * (1.0 - clamp(col * 5.0, 0.0, 1.0));
      // damage flash & low hp pulse (edges only), emp: the electronics drain the colour, strongest at the edges
      float edge = smoothstep(0.25, 0.75, r);
      col = mix(col, vec3(dot(col, vec3(0.3,0.59,0.11))) * vec3(0.6, 0.9, 1.4), emp * (0.2 + 0.4 * edge));
      col = mix(col, vec3(1.0, 0.05, 0.08), damage * edge * 0.6);
      col = mix(col, vec3(0.6, 0.0, 0.05), lowHp * edge * (0.35 + 0.25 * sin(time * 5.0)));
      // vignette
      col *= 1.0 - vignette * smoothstep(0.35, 0.85, r) - sp * 0.2 * smoothstep(0.4, 0.85, r);
      // grain
      col += (h(uv * 512.0 + time) - 0.5) * 0.025;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export class PostFX {
  composer: EffectComposer;
  renderPass: RenderPass;
  bloom: UnrealBloomPass;
  final: ShaderPass;
  snapshot = new SnapshotPass();
  output: OutputPass;
  quality = 2;
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    // soft-knee, excess-only, per-pixel-capped high pass (see visualBudget): glow, not whiteout
    const hp = this.bloom.materialHighPassFilter;
    hp.uniforms.maxInput = { value: BLOOM.maxInput };
    hp.uniforms.smoothWidth.value = BLOOM.knee;
    hp.fragmentShader = BLOOM_HIGHPASS_FRAGMENT;
    hp.needsUpdate = true;
    this.final = new ShaderPass(FinalShader);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.snapshot);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.final);
    this.composer.addPass(this.output);
  }

  /** Debug view: show only the bloom contribution. */
  setBloomOnly(on: boolean) {
    this.snapshot.enabled = on;
    this.u.bloomOnly.value = on ? 1 : 0;
    this.u.tPre.value = this.snapshot.rt.texture;
  }

  get u() {
    return this.final.uniforms as unknown as typeof FinalShader.uniforms;
  }

  setScene(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  setQuality(q: number, reduced: boolean) {
    this.quality = q;
    this.bloom.enabled = q >= 1;
    this.bloom.strength = q >= 2 ? BLOOM.strength : BLOOM.strengthLow;
    this.u.radial.value = q >= 2 && !reduced ? 1 : 0;
  }

  /**
   * The chain renders at `pr` pixels per CSS pixel. (The composer used to keep the pixel ratio it was created with,
   * 1, whatever the quality setting: the scene was always drawn at CSS resolution and the canvas only upscaled it.)
   */
  setSize(w: number, h: number, pr = 1) {
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const div = this.quality >= 3 ? 1 : 2;
    this.bloom.resolution.set(w / div, h / div);
  }

  render(dt: number) {
    this.u.time.value += dt;
    if (this.quality === 0) {
      // lowest quality: skip bloom & radial blur but keep grading/vignette
      this.bloom.enabled = false;
    }
    this.composer.render(dt);
  }
}
