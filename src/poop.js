import * as THREE from 'three';
import { loadGLTF } from './assets.js';

export const POOP_SIZE = 0.1;      // largest dimension in metres
export const POOP_RADIUS = 0.042;  // collision radius

// Shared uniforms for the animated shader materials (one update per frame for all of them).
const shared = { uTime: { value: 0 } };

/**
 * Injects an object-space height coordinate (0 at the bottom of the swirl, 1 at the tip) into a
 * MeshStandard/Physical material so we can colour it procedurally without depending on the asset's UVs.
 */
function withHeightVarying(material, upAxis, minUp, maxUp, fragmentColorCode) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uMinUp = { value: minUp };
    shader.uniforms.uMaxUp = { value: maxUp };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uMinUp; uniform float uMaxUp; varying float vH; varying vec3 vObj;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvH = (position.${upAxis} - uMinUp) / (uMaxUp - uMinUp); vObj = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; varying float vH; varying vec3 vObj;
        vec3 hsv2rgb(vec3 c){ vec3 p = abs(fract(c.xxx + vec3(0., 2./3., 1./3.)) * 6. - 3.); return c.z * mix(vec3(1.), clamp(p - 1., 0., 1.), c.y); }
        float hash13(vec3 p){ p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${fragmentColorCode}`);
  };
  material.customProgramCacheKey = () => fragmentColorCode;
  return material;
}

/** The five poop styles. Same geometry and physics, only appearance differs. */
export const POOP_TYPES = [
  { id: 'classic', name: 'Classic Brown', swatch: '#7a4422' },
  { id: 'golden', name: 'Golden', swatch: '#ffc93c' },
  { id: 'rainbow', name: 'Rainbow', swatch: 'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)' },
  { id: 'green', name: 'Green Slime', swatch: '#5be33c' },
  { id: 'galaxy', name: 'Galaxy', swatch: 'radial-gradient(circle at 35% 35%, #c58bff, #2a0d5c 70%)' },
];

function makeMaterials(upAxis, minUp, maxUp) {
  const classic = new THREE.MeshPhysicalMaterial({ color: 0x6e3b1d, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.4 });
  const golden = new THREE.MeshStandardMaterial({ color: 0xffc23a, metalness: 1, roughness: 0.22, emissive: 0x3a2400, emissiveIntensity: 0.4 });
  const rainbow = withHeightVarying(
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, clearcoat: 0.6 }),
    upAxis, minUp, maxUp,
    // diagonal hue bands that slowly scroll up the swirl
    `diffuseColor.rgb = hsv2rgb(vec3(fract(vH * 1.25 + (vObj.x + vObj.y) * 0.004 - uTime * 0.15), 0.85, 1.0));`
  );
  const green = new THREE.MeshPhysicalMaterial({
    color: 0x52e02e, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0x0e4a00, emissiveIntensity: 0.6, sheen: 0.6, sheenColor: new THREE.Color(0xd9ff7a),
  });
  const galaxy = withHeightVarying(
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.25, clearcoat: 0.8, emissive: 0xffffff, emissiveIntensity: 1 }),
    upAxis, minUp, maxUp,
    `vec3 base = mix(vec3(0.10, 0.02, 0.25), vec3(0.45, 0.15, 0.85), smoothstep(0.0, 1.0, vH));
     float n = hash13(floor(vObj * 1.6));
     float star = step(0.965, n) * (0.6 + 0.4 * sin(uTime * 4.0 + n * 50.0));
     diffuseColor.rgb = base + star * vec3(1.0, 0.95, 0.8);`
  );
  // Galaxy stars glow: reuse the computed colour as emissive (stars only, via a second injection).
  const galaxyCompile = galaxy.onBeforeCompile;
  galaxy.onBeforeCompile = (shader) => {
    galaxyCompile(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = max(diffuseColor.rgb - vec3(0.5), vec3(0.0)) * 2.0 + diffuseColor.rgb * 0.15;'
    );
  };
  return { classic, golden, rainbow, green, galaxy };
}

/**
 * Loads the poop GLB once and returns a factory. Only the brown body material ("Cafe") is replaced;
 * eyes and mouth keep their original (cloned) materials.
 */
export async function loadPoop(url = 'models/poop.glb') {
  const gltf = await loadGLTF(url);
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = POOP_SIZE / Math.max(size.x, size.y, size.z);

  // Work out which geometry-space axis is "up" for the body so the shaders can colour by height.
  let body = null;
  src.traverse((o) => { if (o.isMesh && o.material.name === 'Cafe' && (!body || o.geometry.attributes.position.count > body.geometry.attributes.position.count)) body = o; });
  if (!body) throw new Error('poop.glb: body material "Cafe" not found');
  const invBody = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const upLocal = new THREE.Vector3(0, 1, 0).transformDirection(invBody);
  const axis = ['x', 'y', 'z'].reduce((a, c) => (Math.abs(upLocal[c]) > Math.abs(upLocal[a]) ? c : a), 'x');
  body.geometry.computeBoundingBox();
  const gb = body.geometry.boundingBox;
  const sign = Math.sign(upLocal[axis]);
  const minUp = sign > 0 ? gb.min[axis] : gb.max[axis];
  const maxUp = sign > 0 ? gb.max[axis] : gb.min[axis];
  const materials = makeMaterials(axis, minUp, maxUp);

  function create() {
    const model = src.clone(true);
    // centre on origin; the eyes face -Z in the asset, so turn it to face +Z (towards the player in the pouch)
    const holder = new THREE.Group();
    model.position.copy(center).multiplyScalar(-1);
    holder.add(model);
    holder.scale.setScalar(s);
    holder.rotation.y = Math.PI;
    const bodies = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material.name === 'Cafe') bodies.push(o);
      else o.material = o.material.clone();
    });
    const jiggle = new THREE.Group();
    jiggle.add(holder);
    const root = new THREE.Group();
    root.add(jiggle);
    const poop = { root, jiggle, bodies, typeId: null, setType(id) {
      const m = materials[id];
      if (!m) return;
      bodies.forEach((b) => { b.material = m; });
      poop.typeId = id;
    } };
    poop.setType('classic');
    return poop;
  }
  return { create, materials };
}

export function tickPoopMaterials(time) { shared.uTime.value = time; }

/**
 * Soft-body feel with a damped spring on a single "stretch" value:
 *   stretch > 0  -> taller & thinner, stretch < 0 -> squashed.
 * Volume is roughly preserved (xz = 1/sqrt(y)). Purely visual: it only touches the jiggle group's scale,
 * never the physics position.
 */
export class Jiggle {
  constructor(group) {
    this.g = group;
    this.s = 0; this.v = 0;   // spring state
    this.target = 0;          // e.g. squash while being pulled
    this.k = 260; this.c = 9; // stiffness / damping
    this.wobble = 0;          // extra side-to-side wobble energy
  }
  impulse(amount) { this.v += amount; this.wobble = Math.min(1, this.wobble + Math.abs(amount) * 0.08); }
  update(dt, t, idle = true) {
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.s - this.target) - this.c * this.v;
      this.v += a * h; this.s += this.v * h;
    }
    this.s = THREE.MathUtils.clamp(this.s, -0.38, 0.38);
    this.wobble *= Math.exp(-dt * 2.5);
    const idleOsc = idle ? 0.035 * Math.sin(t * 7.5) + 0.012 * Math.sin(t * 13.1) : 0;
    const y = 1 + this.s + idleOsc;
    const xz = 1 / Math.sqrt(Math.max(0.4, y));
    this.g.scale.set(xz, y, xz);
    this.g.rotation.z = (idle ? 0.05 * Math.sin(t * 3.3) : 0) + this.wobble * 0.25 * Math.sin(t * 22);
    this.g.rotation.x = this.wobble * 0.15 * Math.sin(t * 17 + 1);
  }
}
