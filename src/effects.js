import * as THREE from 'three';

function radialTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft contact shadow so virtual objects feel grounded on the real floor. */
export function blobShadow(radius, opacity = 0.45) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(0,0,0,1)'], [1, 'rgba(0,0,0,0)']]), transparent: true, opacity, depthWrite: false })
  );
  m.renderOrder = 1;
  return m;
}

/** Placement reticle (ring + dot). */
export function makeReticle() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x3fc3ff, transparent: true, opacity: 0.9, depthWrite: false }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffcc33, depthWrite: false }));
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 3).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffcc33, depthWrite: false }));
  arrow.position.set(0, 0.01, 0.26); arrow.scale.y = 0.2; // points to the toilet's front (towards the player)
  g.add(ring, dot, arrow);
  g.matrixAutoUpdate = false;
  g.visible = false;
  return g;
}

/** Lightweight particle burst. One pre-allocated Points object, reused for every burst. */
export class Burst {
  constructor(count = 60) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.03, vertexColors: true, transparent: true, depthWrite: false,
      map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]),
      blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.t = 0;
  }
  fire(at, colors, { up = 2.2, spread = 1.2 } = {}) {
    const c = new THREE.Color();
    for (let i = 0; i < this.n; i++) {
      this.pos.set([at.x, at.y, at.z], i * 3);
      const a = Math.random() * Math.PI * 2, s = Math.random() * spread;
      this.vel.set([Math.cos(a) * s, up * (0.5 + Math.random() * 0.7), Math.sin(a) * s], i * 3);
      c.set(colors[i % colors.length]);
      this.col.set([c.r, c.g, c.b], i * 3);
    }
    this.points.geometry.attributes.color.needsUpdate = true;
    this.points.visible = true; this.t = 0;
    this.points.material.opacity = 1;
  }
  update(dt) {
    if (!this.points.visible) return;
    this.t += dt;
    for (let i = 0; i < this.n; i++) {
      this.vel[i * 3 + 1] -= 9.81 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.material.opacity = Math.max(0, 1 - this.t / 1.1);
    if (this.t > 1.1) this.points.visible = false;
  }
}
