import * as THREE from 'three';

/** Detect what the browser offers. Never throws. */
export async function checkXRSupport() {
  if (!window.isSecureContext) return { ar: false, reason: 'WebXR needs a secure context (https:// or localhost).' };
  if (!('xr' in navigator)) return { ar: false, reason: 'This browser has no WebXR support. Use a WebXR headset browser (e.g. Meta Quest Browser) or play in Desktop Test Mode.' };
  try {
    const ar = await navigator.xr.isSessionSupported('immersive-ar');
    return ar ? { ar: true } : { ar: false, reason: 'Immersive AR is not supported on this device/browser. Desktop Test Mode is available.' };
  } catch (e) {
    return { ar: false, reason: `Could not query WebXR support: ${e.message}` };
  }
}

/**
 * Request an immersive-ar session. hit-test is asked for as required first; if the browser refuses,
 * we retry without it so the game can fall back to the system floor (local-floor) and say so.
 */
export async function requestARSession(overlayRoot) {
  const optional = ['local-floor', 'hand-tracking', 'anchors', 'dom-overlay'];
  const base = { optionalFeatures: optional, domOverlay: { root: overlayRoot } };
  try {
    const session = await navigator.xr.requestSession('immersive-ar', { ...base, requiredFeatures: ['hit-test'] });
    return { session, hitTest: true };
  } catch (e) {
    console.warn('immersive-ar with hit-test failed, retrying without:', e);
    const session = await navigator.xr.requestSession('immersive-ar', { ...base, optionalFeatures: [...optional, 'hit-test'] });
    return { session, hitTest: false };
  }
}

const _m = new THREE.Matrix4();

/** Pose helpers for an XRInputSource in a given frame. */
export function rayFromInput(frame, source, refSpace, out) {
  const pose = frame.getPose(source.targetRaySpace, refSpace);
  if (!pose) return false;
  _m.fromArray(pose.transform.matrix);
  out.origin.setFromMatrixPosition(_m);
  out.direction.set(0, 0, -1).transformDirection(_m);
  return true;
}

/**
 * Snapshot of a tracked hand or controller for the Interactors (see interact.js).
 * Hands: all 25 joints, pinch distance (thumb↔index tips), curl (how closed the fist is), pinch point,
 *        palm point, index fingertip, pose = wrist orientation.
 * Controllers: grip pose; trigger/grip come from the select/squeeze state the caller tracks
 *        (or the gamepad buttons when present).
 */
// XRHand joint order (WebXR Hand Input spec)
const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 9, MIDDLE_PROX = 11, MIDDLE_TIP = 14, RING_TIP = 19, PINKY_TIP = 24;
const JOINTS = 25;

export function readInput(frame, source, refSpace, held, snap) {
  snap.point = null; snap.pose = null; snap.pinchDistance = undefined; snap.curl = undefined;
  snap.palm = null; snap.indexTip = null; snap.joints = null; snap.isHand = !!source.hand;
  snap.pinch = false; snap.squeeze = false;
  if (rayFromInput(frame, source, refSpace, snap.rayObj)) snap.ray = snap.rayObj; else snap.ray = null;

  if (source.hand && frame.fillPoses && source.hand.size >= JOINTS) {
    if (frame.fillPoses(source.hand.values(), refSpace, snap.poseBuf)) {
      const J = snap.jointObjs;
      for (let i = 0; i < JOINTS; i++) J[i].set(snap.poseBuf[i * 16 + 12], snap.poseBuf[i * 16 + 13], snap.poseBuf[i * 16 + 14]);
      snap.joints = J;
      snap.pinchDistance = J[THUMB_TIP].distanceTo(J[INDEX_TIP]);
      snap.curl = (J[MIDDLE_TIP].distanceTo(J[WRIST]) + J[RING_TIP].distanceTo(J[WRIST]) + J[PINKY_TIP].distanceTo(J[WRIST])) / 3;
      snap.point = snap.pointObj.addVectors(J[THUMB_TIP], J[INDEX_TIP]).multiplyScalar(0.5);
      snap.palm = snap.palmObj.copy(J[MIDDLE_PROX]);
      snap.indexTip = J[INDEX_TIP];
      // orientation of the wrist, position filled in by the interactor (pinch point or palm)
      snap.poseObj.fromArray(snap.poseBuf, WRIST * 16);
      snap.pose = snap.poseObj;
      return snap;
    }
    // joints not tracked this frame: fall back to the system pinch (select events)
  }
  if (source.gripSpace) {
    const pose = frame.getPose(source.gripSpace, refSpace);
    if (pose) {
      snap.poseObj.fromArray(pose.transform.matrix);
      snap.pose = snap.poseObj;
      snap.point = snap.pointObj.setFromMatrixPosition(snap.poseObj);
    }
  }
  const gp = source.gamepad;
  snap.pinch = !!(held.select || (gp && gp.buttons[0]?.pressed));
  snap.squeeze = !!(held.squeeze || (gp && gp.buttons[1]?.pressed));
  return snap;
}
export function makeSnapshot() {
  return {
    rayObj: new THREE.Ray(), pointObj: new THREE.Vector3(), palmObj: new THREE.Vector3(), poseObj: new THREE.Matrix4(),
    poseBuf: new Float32Array(16 * JOINTS), jointObjs: Array.from({ length: JOINTS }, () => new THREE.Vector3()),
    ray: null, point: null, pose: null,
  };
}
