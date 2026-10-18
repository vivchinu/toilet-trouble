import * as THREE from 'three';

// Distances in metres.
const PINCH_ON = 0.02, PINCH_OFF = 0.035;   // thumb–index tip distance (hysteresis so it doesn't flicker)
const FIST_ON = 0.105, FIST_OFF = 0.13;     // average middle/ring/pinky tip → wrist distance (closed hand)
const POOP_REACH = 0.09;     // grab point (pinch point or palm) this close to the poop's centre grabs it
const POOP_TOUCH = 0.055;    // ...or any finger joint this close (whole-hand grab)
const HANDLE_REACH = 0.08;   // grab point this close to the handle picks up the slingshot
const HANDLE_TOUCH = 0.035;  // ...or any finger joint wrapped around it
const SQUEEZE_REACH = 0.13;  // a controller's grip button is more forgiving
const POKE_POOP = 0.055;     // fingertip inside this radius of the poop pokes it

/**
 * Direct-manipulation interactors for WebXR hands and controllers.
 *
 * Each frame every hand/controller is fed in as a plain snapshot (see readInput in xr.js), so this file
 * has no WebXR calls and the same logic can be driven by simulated hands in desktop mode:
 *   hands:       { joints[25], pinchDistance, curl, point (pinch), palm, indexTip, pose (wrist), ray, isHand: true }
 *   controllers: { pinch (trigger), squeeze (grip), point, pose (grip), ray }
 *
 * Whole-hand rules:
 *  - grab = pinch OR closed fist. The grab point is the pinch point, or the palm for a fist.
 *  - reach uses every finger joint, so wrapping your hand round the handle or touching the poop counts.
 *  - priority on grab: the poop (pull) → the slingshot handle (carry) → (pinch only) UI / placement / far grab.
 *  - the slingshot is carried rigidly from the wrist (or controller grip), so it turns with your hand.
 *  - an open index finger pokes: in-world buttons (ctx.poke) and the poop (it jiggles).
 */
export class Interactors {
  constructor(scene, ctx) {
    this.scene = scene;
    this.ctx = ctx;           // callbacks into the game (see main.js)
    this.states = new Map();  // key -> state
    this.slingHolder = null;
    this.cursorGeo = new THREE.SphereGeometry(0.009, 12, 8);
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
  }

