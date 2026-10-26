import * as THREE from "three";

// Lightweight driving effects:
// - SkidMarks: a fixed-size ring buffer of quads (one draw call). New marks overwrite the oldest.
// - Particles: a pooled THREE.Points cloud for tire smoke and grass dust, with per-particle
//   size and alpha in a tiny shader. No allocations after construction.

const MAX_SKID_QUADS = 2400;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly alphas: Float32Array;
  private next = 0;
  private readonly last: (THREE.Vector3 | null)[] = [null, null];

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_SKID_QUADS * 4 * 3);
    this.alphas = new Float32Array(MAX_SKID_QUADS * 4);
    const index = new Uint32Array(MAX_SKID_QUADS * 6);
    for (let i = 0; i < MAX_SKID_QUADS; i++) {
      const v = i * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "alpha",
      new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      vertexShader: `attribute float alpha; varying float vAlpha;
        void main() { vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float vAlpha;
        void main() { gl_FragColor = vec4(0.09, 0.09, 0.1, vAlpha * 0.55); }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Call every frame for each rear wheel; `intensity` 0 lifts the pen. */
  add(wheel: 0 | 1, p: THREE.Vector3, intensity: number) {
    const last = this.last[wheel];
    if (intensity <= 0.05) {
      this.last[wheel] = null;
      return;
    }
    if (!last) {
      this.last[wheel] = p.clone();
      return;
    }
    const dx = p.x - last.x;
    const dz = p.z - last.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.15) return;
    if (len > 3) {
      // Teleport (reset): start a new mark instead of drawing a streak across the map.
      last.copy(p);
      return;
    }
    const w = 0.13;
    const nx = (-dz / len) * w;
    const nz = (dx / len) * w;
    // Just above the road surface (p.y is the ground height under the wheel).
    const y0 = last.y + 0.035;
    const y1 = p.y + 0.035;
    const i = this.next;
    const o = i * 12;
    this.positions.set(
      [
        last.x + nx,
        y0,
        last.z + nz,
        last.x - nx,
        y0,
        last.z - nz,
        p.x + nx,
        y1,
        p.z + nz,
        p.x - nx,
        y1,
        p.z - nz,
      ],
      o,
    );
    const a = Math.min(1, intensity);
    this.alphas.set([a, a, a, a], i * 4);
    this.next = (this.next + 1) % MAX_SKID_QUADS;
    const geo = this.mesh.geometry;
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("alpha").needsUpdate = true;
    last.copy(p);
  }

  clear() {
    this.alphas.fill(0);
    this.mesh.geometry.getAttribute("alpha").needsUpdate = true;
    this.last[0] = this.last[1] = null;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const MAX_PARTICLES = 160;

export class Particles {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly color: Float32Array;
  private cursor = 0;

  constructor() {
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES).fill(1);
    this.size = new Float32Array(MAX_PARTICLES);
    this.alpha = new Float32Array(MAX_PARTICLES);
    this.color = new Float32Array(MAX_PARTICLES * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "size",
      new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "alpha",
      new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "color",
      new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { scale: { value: 400 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color;
        uniform float scale; varying float vAlpha; varying vec3 vColor;
        void main() {
          vAlpha = alpha; vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vAlpha; varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.15, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setViewportHeight(px: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale!.value = px * 0.5;
  }

  emit(p: THREE.Vector3, vx: number, vz: number, kind: "smoke" | "dust") {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.2;
    this.pos[i * 3 + 1] = p.y + 0.15;
    this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.2;
    this.vel[i * 3] = vx * 0.15 + (Math.random() - 0.5) * 0.8;
    this.vel[i * 3 + 1] = 0.6 + Math.random() * 0.6;
    this.vel[i * 3 + 2] = vz * 0.15 + (Math.random() - 0.5) * 0.8;
    const life = kind === "smoke" ? 0.9 + Math.random() * 0.5 : 0.5 + Math.random() * 0.3;
    this.life[i] = life;
    this.maxLife[i] = life;
    const c = kind === "smoke" ? [0.93, 0.93, 0.92] : [0.55, 0.46, 0.3];
    this.color.set(c, i * 3);
  }

  update(dt: number) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i]! <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i]! -= dt;
      const t = 1 - Math.max(0, this.life[i]!) / this.maxLife[i]!;
      this.pos[i * 3]! += this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1]! += this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2]! += this.vel[i * 3 + 2]! * dt;
      this.vel[i * 3]! *= 1 - 2 * dt;
      this.vel[i * 3 + 2]! *= 1 - 2 * dt;
      this.size[i] = 0.5 + t * 1.6;
      this.alpha[i] = (1 - t) * 0.45;
    }
    const geo = this.points.geometry;
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("size").needsUpdate = true;
    geo.getAttribute("alpha").needsUpdate = true;
    geo.getAttribute("color").needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
