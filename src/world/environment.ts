import * as THREE from 'three';
import type { ZoneDef } from '../data/zones';
import { glow, LIGHTS, REFLECTIONS, SKY } from '../render/visualBudget';
import { gridTexture, radialTexture, skylineTexture } from './textures';
import { beamGeometry, beamMaterial } from '../effects/lightBeams';

/** Sky dome, distant skyline, ground plane, rain, global lights and the reflection environment. */
export class Environment {
  readonly group = new THREE.Group();
  hemi: THREE.HemisphereLight;
  moon: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  /** soft light from the camera side: the backs of cars ahead are always readable */
  fill: THREE.DirectionalLight;
  /** from ahead and above, tinted by the zone: outlines cars and building edges against the haze */
  rim: THREE.DirectionalLight;
  /** a small pool of real lights that follows the nearest street lamps, so lamps light cars and props */
  private lampLights: THREE.PointLight[] = [];
  private hemiBase = 1;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private skyline: THREE.Mesh;
  private skylineMat: THREE.MeshBasicMaterial;
  /** a nearer, darker band of the skyline in front of the far one: two depths of city on the horizon */
  private skylineMid: THREE.Mesh;
  private skylineMidMat: THREE.MeshBasicMaterial;
  private ground: THREE.Mesh;
  private groundMat: THREE.MeshStandardMaterial;
  private gridFloor: THREE.Mesh;
  private gridMat: THREE.MeshBasicMaterial;
  private rain: THREE.LineSegments;
  private rainMat: THREE.ShaderMaterial;
  private moonSprite: THREE.Sprite;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** life in the sky: aircraft crossing with blinking lights, searchlights sweeping over the city */
  private aircraft: { obj: THREE.Group; light: THREE.Mesh; vx: number; vz: number; ph: number }[] = [];
  private searchlights: THREE.Mesh[] = [];
  private skyLife = new THREE.Group();
  rainAmount = 0.6;
  private flash = 0;
  private flashTimer = 8;
  zone: ZoneDef | null = null;
  reduced = false;

