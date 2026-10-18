import * as THREE from 'three';
import { POOP_RADIUS } from './poop.js';

// One set of constants drives BOTH the live projectile and the trajectory preview.
export const PHYS = {
  gravity: 9.81,          // m/s^2
  dt: 1 / 120,            // fixed simulation step
  minPull: 0.035,         // below this a release just snaps back
  maxPull: 0.32,          // pull distance is clamped here
  minSpeed: 1.5,          // m/s at minPull
  maxSpeed: 6.5,          // m/s at maxPull (≈4–5 m range: enough for a room)
  restitution: 0.32,
  friction: 0.55,
  bowlFactor: 0.82,       // shrink the measured bowl ellipse so rim grazes don't count
};

/** Launch velocity from the pull vector (pouch offset from its rest point). Opposite to the pull. */
export function launchVelocity(pull, out = new THREE.Vector3()) {
  const len = pull.length();
  if (len < PHYS.minPull) return out.set(0, 0, 0);
  const t = THREE.MathUtils.clamp((len - PHYS.minPull) / (PHYS.maxPull - PHYS.minPull), 0, 1);
  const speed = THREE.MathUtils.lerp(PHYS.minSpeed, PHYS.maxSpeed, t);
  return out.copy(pull).multiplyScalar(-speed / len);
}

/** Semi-implicit Euler, identical for preview and flight. */
export function step(p, v, dt = PHYS.dt) {
  v.y -= PHYS.gravity * dt;
  p.addScaledVector(v, dt);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * The world the projectile can hit: a floor plane and (optionally) the placed toilet.
 * Toilet collision uses its local frame: two boxes for the body, plus an elliptical scoring opening
 * on top of the front box. A shot scores only when the poop's centre crosses the rim plane downwards
 * inside that opening.
 */
export class World {
  constructor() {
    this.floorY = 0;
    this.toilet = null;   // { root: Object3D, bowl, boxes }
    this.inv = new THREE.Matrix4();
  }
  setToilet(t) { this.toilet = t; this.refresh(); }
  refresh() {
    if (!this.toilet) return;
    this.toilet.root.updateMatrixWorld(true);
    this.inv.copy(this.toilet.root.matrixWorld).invert();
    this.scale = this.toilet.root.getWorldScale(_a).x;
  }

  /**
   * Checks the segment prev -> p (world) for an event. May modify p/v for bounces.
   * Returns null | { type: 'score' | 'floor' | 'toilet', point }
   */
  collide(prev, p, v) {
    if (this.toilet) {
      const r = POOP_RADIUS / this.scale;
      const lp = _a.copy(p).applyMatrix4(this.inv);
      const lprev = _b.copy(prev).applyMatrix4(this.inv);
      const { bowl, boxes } = this.toilet;

      // 1) Entering the bowl opening from above?
      const ex = (lp.x - bowl.x) / (bowl.rx * PHYS.bowlFactor);
      const ez = (lp.z - bowl.z) / (bowl.rz * PHYS.bowlFactor);
      const insideOpening = ex * ex + ez * ez < 1;
      if (insideOpening && lprev.y >= bowl.rimY && lp.y < bowl.rimY && v.y < 0) {
        return { type: 'score', point: p.clone() };
      }

      // 2) Solid body: push out along the axis of least penetration and bounce.
      for (const bx of boxes) {
        if (lp.x > bx.min.x - r && lp.x < bx.max.x + r && lp.y > bx.min.y - r && lp.y < bx.max.y + r && lp.z > bx.min.z - r && lp.z < bx.max.z + r) {
          if (bx.hasBowl && insideOpening) continue; // falling into the opening is handled above
          const pens = [
            ['x', -1, lp.x - (bx.min.x - r)], ['x', 1, bx.max.x + r - lp.x],
            ['y', -1, lp.y - (bx.min.y - r)], ['y', 1, bx.max.y + r - lp.y],
            ['z', -1, lp.z - (bx.min.z - r)], ['z', 1, bx.max.z + r - lp.z],
          ].sort((m, n) => m[2] - n[2]);
          const [axis, dir, depth] = pens[0];
          lp[axis] += dir * depth;
          const n = new THREE.Vector3(); n[axis] = dir;
          n.transformDirection(this.toilet.root.matrixWorld);
          p.copy(lp.applyMatrix4(this.toilet.root.matrixWorld));
          const vn = v.dot(n);
          if (vn < 0) {
            v.addScaledVector(n, -(1 + PHYS.restitution) * vn);
            v.multiplyScalar(0.8);
          }
          return { type: 'toilet', point: p.clone() };
        }
      }
    }

    // 3) Floor
    if (p.y - POOP_RADIUS < this.floorY) {
      p.y = this.floorY + POOP_RADIUS;
      if (v.y < 0) v.y = -v.y * PHYS.restitution;
      v.x *= PHYS.friction; v.z *= PHYS.friction;
      return { type: 'floor', point: p.clone() };
    }
    return null;
  }
}

/**
 * Dotted trajectory preview. Pre-allocated buffers; the arc is produced by running the exact same
 * step()/collide() code as the real projectile, so it never disagrees with the flight.
 */
export class Trajectory {
  constructor(maxPoints = 70) {
    this.max = maxPoints;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxPoints * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const dot = document.createElement('canvas'); dot.width = dot.height = 64;
    const g = dot.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.55, 'rgba(160,230,255,1)'); grad.addColorStop(1, 'rgba(60,180,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    this.material = new THREE.PointsMaterial({ size: 0.028, map: new THREE.CanvasTexture(dot), transparent: true, depthWrite: false, color: 0x9fe6ff });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;

    // landing marker
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.035, 0.05, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
    );
    this.marker.renderOrder = 5;
    this.group = new THREE.Group();
    this.group.add(this.points, this.marker);
    this.group.visible = false;
    this._p = new THREE.Vector3(); this._v = new THREE.Vector3(); this._prev = new THREE.Vector3();
  }

  /** Simulate from (start, vel). Returns the predicted outcome ('score' | 'floor' | 'toilet' | null). */
  update(world, start, vel, maxTime = 2.5) {
    const p = this._p.copy(start), v = this._v.copy(vel), prev = this._prev;
    const every = 2; // record one dot every N physics steps
    let n = 0, result = null;
    const steps = Math.floor(maxTime / PHYS.dt);
    for (let i = 0; i < steps && n < this.max; i++) {
      prev.copy(p);
      step(p, v);
      const hit = world.collide(prev, p, v);
      if (i % every === 0 || hit) {
        this.positions[n * 3] = p.x; this.positions[n * 3 + 1] = p.y; this.positions[n * 3 + 2] = p.z;
        n++;
      }
      if (hit) { result = hit.type; break; }
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
    const col = result === 'score' ? 0x7be35a : result === 'toilet' ? 0xffb347 : 0x9fe6ff;
    this.material.color.setHex(col);
    this.marker.material.color.setHex(col);
    this.marker.visible = !!result;
    if (result) this.marker.position.set(p.x, result === 'floor' ? world.floorY + 0.003 : p.y, p.z);
    return result;
  }
  show(v) { this.group.visible = v; }
}
