import * as THREE from 'three';

/**
 * Shader warm-up.
 *
 * three.js compiles a material's shader the first time something with it is drawn. In a browser on Windows (ANGLE
 * over D3D11) one lit shader takes 0.1–0.7 s to compile with a cold cache, and the frame waits for it: the first
 * enemy, the first explosion, the boss each froze the game, and the title screen sat frozen for seconds on a first
 * visit. Here everything the game can draw is compiled ahead with KHR_parallel_shader_compile — the driver compiles on
 * its own threads while the page keeps running — against the real scene's lights and fog, through the same
 * render-target state as a frame, so the programs match the ones the frame will ask for.
 *
 * The warm objects are kept and never disposed: a program lives as long as one material uses it, so a stretch of road
 * with no traffic (or a run without a boss) never throws a shader away to compile it again later.
 */
export interface WarmBatch {
  name: string;
  /** objects to compile (not added to any scene) */
  build(): THREE.Object3D[];
  /** whose lights and fog they will be drawn with (default: the world scene) */
  scene?: THREE.Scene;
  /** compile that scene's own contents as well */
  self?: boolean;
  camera?: THREE.Camera;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class ShaderWarmup {
  private keep: THREE.Object3D[] = [];
  private batches: WarmBatch[] = [];
  private running: Promise<void> | null = null;
  done = false;
  /** programs compiled ahead and the wall time it took (perf overlay, benchmark) */
  stats = { programs: 0, ms: 0, batches: 0 };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    /** a render target of the kind the scene is drawn into (the composer's): sets tone mapping and output space */
    private target: () => THREE.WebGLRenderTarget,
  ) {}

  add(batch: WarmBatch) {
    this.batches.push(batch);
  }

  /** Compile everything attached to a scene right now (visible or not). */
  compileScene(scene: THREE.Scene = this.scene, camera: THREE.Camera = this.camera) {
    return this.compile(scene, scene, camera);
  }

  /** Work through the queued batches, one per frame; resolves when all of them are ready to draw. */
  run(): Promise<void> {
    if (!this.running) {
      this.running = (async () => {
        const t0 = performance.now();
        const p0 = this.renderer.info.programs?.length ?? 0;
        await this.compileScene();
        await this.upload(this.scene);
        this.draw(null, this.scene, this.camera);
        while (this.batches.length) {
          const b = this.batches.shift()!;
          await nextFrame();
          const holder = new THREE.Group();
          holder.name = `warm:${b.name}`;
          for (const o of b.build()) holder.add(o);
          if (b.self && b.scene) await this.compileScene(b.scene, b.camera ?? this.camera);
          await this.compile(holder, b.scene ?? this.scene, b.camera ?? this.camera);
          await this.upload(holder);
          this.draw(holder, b.scene ?? this.scene, b.camera ?? this.camera);
          this.keep.push(holder);
          this.stats.batches++;
        }
        this.stats.programs = (this.renderer.info.programs?.length ?? 0) - p0;
        this.stats.ms = Math.round(performance.now() - t0);
        this.done = true;
      })();
    }
    return this.running;
  }

  /**
   * Upload the textures those objects use (a first-use upload stalls the frame too: big canvas textures take
   * milliseconds each). A few milliseconds per frame.
   */
  private async upload(root: THREE.Object3D) {
    const tex = new Set<THREE.Texture>();
    const take = (v: unknown) => {
      if ((v as THREE.Texture | null)?.isTexture) tex.add(v as THREE.Texture);
    };
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        for (const v of Object.values(mat)) take(v);
        const u = (mat as THREE.ShaderMaterial).uniforms;
        if (u) for (const k in u) take(u[k].value);
      }
    });
    let t0 = performance.now();
    for (const t of tex) {
      this.renderer.initTexture(t);
      if (performance.now() - t0 > 4) {
        await nextFrame();
        t0 = performance.now();
      }
    }
  }

  /**
   * One real draw of everything into a tiny target of the frame's format. A linked program is not the whole story: the
   * driver (ANGLE over D3D11 in particular) finishes some of its work on the first draw with real vertex buffers and
   * that render-target format, and that used to land in the middle of a run as a frame with no work of ours in it.
   */
  private drawRT = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType, samples: 0 });
  private draw(holder: THREE.Object3D | null, scene: THREE.Scene, camera: THREE.Camera) {
    if (holder) {
      holder.traverse((o) => (o.frustumCulled = false));
      scene.add(holder);
    }
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.drawRT);
    r.render(scene, camera);
    r.setRenderTarget(prev);
    if (holder) scene.remove(holder);
  }

  private compile(obj: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target());
    // compileAsync creates every program now (cheap calls) and resolves once the driver has finished them
    const p = r.compileAsync(obj, camera, scene);
    r.setRenderTarget(prev);
    return p.then(() => undefined);
  }
}

/** A small mesh that carries a material through the compiler: positions, normals and uvs, like the game's geometry. */
const WARM_GEO = new THREE.BoxGeometry(1, 1, 1);
export function warmMesh(material: THREE.Material) {
  return new THREE.Mesh(WARM_GEO, material);
}