  constructor(private scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    scene.add(this.group);

    this.hemi = new THREE.HemisphereLight(0x8090ff, 0x201010, 1);
    this.ambient = new THREE.AmbientLight(0x404050, 0.5);
    this.moon = new THREE.DirectionalLight(0xa0b8ff, 0.7);
    this.moon.position.set(-60, 120, 40);
    this.fill = new THREE.DirectionalLight(0xb0c0ff, 0.45);
    this.rim = new THREE.DirectionalLight(0xffffff, 0.6);
    scene.add(this.hemi, this.ambient, this.moon, this.moon.target, this.fill, this.fill.target, this.rim, this.rim.target);
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffa040, 0, LIGHTS.streetLamp.distance, LIGHTS.streetLamp.decay);
      l.position.set(0, -100, 0);
      this.lampLights.push(l);
      scene.add(l);
    }

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() }, time: { value: 0 }, glitch: { value: 0 }, cloud: { value: new THREE.Color() }, cloudAmt: { value: 0.6 } },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform float time; uniform float glitch; uniform vec3 cloud; uniform float cloudAmt; varying vec3 vP;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1,0)), f.x), mix(h(i + vec2(0,1)), h(i + vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * n2(p); p *= 2.03; a *= 0.5; } return s; }
        void main(){
          float t = clamp(vP.y * 1.6 + 0.12, 0.0, 1.0);
          vec3 c = mix(bottom, top, pow(t, 0.7));
          // stars
          vec2 g = floor(vP.xz / max(vP.y, 0.05) * 140.0);
          float st = step(0.997, h(g)) * smoothstep(0.15, 0.5, vP.y);
          // low cloud deck lit from below by the city: dense near the horizon, broken higher up
          vec2 cp = vP.xz / max(vP.y + 0.12, 0.06) * 1.4 + vec2(time * 0.004, time * 0.002);
          float cl = smoothstep(0.42, 0.78, fbm(cp)) * smoothstep(0.62, 0.04, vP.y) * smoothstep(-0.02, 0.05, vP.y);
          float glowUnder = smoothstep(0.5, 0.0, vP.y);
          c = mix(c, cloud * (0.55 + 0.75 * glowUnder), cl * cloudAmt);
          st *= 1.0 - cl;
          c += vec3(st) * (0.5 + 0.5 * sin(time * 2.0 + h(g) * 40.0));
          if (glitch > 0.0) {
            float band = step(0.985, h(vec2(floor(vP.y * 60.0), floor(time * 4.0))));
            c += vec3(1.0, 0.1, 0.3) * band * glitch * 0.6;
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.group.add(this.sky);

    this.skylineMat = new THREE.MeshBasicMaterial({ map: skylineTexture(), transparent: true, depthWrite: false, fog: false, side: THREE.BackSide });
    this.skylineMat.map!.repeat.set(5, 1);
    this.skyline = new THREE.Mesh(new THREE.CylinderGeometry(760, 760, 240, 48, 1, true), this.skylineMat);
    this.skyline.position.y = 70;
    this.skyline.renderOrder = -9;
    this.group.add(this.skyline);
    const midTex = skylineTexture().clone();
    midTex.needsUpdate = true;
    midTex.repeat.set(7, 1);
    midTex.offset.set(0.37, 0);
    this.skylineMidMat = new THREE.MeshBasicMaterial({ map: midTex, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide });
    this.skylineMid = new THREE.Mesh(new THREE.CylinderGeometry(520, 520, 150, 48, 1, true), this.skylineMidMat);
    this.skylineMid.renderOrder = -8;
    this.group.add(this.skylineMid);

    const moonMat = new THREE.SpriteMaterial({ map: radialTexture('moon', 'rgba(255,255,255,1)', 'rgba(200,220,255,0.25)'), color: glow(0xc8d8ff, SKY.moon), fog: false, depthWrite: false });
    this.moonSprite = new THREE.Sprite(moonMat);
    this.moonSprite.scale.set(90, 90, 1);
    this.group.add(this.moonSprite);

    this.groundMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 0.95 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.4;
    this.group.add(this.ground);

    this.gridMat = new THREE.MeshBasicMaterial({ map: gridTexture(), color: 0xff1040, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    this.gridMat.map!.repeat.set(120, 120);
    this.gridFloor = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), this.gridMat);
    this.gridFloor.rotation.x = -Math.PI / 2;
    this.gridFloor.position.y = -72;
    this.group.add(this.gridFloor);

    // rain: line segments around the camera, animated fully in the vertex shader
    const N = 1700;
    const pos = new Float32Array(N * 2 * 3);
    const seed = new Float32Array(N * 2);
    const end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 80, y = Math.random() * 40, z = (Math.random() - 0.5) * 80;
      for (let k = 0; k < 2; k++) {
        pos.set([x, y, z], (i * 2 + k) * 3);
        seed[i * 2 + k] = Math.random();
        end[i * 2 + k] = k;
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    rg.setAttribute('isEnd', new THREE.BufferAttribute(end, 1));
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, cam: { value: new THREE.Vector3() }, vel: { value: new THREE.Vector3() }, amount: { value: 0.6 }, color: { value: new THREE.Color(0x8a9cc0) } },
      vertexShader: `
        attribute float seed; attribute float isEnd;
        uniform float time; uniform vec3 cam; uniform vec3 vel; uniform float amount;
        varying float vA;
        void main(){
          vec3 p = position;
          float fall = 34.0 + seed * 10.0;
          p.y = mod(p.y - time * fall, 40.0) - 12.0;
          p.x = mod(p.x - cam.x + 40.0, 80.0) - 40.0;
          p.z = mod(p.z - cam.z + 40.0, 80.0) - 40.0;
          vec3 streak = vec3(0.0, fall, 0.0) + vel;
          p -= streak * 0.022 * isEnd;
          vec3 w = p + vec3(cam.x, cam.y, cam.z);
          vA = step(seed, amount) * (0.04 + 0.13 * isEnd) * smoothstep(2.0, 9.0, length(p.xz));
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: `uniform vec3 color; varying float vA; void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(color, vA); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.group.add(this.rain);

    // aircraft: a dark body and a blinking beacon, drifting across at altitude
    this.group.add(this.skyLife);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x050508, fog: false });
    const red = new THREE.MeshBasicMaterial({ color: glow(0xff2030, 2.2), fog: false });
    const white = new THREE.MeshBasicMaterial({ color: glow(0xffffff, 2.2), fog: false });
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 12), bodyMat);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(14, 0.3, 2.4), bodyMat);
      const l = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), i % 2 ? red : white);
      l.position.set(0, -0.8, 0);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), red);
      tip.position.set(7, 0, 0);
      g.add(b, wing, l, tip);
      const a = Math.random() * Math.PI * 2;
      g.position.set(Math.cos(a) * 400, 170 + i * 45, Math.sin(a) * 400);
      const dir = a + Math.PI + (Math.random() - 0.5);
      this.aircraft.push({ obj: g, light: l, vx: Math.cos(dir) * 28, vz: Math.sin(dir) * 28, ph: Math.random() * 6 });
      g.rotation.y = Math.atan2(Math.cos(dir), Math.sin(dir));
      this.skyLife.add(g);
    }
    // searchlights: tall soft cones from the city floor, sweeping slowly
    // (fake volumetric: no silhouette, thickest through the middle, fading up into the sky)
    const beamMat = beamMaterial(0xbfd8ff, 0.14, 0.8, 0.45);
    const beamGeo = beamGeometry(420, 1.4, 18, 16).rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(beamGeo, beamMat);
      m.userData.ph = i * 2.1;
      this.searchlights.push(m);
      this.skyLife.add(m);
    }
  }

  setZone(zone: ZoneDef, renderer: THREE.WebGLRenderer) {
    this.zone = zone;
    this.scene.fog = new THREE.FogExp2(zone.fog, zone.fogDensity);
    this.scene.background = new THREE.Color(zone.skyBottom);
    this.skyMat.uniforms.top.value.setHex(zone.skyTop);
    this.skyMat.uniforms.bottom.value.setHex(zone.skyBottom);
    this.skyMat.uniforms.glitch.value = zone.id === 'zeromile' ? 1 : 0;
    // clouds take the glow of the city under them: sodium orange, flood teal, violet, steel blue, blood red
    this.skyMat.uniforms.cloud.value.setHex(zone.skyBottom).lerp(new THREE.Color(zone.streetLight), 0.25).multiplyScalar(1.35);
    this.skyMat.uniforms.cloudAmt.value = zone.elevated ? 0.45 : 0.75;
    this.skylineMat.color.setHex(zone.id === 'zeromile' ? 0xff5080 : 0xffffff);
    this.skylineMat.opacity = zone.elevated ? 0.5 : 0.85;
    // the far band fades into the haze, the near band is darker and denser
    this.skylineMat.color.lerp(new THREE.Color(zone.fog), 0.35);
    this.skylineMidMat.color.setHex(zone.id === 'zeromile' ? 0xc04060 : 0xb8b8b8).multiplyScalar(0.85);
    this.skylineMidMat.opacity = zone.elevated ? 0.55 : 0.95;
    // night is coloured, not black: sky fill takes the zone's main neon, bounce takes the fog
    this.hemi.color.setHex(zone.ambient).lerp(new THREE.Color(zone.neon[0]), 0.3).multiplyScalar(1.6);
    this.hemi.groundColor.setHex(zone.fog).multiplyScalar(1.4);
    this.hemiBase = zone.elevated ? 1.25 : 1.05;
    this.ambient.color.setHex(zone.ambient);
    this.moon.color.setHex(zone.neon[zone.neon.length - 1]).lerp(new THREE.Color(0xc0d0ff), 0.6);
    this.fill.color.setHex(zone.ambient).lerp(new THREE.Color(0xffffff), 0.6);
    this.rim.color.setHex(zone.neon[0]).lerp(new THREE.Color(0xffffff), 0.45);
    this.rim.intensity = zone.elevated ? 0.75 : 0.6;
    for (const l of this.lampLights) l.color.setHex(zone.streetLight);
    this.rainAmount = zone.rain;
    for (const m of this.searchlights) m.visible = zone.id === 'oldcity' || zone.id === 'skyway' || zone.id === 'zeromile';
    if (this.searchlights[0]) (this.searchlights[0].material as ReturnType<typeof beamMaterial>).uniforms.color.value.setHex(zone.id === 'zeromile' ? 0xff4060 : zone.id === 'oldcity' ? 0xd0a0ff : 0xbfd8ff);
    this.ground.visible = !zone.elevated;
    this.groundMat.color.setHex(zone.id === 'flood' ? 0x020508 : 0x0a0a0d);
    this.groundMat.roughness = zone.id === 'flood' ? 0.1 : 0.95;
    this.groundMat.metalness = zone.id === 'flood' ? 0.9 : 0;
    this.gridFloor.visible = zone.elevated;
    this.gridMat.color.setHex(zone.id === 'zeromile' ? 0xff1040 : 0x3060ff);
    this.rainMat.uniforms.color.value.setHex(zone.id === 'zeromile' ? 0xff6090 : 0x9ab0d0);
    this.buildEnvMap(zone, renderer);
  }

  /** Small neon "room" baked into a PMREM so wet surfaces and car paint pick up coloured reflections. */
  private buildEnvMap(zone: ZoneDef, renderer: THREE.WebGLRenderer) {
    const s = new THREE.Scene();
    s.background = new THREE.Color(zone.skyBottom).multiplyScalar(0.6);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    zone.neon.forEach((c, i) => {
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(REFLECTIONS.envNeon) }));
        const a = (i / zone.neon.length) * Math.PI * 2 + k * 2.1;
        m.position.set(Math.cos(a) * 8, 1 + k * 2.5, Math.sin(a) * 8);
        m.scale.set(3 + k, 0.6, 0.4);
        m.lookAt(0, 0, 0);
        s.add(m);
      }
    });
    const top = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(zone.streetLight).multiplyScalar(REFLECTIONS.envTop) }));
    top.position.set(0, 10, 0);
    top.scale.set(6, 0.2, 6);
    s.add(top);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(s, 0.04);
    this.scene.environment = this.envRT.texture;
    s.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
    geo.dispose();
  }

  update(dt: number, camera: THREE.Camera, time: number, playerVel: { x: number; z: number }) {
    const cp = camera.position;
    this.sky.position.set(cp.x, 0, cp.z);
    this.skyline.position.set(cp.x, this.zone?.elevated ? -40 : 70, cp.z);
    this.skylineMid.position.set(cp.x, this.zone?.elevated ? -55 : 42, cp.z);
    this.moonSprite.position.set(cp.x - 300, 380, cp.z + 520);
    this.ground.position.set(cp.x, -0.4, cp.z);
    this.gridFloor.position.set(cp.x, -72, cp.z);
    this.gridMat.map!.offset.set(cp.x / 20, -cp.z / 20);
    this.skyMat.uniforms.time.value = time;
    this.moon.position.set(cp.x - 60, 120, cp.z + 40);
    this.moon.target.position.set(cp.x, 0, cp.z);
    this.rainMat.uniforms.time.value = time;
    // sky life follows the camera like the skyline does, moving on its own
    for (const a of this.aircraft) {
      a.obj.position.x += a.vx * dt;
      a.obj.position.z += a.vz * dt;
      const dx = a.obj.position.x - cp.x, dz = a.obj.position.z - cp.z;
      if (Math.hypot(dx, dz) > 700) {
        const ang = Math.random() * Math.PI * 2;
        a.obj.position.set(cp.x + Math.cos(ang) * 600, a.obj.position.y, cp.z + Math.sin(ang) * 600);
        const dir = ang + Math.PI + (Math.random() - 0.5);
        a.vx = Math.cos(dir) * 28;
        a.vz = Math.sin(dir) * 28;
        a.obj.rotation.y = Math.atan2(a.vx, a.vz);
      }
      a.light.visible = Math.sin(time * 3 + a.ph) > 0.6;
    }
    this.searchlights.forEach((m, i) => {
      const ph = (m.userData.ph as number) + time * 0.16;
      m.position.set(cp.x + Math.cos(i * 2.4 + 0.6) * 420, -20, cp.z + Math.sin(i * 2.4 + 0.6) * 420 + 200);
      m.rotation.set(Math.sin(ph) * 0.45, 0, Math.cos(ph * 0.7) * 0.4);
    });
    this.rainMat.uniforms.cam.value.copy(cp);
    this.rainMat.uniforms.vel.value.set(-playerVel.x, 0, -playerVel.z);
    this.rainMat.uniforms.amount.value = this.reduced ? this.rainAmount * 0.4 : this.rainAmount;

    // lightning in rainy zones
    if (this.zone && this.zone.rain > 0.7 && !this.reduced) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.flash = 1;
        this.flashTimer = 6 + Math.random() * 10;
      }
    }
    this.flash = Math.max(0, this.flash - dt * 3);
    const f = this.flash > 0 ? this.flash * (0.6 + 0.4 * Math.sin(time * 60)) : 0;
    this.hemi.intensity = this.hemiBase + f * 2.5;
    // fill comes from slightly above and behind the camera
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    this.fill.position.set(cp.x - fx * 20, cp.y + 14, cp.z - fz * 20);
    this.fill.target.position.set(cp.x + fx * 30, 0, cp.z + fz * 30);
    this.rim.position.set(cp.x + fx * 50, cp.y + 26, cp.z + fz * 50);
    this.rim.target.position.set(cp.x - fx * 10, 0, cp.z - fz * 10);
  }

  private camYaw = 0;
  /** Camera heading, used to aim the fill light. */
  setCameraYaw(yaw: number) {
    this.camYaw = yaw;
  }

  /** Move the light pool onto the street lamps nearest the player, fading by distance so nothing pops. */
  private lampD: number[] = [];
  private lampOrder: number[] = [];
  placeLamps(lamps: { x: number; y: number; z: number }[], px: number, pz: number) {
    // nearest first: a stable insertion sort over reused arrays (a handful of lamps, every frame, no garbage)
    const n = lamps.length, d = this.lampD, ord = this.lampOrder;
    for (let i = 0; i < n; i++) {
      d[i] = Math.hypot(lamps[i].x - px, lamps[i].z - pz);
      let j = i - 1;
      while (j >= 0 && d[ord[j]] > d[i]) {
        ord[j + 1] = ord[j];
        j--;
      }
      ord[j + 1] = i;
    }
    for (let i = 0; i < this.lampLights.length; i++) {
      const light = this.lampLights[i];
      if (i >= n || this.reduced) {
        light.intensity = 0;
        continue;
      }
      const l = lamps[ord[i]], dist = d[ord[i]];
      light.position.set(l.x, l.y, l.z);
      light.intensity = LIGHTS.streetLamp.intensity * (1 - Math.min(1, Math.max(0, (dist - 45) / 40))) * this.lampFlicker(l.x, l.z);
    }
  }

  clearLamps() {
    for (const l of this.lampLights) l.intensity = 0;
  }

  private stutters: { x: number; z: number; r: number; t0: number }[] = [];
  /** An energy pulse at (x, z): the lamps around it cut out, then stutter back, the far ones a beat later. */
  stutterLamps(x: number, z: number, r: number) {
    this.stutters.push({ x, z, r: r * 1.8 + 10, t0: performance.now() / 1000 });
  }
  /** 0..1: how lit a lamp at (x, z) is right now. */
  lampFlicker(x: number, z: number) {
    if (!this.stutters.length) return 1;
    const now = performance.now() / 1000;
    let k = 1;
    for (let i = this.stutters.length - 1; i >= 0; i--) {
      const s = this.stutters[i];
      const age = now - s.t0;
      if (age > 1.4) {
        this.stutters.splice(i, 1);
        continue;
      }
      const d = Math.hypot(x - s.x, z - s.z);
      if (d > s.r) continue;
      const a = age - d / 70;
      if (a < 0) continue;
      const out = a < 0.12 || Math.sin(now * 53 + x * 1.7 + z * 2.3) > 0.1 + a * 0.9;
      k = Math.min(k, out ? 0.08 : Math.min(1, 0.35 + a * 0.6));
    }
    return k;
  }
}