  state(key) {
    let s = this.states.get(key);
    if (!s) {
      const cursor = new THREE.Mesh(this.cursorGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
      cursor.renderOrder = 30;
      cursor.visible = false;
      this.scene.add(cursor);
      s = { pinching: false, fisting: false, squeezing: false, mode: null, by: null, offset: new THREE.Matrix4(),
        grabOffset: new THREE.Vector3(), rayDist: 0, cursor, near: null, lastPoke: 0 };
      this.states.set(key, s);
    }
    return s;
  }

  /** The input source went away (hand lost, controller off, session end). Lets go of anything it held. */
  remove(key) {
    const s = this.states.get(key);
    if (!s) return;
    this.end(key, s, true); // tracking lost mid-pull: cancel rather than fire
    this.ctx.setHandFeedback?.(key, 0);
    this.scene.remove(s.cursor);
    s.cursor.material.dispose();
    this.states.delete(key);
  }
  clear() { [...this.states.keys()].forEach((k) => this.remove(k)); this.ctx.slingshot().setHighlight(0); this._lastLevel = 0; }

  /** Is this key using its hand for something (so its laser should be hidden)? */
  busy(key) { const s = this.states.get(key); return !!(s && s.mode && s.mode !== 'pullRay'); }

  update(key, snap) {
    const s = this.state(key);
    const sling = this.ctx.slingshot();

    // --- gestures ---------------------------------------------------------------------------
    let pinch;
    if (typeof snap.pinchDistance === 'number') pinch = s.pinching ? snap.pinchDistance < PINCH_OFF : snap.pinchDistance < PINCH_ON;
    else pinch = !!snap.pinch;
    const fist = typeof snap.curl === 'number' ? (s.fisting ? snap.curl < FIST_OFF : snap.curl < FIST_ON) : false;
    const grab = pinch || fist;
    const wasGrab = s.pinching || s.fisting;
    const squeeze = !!snap.squeeze;
    const grabStart = grab && !wasGrab, grabEnd = !grab && wasGrab;
    const squeezeStart = squeeze && !s.squeezing, squeezeEnd = !squeeze && s.squeezing;
    s.pinching = pinch; s.fisting = fist; s.squeezing = squeeze;
    const gesture = fist && !pinch ? 'fist' : 'pinch';
    const grabPoint = gesture === 'fist' && snap.palm ? snap.palm : snap.point;

    // --- what is in reach (whole hand) ------------------------------------------------------
    const poopPos = this.ctx.poopPosition();
    const canPull = this.ctx.canPull();
    let poopDist = grabPoint ? grabPoint.distanceTo(poopPos) : Infinity;
    let handleDist = grabPoint && sling.root.visible ? sling.distanceToHandle(grabPoint) : Infinity;
    let jointPoop = Infinity, jointHandle = Infinity;
    if (snap.joints) {
      for (const j of snap.joints) {
        jointPoop = Math.min(jointPoop, j.distanceTo(poopPos));
        if (sling.root.visible) jointHandle = Math.min(jointHandle, sling.distanceToHandle(j));
      }
    }
    const nearPoop = canPull && (poopDist < POOP_REACH || jointPoop < POOP_TOUCH);
    const nearHandle = handleDist < HANDLE_REACH || jointHandle < HANDLE_TOUCH;
    s.near = nearPoop ? 'poop' : nearHandle ? 'sling' : null;

    if (grabStart && !s.mode) this.onGrab(key, s, snap, gesture, grabPoint, nearPoop, nearHandle);
    if (squeezeStart && !s.mode && snap.pose && Math.min(handleDist, jointHandle) < SQUEEZE_REACH && !this.slingHolder) this.grabSling(key, s, snap.pose, 'squeeze');
    if ((grabEnd && s.mode && s.by === 'grab') || (squeezeEnd && s.mode === 'sling' && s.by === 'squeeze')) this.end(key, s);

    // --- while holding --------------------------------------------------------------------
    if (s.mode === 'sling' && snap.pose) {
      this._m.multiplyMatrices(snap.pose, s.offset);
      this._m.decompose(this._p, this._q, this._s);
      sling.setPose(this._p, this._q);
    } else if (s.mode === 'pull' && grabPoint) {
      this.ctx.updatePull(this._v.copy(grabPoint).add(s.grabOffset));
    } else if (s.mode === 'pullRay' && snap.ray) {
      this.ctx.updatePull(snap.ray.at(s.rayDist, this._v));
    }

    // --- poke with the index fingertip (open hand only) ---------------------------------------
    if (snap.indexTip && !s.mode && !grab) {
      this.ctx.poke?.(key, snap.indexTip);
      const now = performance.now();
      if (snap.indexTip.distanceTo(poopPos) < POKE_POOP && now - s.lastPoke > 400 && this.ctx.pokePoop) {
        s.lastPoke = now;
        this.ctx.pokePoop(snap.indexTip);
      }
    } else if (snap.isHand) {
      this.ctx.poke?.(key, null);
    }

    // --- feedback: tint the hand model (hands) or a cursor dot (controllers) ------------------
    const level = s.mode === 'sling' || s.mode === 'pull' ? 2 : s.near ? 1 : 0;
    this.ctx.setHandFeedback?.(key, level);
    const point = snap.isHand ? null : snap.point;
    s.cursor.visible = !!point;
    if (point) {
      s.cursor.position.copy(point);
      s.cursor.material.color.setHex(level === 2 ? 0x7be35a : level === 1 ? 0xffcc33 : 0xffffff);
      s.cursor.scale.setScalar(level === 2 ? 1.3 : level === 1 ? 1.15 : 1);
    }
    this.refreshHighlight();
  }

  onGrab(key, s, snap, gesture, grabPoint, nearPoop, nearHandle) {
    const ctx = this.ctx;
    if (nearPoop && grabPoint && ctx.startPull(key)) {
      s.mode = 'pull'; s.by = 'grab';
      // keep the poop exactly where it was relative to the hand (no jump on grab)
      s.grabOffset.copy(ctx.poopPosition()).sub(grabPoint);
      return;
    }
    if (snap.pose && nearHandle && !this.slingHolder) { this.grabSling(key, s, snap.pose, 'grab'); return; }
    if (gesture !== 'pinch' || !snap.ray) return; // a fist in mid-air does nothing
    if (ctx.clickRay(snap.ray)) return;
    if (ctx.place()) return;
    const d = ctx.poopRayDistance(snap.ray);
    if (d !== null && ctx.startPull(key)) { s.mode = 'pullRay'; s.by = 'grab'; s.rayDist = d; }
  }

  grabSling(key, s, pose, by) {
    const sling = this.ctx.slingshot();
    sling.root.updateMatrixWorld(true);
    // rigid attachment: remember the slingshot's pose relative to the wrist / grip
    s.offset.copy(pose).invert().multiply(sling.root.matrixWorld);
    s.mode = 'sling'; s.by = by;
    sling.held = true; sling.userPlaced = true;
    this.slingHolder = key;
    this.ctx.onSlingGrab?.(true);
  }

  end(key, s, cancel = false) {
    if (s.mode === 'pull' || s.mode === 'pullRay') this.ctx.endPull(key, cancel);
    if (s.mode === 'sling') {
      this.ctx.slingshot().held = false;
      this.slingHolder = null;
      this.ctx.onSlingGrab?.(false);
    }
    s.mode = null; s.by = null;
  }

  refreshHighlight() {
    const sling = this.ctx.slingshot();
    let level = 0;
    for (const s of this.states.values()) {
      if (s.mode === 'sling') { level = 2; break; }
      if (s.near === 'sling' && !s.mode) level = 1;
    }
    if (level !== this._lastLevel) { sling.setHighlight(level); this._lastLevel = level; }
  }
}
