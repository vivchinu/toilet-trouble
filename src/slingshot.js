import * as THREE from 'three';
import { loadGLTF } from './assets.js';

const SLINGSHOT_HEIGHT = 0.3; // metres, handle bottom to fork tips

/**
 * Slingshot built from isle_of_pigs_slingshot.glb (skinned). We drive its rubber-band bone directly so the
 * real band mesh stretches to wherever the pouch is. If the bones are missing we fall back to drawn bands.
 *
 * Local frame of `root`: origin = pouch rest point, -Z = launch direction, +Y = up.
 */
export async function loadSlingshot(url = 'models/slingshot.glb') {
  const gltf = await loadGLTF(url);
  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh && /ImpactPoint|Sphere/i.test(o.name)) o.visible = false; // gameplay helpers from the source game
    if (o.isMesh) o.frustumCulled = false; // skinned bounds change while stretching
  });
  model.updateMatrixWorld(true);

  const box = new THREE.Box3();
  model.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
  const s = SLINGSHOT_HEIGHT / (box.max.y - box.min.y);

  const scaled = new THREE.Group();
  scaled.scale.setScalar(s);
  scaled.add(model);
  scaled.updateMatrixWorld(true);

  const band = model.getObjectByName('SlingshotRubberBand_06');
  const left = model.getObjectByName('SlingshotLeft_04');
  const right = model.getObjectByName('SlingshotRight_05');
  const deform = [model.getObjectByName('SlingshotRubberBandDeformation0_08'), model.getObjectByName('SlingshotRubberBandDeformation1_09')].filter(Boolean);

  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  let rest, forkL, forkR;
  if (band && left && right) {
    rest = wp(band); forkL = wp(left); forkR = wp(right);
  } else {
    const b = new THREE.Box3().setFromObject(scaled);
    rest = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y - 0.04, (b.min.z + b.max.z) / 2);
    forkL = rest.clone().add(new THREE.Vector3(-0.07, 0.03, 0));
    forkR = rest.clone().add(new THREE.Vector3(0.07, 0.03, 0));
  }
  // Forward = horizontal direction from the band (which rests slightly behind the forks) through the forks.
  const across = forkR.clone().sub(forkL).setY(0).normalize();
  let fwd = new THREE.Vector3().crossVectors(across, new THREE.Vector3(0, 1, 0));
  const mid = forkL.clone().add(forkR).multiplyScalar(0.5);
  if (fwd.dot(mid.clone().sub(rest)) < 0) fwd.negate();

  const align = new THREE.Group();
  align.quaternion.setFromUnitVectors(fwd, new THREE.Vector3(0, 0, -1));
  align.add(scaled);
  // move pouch rest to the origin
  const restRot = rest.clone().applyQuaternion(align.quaternion);
  align.position.copy(restRot).multiplyScalar(-1);

  const root = new THREE.Group();
  root.name = 'slingshot';
  root.add(align);
  root.updateMatrixWorld(true);

  // Fallback drawn bands (only used without bones)
  let lines = null;
  // rest/forkL/forkR were measured in align-local space (before `scaled` was parented), so map them by align's transform.
  const forkLocal = [forkL, forkR].map((f) => f.clone().applyQuaternion(align.quaternion).add(align.position));
  if (!band) {
    const geo = new THREE.BufferGeometry().setFromPoints([forkLocal[0], new THREE.Vector3(), forkLocal[1]]);
    lines = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd8342c }));
    root.add(lines);
  }

  const deformRest = deform.map((d) => d.position.clone());

  // Frame geometry in root space (skinned bounds), measured once at rest.
  const frameBox = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (o.isSkinnedMesh) o.computeBoundingBox(); else o.geometry.computeBoundingBox();
    frameBox.union((o.isSkinnedMesh ? o.boundingBox : o.geometry.boundingBox).clone().applyMatrix4(o.matrixWorld));
  });
  const cz = (frameBox.min.z + frameBox.max.z) / 2;
  // Handle = vertical segment from the bottom of the grip up to just below the fork split.
  const handleA = new THREE.Vector3(0, frameBox.min.y + 0.015, cz);
  const handleB = new THREE.Vector3(0, Math.min(-0.06, frameBox.max.y - 0.12), cz);
  const _seg = new THREE.Line3(handleA, handleB);

  // Highlight (hover/grab feedback): cloned materials so the source asset is untouched.
  const mats = [];
  root.traverse((o) => {
    if (o.isMesh && o.visible) { o.material = o.material.clone(); mats.push(o.material); }
  });

  const state = {
    root,
    frameBox,
    // The poop sits between the forks; when loaded, the pouch (band centre) sits this far behind the poop's
    // centre so the strap cradles its back instead of cutting through it. Set by the game from the poop size.
    seatOffset: 0.05,
    seatDrop: 0.035,   // ...and a little lower, so the strap cups the poop's bottom and its face stays visible
    loaded: false,     // a poop is in the pouch (band pushed back around it) vs. empty band
    pouchLocal: new THREE.Vector3(), // current pouch offset in root space
    springing: false,
    vel: new THREE.Vector3(),
    held: false,       // true while a hand/controller is carrying it
    userPlaced: false, // the player has moved it themselves: don't auto-reposition between shots

    /** World-space "back" direction (from the forks towards the player). */
    backWorld(out = new THREE.Vector3()) { return out.set(0, 0, 1).applyQuaternion(root.quaternion); },
    /** Poop centre for a given pull: between the forks at rest. Used for the visuals, the preview AND the launch. */
    seatWorld(pull, out = new THREE.Vector3()) { return state.restWorld(out).add(pull); },
    /** Band centre for a given pull: behind the poop along the pull direction (straight back when not pulled). */
    pouchForPull(pull, out = new THREE.Vector3()) {
      const len = pull.length();
      state.seatWorld(pull, out);
      if (len > 0.01) out.addScaledVector(pull, state.seatOffset / len);
      else out.addScaledVector(state.backWorld(_tmp), state.seatOffset);
      return out.addScaledVector(_tmp.set(0, 1, 0).applyQuaternion(root.quaternion), -state.seatDrop);
    },
    /** Where a loaded poop sits while the band is springing/resting (follows the pouch). */
    poopFromPouch(out = new THREE.Vector3()) {
      return root.localToWorld(out.copy(state.pouchLocal).add(_tmp.set(0, state.seatDrop, -state.seatOffset)));
    },
    /** Distance from a world point to the handle (grab zone). */
    distanceToHandle(p) {
      const local = root.worldToLocal(_tmp.copy(p));
      return _seg.closestPointToPoint(local, true, _tmp2).distanceTo(local);
    },
    setHighlight(level) { // 0 = none, 1 = hover, 2 = held
      const c = level === 2 ? 0x2a5a00 : level === 1 ? 0x3a3000 : 0x000000;
      mats.forEach((m) => m.emissive && m.emissive.setHex(c));
    },
    setPose(position, quaternion) {
      root.position.copy(position);
      root.quaternion.copy(quaternion);
      root.updateMatrixWorld(true);
      apply();
    },

    /** Put the slingshot so its pouch rest point is at `pos`, launching towards `dir` (horizontal). */
    placeAt(pos, dir) {
      root.position.copy(pos);
      root.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
      root.updateMatrixWorld(true);
    },
    restWorld(out = new THREE.Vector3()) { return root.localToWorld(out.set(0, 0, 0)); },
    pouchWorld(out = new THREE.Vector3()) { return root.localToWorld(out.copy(state.pouchLocal)); },

    /** Drag the pouch to a world position (already clamped by the caller). */
    setPouchWorld(p) {
      state.springing = false;
      root.worldToLocal(state.pouchLocal.copy(p));
      apply();
    },
    /** Let go: the band snaps back with a damped spring. */
    release(stillLoaded = false) { state.loaded = stillLoaded; state.springing = true; state.vel.set(0, 0, 0); },
    /** Snap the band to its resting shape (with or without a poop in it). */
    reset(loaded = state.loaded) { state.loaded = loaded; state.springing = false; restTarget(state.pouchLocal); apply(); },
    update(dt) {
      if (!state.springing) return;
      const k = 900, c = 14;
      const n = Math.ceil(dt / (1 / 240)), h = dt / n;
      const target = restTarget(_tmp2);
      for (let i = 0; i < n; i++) {
        state.vel.addScaledVector(_tmp.copy(state.pouchLocal).sub(target), -k * h).multiplyScalar(1 - c * h);
        state.pouchLocal.addScaledVector(state.vel, h);
      }
      if (state.pouchLocal.distanceToSquared(target) < 1e-7 && state.vel.lengthSq() < 1e-5) { state.springing = false; state.pouchLocal.copy(target); }
      apply();
    },
  };

  const _w = new THREE.Vector3();
  const _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3();
  function restTarget(out) { return state.loaded ? out.set(0, -state.seatDrop, state.seatOffset) : out.set(0, 0, 0); }
  function apply() {
    if (band) {
      root.localToWorld(_w.copy(state.pouchLocal));
      band.parent.updateMatrixWorld(true);
      band.parent.worldToLocal(_w);
      band.position.copy(_w);
      // deformation helpers follow halfway so the band curves softly
      deform.forEach((d, i) => d.position.lerpVectors(deformRest[i], _w, 0.5));
    } else if (lines) {
      const a = lines.geometry.attributes.position;
      a.setXYZ(1, state.pouchLocal.x, state.pouchLocal.y, state.pouchLocal.z);
      a.needsUpdate = true;
    }
  }
  return state;
}
