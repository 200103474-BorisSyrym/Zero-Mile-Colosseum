import * as THREE from 'three';
import { BLOOM, EMISSIVE, MATERIAL_CLASSES, TONE } from './visualBudget';

export type ViewMode = 'normal' | 'emissive' | 'lighting' | 'bloom' | 'wireframe' | 'nofog';

/**
 * Debug material views (F1 → VIEW). Temporarily swaps mesh materials to show only what emits, only what is lit,
 * or wireframes; "bloom" shows only the bloom contribution (handled by PostFX); "nofog" removes the fog.
 * Everything is restored when switching back to NORMAL.
 */
export class MaterialViews {
  mode: ViewMode = 'normal';
  private swapped = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private cache = new Map<string, Map<THREE.Material, THREE.Material>>();
  private savedFog: THREE.Fog | THREE.FogExp2 | null = null;
  private fogSaved = false;

  constructor(private scene: THREE.Scene, private setBloomOnly: (on: boolean) => void) {}

  set(mode: ViewMode) {
    this.restore();
    this.mode = mode;
    this.setBloomOnly(mode === 'bloom');
    if (mode === 'nofog') {
      this.savedFog = this.scene.fog;
      this.fogSaved = true;
      this.scene.fog = null;
    }
  }

  /** Called every frame while a material view is active: new road segments stream in all the time. */
  update() {
    if (this.mode !== 'emissive' && this.mode !== 'lighting' && this.mode !== 'wireframe') return;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || this.swapped.has(m) || Array.isArray(m.material)) return;
      const orig = m.material as THREE.Material;
      const rep = this.variant(orig);
      if (!rep) return;
      this.swapped.set(m, orig);
      m.material = rep;
    });
  }

  private variant(orig: THREE.Material): THREE.Material | null {
    let byMode = this.cache.get(this.mode);
    if (!byMode) this.cache.set(this.mode, (byMode = new Map()));
    const hit = byMode.get(orig);
    if (hit) return hit;
    let rep: THREE.Material | null = null;
    const std = orig as THREE.MeshStandardMaterial;
    const basic = orig as THREE.MeshBasicMaterial;
    const vc = !!(orig as THREE.MeshBasicMaterial).vertexColors;
    if (this.mode === 'emissive') {
      if (std.isMeshStandardMaterial) {
        rep = new THREE.MeshBasicMaterial({ color: std.emissive.clone().multiplyScalar(std.emissiveIntensity), map: std.emissiveMap, vertexColors: false });
      } else return null; // unlit materials ARE the emissive ones
    } else if (this.mode === 'lighting') {
      if (std.isMeshStandardMaterial) rep = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: std.roughness, metalness: std.metalness });
      else if (basic.isMeshBasicMaterial) rep = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: basic.transparent, opacity: basic.transparent ? 0 : 1 });
    } else if (this.mode === 'wireframe') {
      if (std.isMeshStandardMaterial) rep = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, wireframe: true });
      else if (basic.isMeshBasicMaterial) rep = new THREE.MeshBasicMaterial({ color: basic.color, wireframe: true, vertexColors: vc });
    }
    if (rep) byMode.set(orig, rep);
    return rep;
  }

  restore() {
    for (const [m, orig] of this.swapped) m.material = orig;
    this.swapped.clear();
    if (this.fogSaved) {
      this.scene.fog = this.savedFog;
      this.fogSaved = false;
    }
    this.setBloomOnly(false);
  }
}

/** Debug material inspector: what a clicked surface is made of and how it sits in the visual budget. */
export function inspectMaterial(hit: THREE.Intersection, scene: THREE.Scene): string {
  const obj = hit.object as THREE.Mesh;
  const mat = (Array.isArray(obj.material) ? obj.material[0] : obj.material) as THREE.Material & Record<string, unknown>;
  const hex = (c: unknown) => (c instanceof THREE.Color ? '#' + c.getHexString() + ` (${c.r.toFixed(2)}, ${c.g.toFixed(2)}, ${c.b.toFixed(2)})` : '—');
  const color = mat.color as THREE.Color | undefined;
  const emissive = mat.emissive as THREE.Color | undefined;
  const ei = (mat.emissiveIntensity as number | undefined) ?? 0;
  const unlit = !(mat as unknown as THREE.MeshStandardMaterial).isMeshStandardMaterial;
  // brightest channel the surface can emit on its own (unlit colour, or emissive × intensity)
  const peak = unlit ? (color ? Math.max(color.r, color.g, color.b) : 0) * ((mat.opacity as number) ?? 1) : emissive ? Math.max(emissive.r, emissive.g, emissive.b) * ei : 0;
  const tier = peak <= 0.01 ? 'none' : peak <= EMISSIVE.SUBTLE + 1e-3 ? 'SUBTLE' : peak <= EMISSIVE.MEDIUM + 1e-3 ? 'MEDIUM' : peak <= EMISSIVE.STRONG + 1e-3 ? 'STRONG' : 'EXTREME';
  const blooms = peak > BLOOM.threshold ? `yes (+${(peak - BLOOM.threshold).toFixed(2)} over threshold)` : 'no';
  // local light: point/spot lights that reach this point
  const lights: string[] = [];
  scene.traverse((o) => {
    const l = o as THREE.PointLight;
    if (!(l.isPointLight || (o as THREE.SpotLight).isSpotLight) || l.intensity <= 0) return;
    const p = l.getWorldPosition(new THREE.Vector3());
    const d = p.distanceTo(hit.point);
    if (l.distance && d > l.distance) return;
    lights.push(`${(o as THREE.SpotLight).isSpotLight ? 'spot' : 'point'} ${d.toFixed(1)}m i${l.intensity.toFixed(0)}`);
  });
  const cls = unlit ? (peak > EMISSIVE.MEDIUM + 1e-3 ? 'MAT_PICKUP/HAZARD/BOSS' : peak > 0.01 ? 'MAT_NEON/LAMP' : 'MAT_DEFAULT') : ei > 0 && emissive && emissive.getHex() !== 0 ? 'MAT_BUILDING' : ((mat.metalness as number) ?? 0) > 0.7 ? 'MAT_METAL' : 'MAT_DEFAULT';
  const c = MATERIAL_CLASSES[cls.split('/')[0]];
  return [
    `<b>MATERIAL</b> ${mat.type}${mat.name ? ' · ' + mat.name : ''} · ${obj.name || obj.parent?.name || 'mesh'} · ${hit.distance.toFixed(1)} m`,
    `base ${hex(color)} · opacity ${((mat.opacity as number) ?? 1).toFixed(2)}${mat.blending === THREE.AdditiveBlending ? ' · ADDITIVE' : ''}`,
    `emissive ${hex(emissive)} × ${ei.toFixed(2)} · peak ${peak.toFixed(2)} → tier ${tier}`,
    `metalness ${((mat.metalness as number) ?? 0).toFixed(2)} · roughness ${((mat.roughness as number) ?? 1).toFixed(2)} · class ${cls}${c ? ` (bloom ${c.bloom})` : ''}`,
    `bloom: ${blooms} · exposure ${TONE.exposure} · local light: ${lights.slice(0, 4).join(', ') || 'none'}`,
  ].join('<br>');
}
