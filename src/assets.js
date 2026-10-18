import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Real-world target height for every toilet (metres). Proportions are preserved; only a uniform scale is applied.
export const TOILET_HEIGHT = 0.8;

const loader = new GLTFLoader();
const gltfCache = new Map(); // url -> Promise<gltf>

export function loadGLTF(url) {
  if (!gltfCache.has(url)) {
    const p = loader.loadAsync(url).catch((err) => {
      gltfCache.delete(url); // allow a retry later
      throw new Error(`Could not load ${url}: ${err.message || err}`);
    });
    gltfCache.set(url, p);
  }
  return gltfCache.get(url);
}

export async function loadToiletManifest() {
  const res = await fetch('models/toilets.json');
  if (!res.ok) throw new Error(`models/toilets.json: HTTP ${res.status}`);
  return (await res.json()).toilets;
}

/**
 * Builds a normalised toilet "template" from a GLB:
 *  - uniform scale to TOILET_HEIGHT
 *  - base moved to y = 0 and footprint centred on x/z (computed from the bounding box, not assumed from the pivot)
 *  - front faces +Z
 * Also converts the measured bowl opening and derives simple collision boxes in the same normalised space.
 */
export async function buildToiletTemplate(entry) {
  const gltf = await loadGLTF(entry.file);
  const raw = gltf.scene;
  const box = new THREE.Box3().setFromObject(raw);
  const size = box.getSize(new THREE.Vector3());
  if (!(size.y > 0)) throw new Error(`${entry.label} has an empty bounding box`);

  const s = TOILET_HEIGHT / size.y;
  const offset = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);

  // root (placed in the world) -> fit (scale+offset) -> raw gltf scene
  const fit = new THREE.Group();
  fit.scale.setScalar(s);
  fit.position.copy(offset).multiplyScalar(s);
  fit.add(raw);
  raw.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
  });

  const b = entry.bowl;
  const bowl = {
    x: (b.x + offset.x) * s,
    z: (b.z + offset.z) * s,
    rx: b.rx * s,
    rz: b.rz * s,
    rimY: (b.rimY + offset.y) * s,
    bottomY: (b.bottomY + offset.y) * s,
  };
  const half = { x: (size.x * s) / 2, z: (size.z * s) / 2 };
  const bowlBack = bowl.z - bowl.rz;
  // Two boxes approximate the solid body: the low front part (up to the rim, with the bowl opening on top)
  // and the tall back part (tank / gadgets). Local space, y up, +Z = front.
  const boxes = [
    { min: new THREE.Vector3(-half.x, 0, bowlBack), max: new THREE.Vector3(half.x, bowl.rimY, half.z), hasBowl: true },
    { min: new THREE.Vector3(-half.x, 0, -half.z), max: new THREE.Vector3(half.x, TOILET_HEIGHT, bowlBack), hasBowl: false },
  ];
  return { entry, fit, bowl, boxes, footprint: Math.max(half.x, half.z) };
}

/** A fresh, independent toilet instance (geometry is shared read-only; materials are cloned so edits never leak). */
export function instantiateToilet(template) {
  const root = new THREE.Group();
  root.name = template.entry.id;
  const fit = template.fit.clone(true);
  fit.traverse((o) => {
    if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
  });
  root.add(fit);
  return root;
}

export function disposeMaterials(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}
