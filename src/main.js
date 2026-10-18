import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadToiletManifest, buildToiletTemplate, instantiateToilet, disposeMaterials } from './assets.js';
import { loadPoop, POOP_TYPES, Jiggle, tickPoopMaterials, POOP_SIZE } from './poop.js';
import { loadSlingshot } from './slingshot.js';
import { PHYS, World, Trajectory, launchVelocity, step } from './physics.js';
import { Panel3D, RadialMenu, FloatingText, panelBackground } from './ui3d.js';
import { blobShadow, makeReticle, Burst } from './effects.js';
import { checkXRSupport, requestARSession, rayFromInput, readInput, makeSnapshot } from './xr.js';
import { Interactors } from './interact.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import * as sfx from './audio.js';

const SHOTS_PER_ROUND = 10;
const DEBUG = new URLSearchParams(location.search).has('debug');
// Phones/tablets (not headsets, whose browsers also say "Mobile"). Used for framing and touch-friendly hints.
const IS_HANDHELD = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && !/OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
const IS_TOUCH = IS_HANDHELD || window.matchMedia('(pointer: coarse)').matches;
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isPortrait = () => window.innerWidth < window.innerHeight;
// Upright phones and short landscape phones: slingshot low in the frame, view tilted down, so the toilet shows above it.
const lowFraming = () => isPortrait() || window.innerHeight < 500;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const DESKTOP_BG = new THREE.Color(0x203a55);
scene.background = DESKTOP_BG;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 3, 2);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.02, 60);
camera.position.set(0, 1.45, 0);
scene.add(camera);
/** Wider vertical FOV on upright phones so the narrow horizontal view still shows the toilet (AR overrides this). */
function fitCamera() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = camera.aspect < 1 ? 80 : 65;
  camera.updateProjectionMatrix();
}
fitCamera();

// Desktop-only virtual room (never shown in AR)
const desktopEnv = new THREE.Group();
{
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5b6f80, roughness: 0.95 }));
  floor.name = 'virtualFloor';
  const grid = new THREE.GridHelper(24, 48, 0x86a6c2, 0x6f8aa1);
  grid.position.y = 0.002;
  desktopEnv.add(floor, grid);
}
scene.add(desktopEnv);

// ---------------------------------------------------------------------------------------------
// Game objects
// ---------------------------------------------------------------------------------------------
const world = new World();
const trajectory = new Trajectory(70);
const burst = new Burst(70);
const floatText = new FloatingText();
const reticle = makeReticle();
const toiletShadow = blobShadow(0.45, 0.5);
const poopShadow = blobShadow(0.07, 0.35);
toiletShadow.visible = poopShadow.visible = false;
scene.add(trajectory.group, burst.points, floatText.sprite, reticle, toiletShadow, poopShadow);

let manifest = [];
const templates = new Map();   // id -> Promise<template>
let selectedIndex = 0;
let placed = null;             // { root, template, debug }
let previewObj = null;         // turntable preview in the selection screen
let slingshot = null;
let poopFactory = null;
let poop = null;               // { root, jiggle, setType }
let jiggle = null;
let poopTypeIndex = 0;
let pendingPoopType = null;
let radial = null;
let poopIcons = [];
let interactors = null;        // hands & controllers in XR (see interact.js)

// XR-only world-space HUD
const hud3d = new Panel3D(0.42, 0.24);
hud3d.mesh.visible = false;
scene.add(hud3d.mesh);

const game = {
  mode: null,          // 'desktop' | 'xr'
  phase: 'start',      // start | select | place | play | over
  shot: 'ready',       // ready | aiming | flying | sinking | settling
  score: 0, hits: 0, attempts: 0,
  shotTimer: 0, flightTime: 0, missAnnounced: false,
  xrPanelMode: 'game', // game | pickToilet | place | over
  toastText: '', toastTimer: 0,
};

// Projectile simulation state (fixed step)
const proj = { p: new THREE.Vector3(), v: new THREE.Vector3(), prev: new THREE.Vector3(), spinAxis: new THREE.Vector3(1, 0, 0), spin: 0, acc: 0, sinkFrom: new THREE.Vector3(), sinkTo: new THREE.Vector3() };

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------
function getTemplate(i) {
  const e = manifest[i];
  if (!templates.has(e.id)) {
    const p = buildToiletTemplate(e);
    p.catch(() => templates.delete(e.id));
    templates.set(e.id, p);
  }
  return templates.get(e.id);
}

async function boot() {
  const support = $('support');
  try {
    manifest = await loadToiletManifest();
    [poopFactory, slingshot] = await Promise.all([loadPoop(), loadSlingshot()]);
  } catch (err) {
    console.error(err);
    showError(`Loading failed: ${err.message}`);
    $('btn-start').textContent = 'Load error';
    return;
  }
  scene.add(slingshot.root);
  slingshot.root.visible = false;
  poop = poopFactory.create();
  jiggle = new Jiggle(poop.jiggle);
  interactors = new Interactors(scene, {
    slingshot: () => slingshot,
    poopPosition: () => poop.root.position,
    canPull: () => game.phase === 'play' && game.shot === 'ready' && game.popIn >= 1 && !!placed && placed.popT >= 1,
    startPull: (key) => startAim('hand', key),
    updatePull: (point) => setPullFromPoint(point),
    endPull: (key, cancel) => { if (aim.active && aim.source === key) (cancel ? cancelAim() : releaseAim()); },
    clickRay: (ray) => clickUI(hitUI(ray)),
    place: () => { if (game.phase !== 'place') return false; if (reticle.visible) placeToiletAt(reticle.matrix); return true; },
    poopRayDistance: (ray) => (game.phase === 'play' ? poopHitByRay(ray, 0.12) : null),
    onSlingGrab: (held) => { if (game.mode === 'xr') drawHud3d(); },
    poke: (key, tip) => pokePanels(key, tip),
    pokePoop: () => {
      if (!poop.root.visible || (game.shot !== 'ready' && game.shot !== 'aiming')) return;
      jiggle.impulse(-8); // boop
      sfx.splat(0.25);
    },
    setHandFeedback: (key, level) => tintHand(key, level),
  });
  // seat the poop just behind the band: half its depth (front-to-back) + ~8 mm for the strap
  const pb = new THREE.Box3().setFromObject(poop.root);
  slingshot.seatOffset = (pb.max.z - pb.min.z) / 2 + 0.008;
  scene.add(poop.root);
  poop.root.visible = false;
  poopIcons = await renderPoopIcons();
  radial = new RadialMenu(POOP_TYPES.map((t, i) => ({ ...t, short: t.name.split(' ')[0], icon: poopIcons[i] })));
  radial.mesh.visible = false;
  scene.add(radial.mesh);
  buildToiletCards();
  updatePoopChip();

  // Warm the cache for all five toilets in the background (switching later is instant).
  manifest.forEach((_, i) => getTemplate(i).catch((e) => markCardFailed(i, e)));

  const xr = await checkXRSupport();
  if (!xr.ar && IS_IOS) xr.reason = 'iPhone/iPad browsers do not support WebXR AR yet. You can still play on screen with a virtual floor ("Play without AR").';
  else if (!xr.ar && IS_HANDHELD) xr.reason = `${xr.reason.replace(/Desktop Test Mode/g, '"Play without AR"')} For AR on a phone use Chrome on an ARCore-supported Android phone.`;
  game.xrSupport = xr;
  if (!xr.ar) {
    support.textContent = xr.reason;
    support.classList.add('warn');
  } else {
    support.textContent = 'Immersive AR is available on this device.';
  }
  $('btn-start').disabled = false;
  $('btn-start').textContent = 'Start Game';
}

/** Small icons of each poop style for the radial menu & HUD (rendered once, offscreen). */
async function renderPoopIcons() {
  const size = 160;
  const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  r.setSize(size, size); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.NeutralToneMapping;
  const s = new THREE.Scene();
  s.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
  s.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
  const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(1, 2, 3); s.add(d);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  cam.position.set(0, 0.04, 0.24); cam.lookAt(0, 0, 0);
  const p = poopFactory.create();
  s.add(p.root);
  const imgs = [];
  for (const t of POOP_TYPES) {
    p.setType(t.id);
    tickPoopMaterials(1.0);
    r.render(s, cam);
    const img = new Image();
    img.onload = () => radial?.redraw(); // don't block boot on decoding (background tabs may delay it)
    img.src = r.domElement.toDataURL('image/png');
    imgs.push(img);
  }
  r.dispose(); r.forceContextLoss();
  return imgs;
}

// ---------------------------------------------------------------------------------------------
// DOM UI
// ---------------------------------------------------------------------------------------------
function showScreen(id) {
  for (const s of ['screen-start', 'screen-select', 'screen-over']) $(s).classList.toggle('hidden', s !== id);
}
function setHudVisible(v) { $('hud').classList.toggle('hidden', !v); }
function hint(text) { $('hint').textContent = text || ''; }

let toastTimeout = 0;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.add('hidden'), 1800);
  game.toastText = text; game.toastTimer = 1.8;
  if (game.mode === 'xr') drawHud3d();
}
function showError(msg) { toast(msg, 'bad'); console.warn(msg); }

function buildToiletCards() {
  const list = $('toilet-list');
  list.innerHTML = '';
  manifest.forEach((e, i) => {
    const b = document.createElement('button');
    b.className = 'toilet-card' + (i === selectedIndex ? ' selected' : '');
    b.innerHTML = `<img alt="" src="${e.thumb}"><span>${e.label}</span>`;
    b.onclick = () => selectToilet(i);
    list.appendChild(b);
  });
}
function markCardFailed(i, err) {
  const card = $('toilet-list').children[i];
  if (card) { card.classList.add('failed'); card.title = err.message; }
  if (i === selectedIndex) $('select-note').textContent = `${manifest[i].label} failed to load: ${err.message}`;
}

async function selectToilet(i) {
  selectedIndex = i;
  [...$('toilet-list').children].forEach((c, k) => c.classList.toggle('selected', k === i));
  $('select-note').textContent = 'Loading…';
  try {
    const tpl = await getTemplate(i);
    if (selectedIndex !== i) return;
    if (previewObj) { scene.remove(previewObj); disposeMaterials(previewObj); }
    previewObj = instantiateToilet(tpl);
    previewObj.position.set(0, 0, -1.6);
    previewObj.visible = !renderer.xr.isPresenting; // in AR the thumbnails are the preview
    scene.add(previewObj);
    $('select-note').textContent = game.xrSupport?.ar ? `${manifest[i].label} selected.` : `${manifest[i].label} selected. ${game.xrSupport?.reason || ''}`;
  } catch (e) {
    markCardFailed(i, e);
  }
}

function updatePoopChip() {
  const t = POOP_TYPES[poopTypeIndex];
  $('hud-poop-name').textContent = t.name;
  $('hud-poop-swatch').style.background = t.swatch;
}

function updateHud() {
  $('hud-score').textContent = game.score;
  $('hud-hits').textContent = `${game.hits} / ${game.attempts}`;
  updatePoopChip();
  if (game.mode === 'xr') drawHud3d();
}

// Buttons ------------------------------------------------------------------------------------
$('btn-start').onclick = () => {
  sfx.initAudio();
  game.phase = 'select';
  showScreen('screen-select');
  $('btn-place-ar').disabled = !game.xrSupport?.ar;
  $('btn-place-ar').title = game.xrSupport?.ar ? '' : game.xrSupport?.reason || '';
  selectToilet(selectedIndex);
};
$('btn-place-desktop').onclick = () => { sfx.initAudio(); startDesktop(); };
$('btn-place-ar').onclick = () => {
  sfx.initAudio();
  if (renderer.xr.isPresenting) { showScreen(null); beginPlacement(); } // changing toilet inside phone AR
  else startXR();
};
if (IS_HANDHELD) $('btn-place-desktop').textContent = 'Play without AR';
// In phone AR the HTML overlay sits on top of the scene: a tap on a button must not also count as an
// AR "select" (which would place the toilet or grab the poop behind it).
$('overlay').addEventListener('beforexrselect', (e) => {
  if (e.target.closest('button, .poop-chip, .card, .stat')) e.preventDefault();
});
$('btn-poop').onclick = () => action('poop');
$('hud-poop').onclick = () => action('poop');
$('btn-toilet').onclick = () => action('toilet');
$('btn-restart').onclick = () => action('restart');
$('btn-exit').onclick = () => action('exit');
$('btn-again').onclick = () => action('again');

/** Every button (DOM or in-world) ends up here. */
function action(id) {
  switch (id) {
    case 'poop':
      if (game.phase !== 'play') return;
      radial.mesh.visible = !radial.mesh.visible;
      break;
    case 'toilet':
      if (game.mode === 'desktop') {
        cancelAim();
        game.phase = 'select';
        hideGameplay();
        removePlacedToilet(); // the next "Select & Place" puts the new choice down
        showScreen('screen-select');
        setHudVisible(false);
        selectToilet(selectedIndex);
      } else if (xr.domOverlay) {
        // phone AR: reuse the HTML selection screen (it is part of the AR DOM overlay)
        cancelAim();
        hideGameplay();
        removePlacedToilet();
        game.phase = 'select';
        $('btn-place-desktop').classList.add('hidden');
        showScreen('screen-select');
        selectToilet(selectedIndex);
      } else {
        cancelAim();
        game.xrPanelMode = 'pickToilet';
        radial.mesh.visible = false;
        layoutXRPanels(true);
        drawHud3d();
      }
      break;
    case 'restart':
    case 'again':
      game.score = game.hits = game.attempts = 0;
      cancelAim();
      if (!slingshot.held) slingshot.userPlaced = false; // Restart also brings the slingshot back
      resetShot();
      game.phase = 'play';
      game.xrPanelMode = 'game';
      showScreen(null);
      updateHud();
      toast('New round!');
      break;
    case 'exit':
      renderer.xr.getSession()?.end();
      break;
    case 'cancelPick':
      game.xrPanelMode = placed ? 'game' : 'place';
      drawHud3d();
      break;
    default:
      if (id.startsWith('pick:')) { // in-XR toilet picker
        const i = +id.slice(5);
        selectedIndex = i;
        beginPlacement();
      }
  }
}

function hideGameplay() {
  slingshot.root.visible = false;
  poop.root.visible = false;
  poopShadow.visible = false;
  radial.mesh.visible = false;
  trajectory.show(false);
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------
function startDesktop() {
  game.mode = 'desktop';
  desktopEnv.visible = true;
  scene.background = DESKTOP_BG;
  world.floorY = 0;
  camera.position.set(0, 1.45, 0);
  look.yaw = 0; look.pitch = lowFraming() ? -0.4 : -0.22;
  applyLook();
  $('mode-badge').textContent = IS_HANDHELD ? 'NO-AR MODE · virtual floor' : 'DESKTOP TEST MODE · virtual floor';
  $('btn-exit').classList.add('hidden');
  beginPlacement();
}

async function startXR() {
  let res;
  try {
    res = await requestARSession($('overlay'));
  } catch (e) {
    showError(`Could not start AR: ${e.message}. Try Desktop Test Mode.`);
    return;
  }
  const { session } = res;
  // Prefer local-floor (y = 0 is the floor); fall back to local.
  let refType = 'local-floor';
  try { await session.requestReferenceSpace('local-floor'); } catch { refType = 'local'; }
  renderer.xr.setReferenceSpaceType(refType);
  await renderer.xr.setSession(session);
  await setupHandModels();

  xr.session = session;
  xr.refType = refType;
  xr.hitTestSource = null;
  xr.hitTestAvailable = res.hitTest || (session.enabledFeatures ? session.enabledFeatures.includes('hit-test') : false);
  if (xr.hitTestAvailable && session.requestHitTestSource) {
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      xr.hitTestSource = await session.requestHitTestSource({ space: viewer });
    } catch (e) {
      console.warn('hit test source failed', e);
      xr.hitTestSource = null;
    }
  }
  xr.domOverlay = !!session.domOverlayState;
  game.mode = 'xr';
  desktopEnv.visible = false;
  scene.background = null;
  if (previewObj) previewObj.visible = false;
  showScreen(null);
  setHudVisible(xr.domOverlay);
  $('mode-badge').textContent = 'MIXED REALITY';
  $('btn-exit').classList.remove('hidden');
  hud3d.mesh.visible = !xr.domOverlay;

  session.addEventListener('selectstart', onXRSelectStart);
  session.addEventListener('selectend', onXRSelectEnd);
  session.addEventListener('end', onXREnd);
  session.addEventListener('squeezestart', onXRSqueeze);
  session.addEventListener('squeezeend', onXRSqueeze);
  session.addEventListener('inputsourceschange', (ev) => {
    // a hand/controller disappeared: let go of whatever it held (a pull is cancelled, not fired)
    for (const src of ev.removed) { interactors.remove(src); xrHeld.delete(src); }
  });

  if (!xr.hitTestSource) {
    if (refType === 'local-floor') {
      toast('Surface hit testing unavailable – using the headset floor level instead.', 'bad');
    } else {
      showError('No hit testing and no floor reference on this device – cannot find the floor. Use Desktop Test Mode.');
      session.end();
      return;
    }
  }
  xr.needsLayout = true;
  beginPlacement();
}

function onXREnd() {
  const s = xr.session;
  if (s) {
    s.removeEventListener('selectstart', onXRSelectStart);
    s.removeEventListener('selectend', onXRSelectEnd);
    s.removeEventListener('end', onXREnd);
  }
  xr.session = null;
  xr.hitTestSource = null;
  xr.anchor = null;
  xr.activeSource = null;
  xr.domOverlay = false;
  s?.removeEventListener('squeezestart', onXRSqueeze);
  s?.removeEventListener('squeezeend', onXRSqueeze);
  interactors.clear();
  xrHeld.clear();
  slingshot.held = false; slingshot.userPlaced = false;
  $('btn-place-desktop').classList.remove('hidden');
  cancelAim();
  removePlacedToilet();
  hideGameplay();
  hud3d.mesh.visible = false;
  reticle.visible = false;
  xrRays.forEach((r) => (r.visible = false));
  game.mode = null;
  game.phase = 'select';
  desktopEnv.visible = true;
  scene.background = DESKTOP_BG;
  camera.position.set(0, 1.45, 0); look.yaw = 0; look.pitch = -0.22; applyLook();
  setHudVisible(false);
  showScreen('screen-select');
  selectToilet(selectedIndex);
  if (previewObj) previewObj.visible = true;
  toast('AR session ended. Your score was ' + game.score + '.');
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------
async function beginPlacement() {
  let tpl;
  try {
    tpl = await getTemplate(selectedIndex);
  } catch (e) {
    showError(`${manifest[selectedIndex].label} failed to load: ${e.message}`);
    return;
  }
  game.pendingTemplate = tpl;
  game.phase = 'place';
  game.xrPanelMode = 'place';
  hideGameplay();
  if (previewObj) previewObj.visible = false;
  showScreen(null);
  if (game.mode === 'desktop') {
    setHudVisible(true);
    hint(IS_TOUCH ? 'Tap the floor to place the toilet.' : 'Move the mouse over the floor and click to place the toilet.');
  } else {
    layoutXRPanels(true);
    drawHud3d();
    hint(IS_HANDHELD ? 'Point your phone at the floor until the ring appears, then tap the screen.' : xr.hitTestSource ? 'Look at the floor, then pinch / pull the trigger to place the toilet.' : 'Look where you want the toilet, then pinch / pull the trigger.');
  }
  reticle.visible = false;
}

function removePlacedToilet() {
  if (!placed) return;
  scene.remove(placed.root);
  disposeMaterials(placed.root);
  placed = null;
  world.setToilet(null);
  toiletShadow.visible = false;
  xr.anchor = null;
}

function placeToiletAt(matrix) {
  removePlacedToilet(); // never two toilets at once
  const tpl = game.pendingTemplate;
  const root = instantiateToilet(tpl);
  const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
  root.position.copy(pos);
  // face the player
  const head = new THREE.Vector3();
  camera.getWorldPosition(head);
  root.rotation.y = Math.atan2(head.x - pos.x, head.z - pos.z);
  scene.add(root);
  placed = { root, template: tpl };
  world.floorY = pos.y;
  world.setToilet({ root, bowl: tpl.bowl, boxes: tpl.boxes });
  toiletShadow.visible = true;
  toiletShadow.position.set(pos.x, pos.y + 0.002, pos.z);
  toiletShadow.scale.setScalar(tpl.footprint / 0.45 * 1.1);
  if (DEBUG) addDebugVolumes(root, tpl);

  // pop-in
  root.scale.setScalar(0.01);
  placed.popT = 0;

  if (game.mode === 'xr' && xr.lastHit && xr.lastHit.createAnchor) {
    xr.lastHit.createAnchor().then((a) => { if (placed && placed.root === root) xr.anchor = a; }).catch(() => {});
  }

  reticle.visible = false;
  hint('');
  toast('Toilet placed');
  sfx.splat(0.6);
  game.phase = 'play';
  game.xrPanelMode = 'game';
  game.score = game.hits = game.attempts = 0;
  if (!slingshot.held) slingshot.userPlaced = false;
  radial.mesh.visible = true; // show the radial picker once after placement
  resetShot();
  updateHud();
}

function addDebugVolumes(root, tpl) {
  const m = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5 });
  const b = tpl.bowl;
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.01, 32), m);
  ring.scale.set(b.rx * PHYS.bowlFactor, 1, b.rz * PHYS.bowlFactor);
  ring.position.set(b.x, b.rimY, b.z);
  root.add(ring);
  for (const bx of tpl.boxes) {
    const size = bx.max.clone().sub(bx.min);
    const box = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial({ color: bx.hasBowl ? 0xffff00 : 0xff00ff, wireframe: true }));
    box.position.copy(bx.min).add(bx.max).multiplyScalar(0.5);
    root.add(box);
  }
}

// ---------------------------------------------------------------------------------------------
// Slingshot placement & shot lifecycle
// ---------------------------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const ZERO = new THREE.Vector3();

/** Put the slingshot in front of the player, aimed at the toilet. Re-done before every shot so it follows you. */
function positionSlingshot() {
  if (game.mode === 'xr' && slingshot.userPlaced) {
    // the player picked it up and put it somewhere: leave it there
    if (!slingshot.held) slingshot.reset();
    slingshot.root.visible = true;
    return;
  }
  const head = camera.getWorldPosition(_v1);
  const fwd = camera.getWorldDirection(_v2).setY(0);
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  // Headset: slingshot at chest height within arm's reach. Phone AR: just below the centre of the screen
  // (the camera *is* the phone, so anything 30 cm lower would be off-screen). Screen modes: lower third.
  const handheldXR = game.mode === 'xr' && IS_HANDHELD;
  const narrow = game.mode !== 'xr' && lowFraming(); // phone screens without AR: low in the frame so the toilet stays visible above it
  const pos = head.clone().addScaledVector(fwd, game.mode === 'xr' ? 0.42 : narrow ? 0.75 : 0.6);
  pos.y -= handheldXR ? 0.13 : game.mode === 'xr' ? 0.3 : narrow ? 0.62 : 0.24;
  const toToilet = placed ? placed.root.position.clone().sub(pos).setY(0) : fwd.clone();
  if (toToilet.lengthSq() < 1e-4) toToilet.copy(fwd);
  toToilet.normalize();
  slingshot.placeAt(pos, toToilet);
  slingshot.reset();
  slingshot.root.visible = true;
  layoutXRPanels(false);
}

function layoutXRPanels(inFront) {
  const head = camera.getWorldPosition(new THREE.Vector3());
  const fwd = camera.getWorldDirection(new THREE.Vector3()).setY(0);
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  if (inFront || !slingshot.root.visible) {
    hud3d.mesh.position.copy(head).addScaledVector(fwd, 0.7).add(new THREE.Vector3(0, -0.12, 0));
  } else {
    // HUD to the left of the slingshot, radial to the right – both clear of the shooting lane
    const rest = slingshot.restWorld(new THREE.Vector3());
    hud3d.mesh.position.copy(rest).addScaledVector(right, -0.36).add(new THREE.Vector3(0, 0.12, 0)).addScaledVector(fwd, 0.08);
  }
  hud3d.mesh.lookAt(head);
  const rest = slingshot.restWorld(new THREE.Vector3());
  if (isPortrait()) {
    // narrow screen: there is no room beside the slingshot, so float the picker above it (it hides after a pick)
    const s = game.mode === 'xr' ? 0.55 : 0.8;
    radial.mesh.scale.setScalar(s);
    radial.mesh.position.copy(rest).add(new THREE.Vector3(0, 0.08 + 0.13 * s, 0));
  } else {
    radial.mesh.scale.setScalar(1);
    radial.mesh.position.copy(rest).addScaledVector(right, game.mode === 'xr' ? 0.3 : 0.34).add(new THREE.Vector3(0, game.mode === 'xr' ? 0.1 : 0.12, 0));
  }
  radial.mesh.lookAt(head);
}

function resetShot() {
  game.shot = 'ready';
  game.shotTimer = 0;
  if (pendingPoopType != null) { applyPoopType(pendingPoopType); pendingPoopType = null; }
  positionSlingshot();
  slingshot.reset(true); // new poop in the pouch
  poop.root.visible = true;
  poop.root.position.copy(slingshot.seatWorld(ZERO, _v1));
  poop.root.quaternion.copy(slingshot.root.quaternion);
  poop.root.scale.setScalar(0.01);
  game.popIn = 0;
  poopShadow.visible = true;
  trajectory.show(false);
  hint(shootHint());
}

function shootHint() {
  if (game.attempts > 0) return '';
  if (game.mode === 'xr') return xr.domOverlay ? 'Drag the poop down and towards you, then let go.' : '';
  return IS_TOUCH
    ? 'Drag the poop down and let go to launch. Drag empty space to look around.'
    : 'Drag the poop back (down = higher arc) and release to launch. Right-drag to look around, WASD to move.';
}

function applyPoopType(i) {
  poopTypeIndex = i;
  poop.setType(POOP_TYPES[i].id);
  radial.setSelected(i);
  updateHud();
}

function choosePoop(i) {
  if (game.shot === 'flying' || game.shot === 'sinking') { pendingPoopType = i; radial.setSelected(i); toast(`${POOP_TYPES[i].name} next shot`); }
  else { applyPoopType(i); jiggle.impulse(5); }
  radial.mesh.visible = false;
  sfx.splat(0.3);
}

// Aiming -----------------------------------------------------------------------------------------
const aim = { active: false, mode: null, source: null, rayDist: 0, pull: new THREE.Vector3(), lastStretch: 0 };

function startAim(mode, source = null, rayDist = 0) {
  if (game.phase !== 'play' || game.shot !== 'ready' || game.popIn < 1 || !placed || placed.popT < 1) return false;
  aim.active = true; aim.mode = mode; aim.source = source; aim.rayDist = rayDist;
  aim.pull.set(0, 0, 0);
  game.shot = 'aiming';
  radial.mesh.visible = false;
  trajectory.show(true);
  hint('');
  return true;
}

function cancelAim() {
  if (!aim.active) return;
  aim.active = false;
  sfx.stretch(null);
  slingshot.release(true); // poop stays in the pouch
  trajectory.show(false);
  jiggle.target = 0;
  if (game.shot === 'aiming') game.shot = 'ready';
}

/** Hand / ray aiming: `point` is where the player holds the poop's centre; pull = its offset from rest (clamped). */
function setPullFromPoint(point) {
  aim.pull.copy(point).sub(slingshot.restWorld(_v1));
  if (aim.pull.length() > PHYS.maxPull) aim.pull.setLength(PHYS.maxPull);
}

/** Mouse / screen-tap aiming: drag on a camera-facing plane; dragging also implies pulling back towards the player. */
function setPullFromScreenRay(ray) {
  const rest = slingshot.restWorld(_v1);
  const n = camera.getWorldDirection(_v2).negate();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, rest);
  const hit = ray.intersectPlane(plane, _v3);
  if (!hit) return;
  const lateral = hit.sub(rest);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(slingshot.root.quaternion); // towards the player
  aim.pull.copy(lateral).addScaledVector(back, lateral.length() * 1.15);
  if (aim.pull.length() > PHYS.maxPull) aim.pull.setLength(PHYS.maxPull);
}

function releaseAim() {
  if (!aim.active) return;
  aim.active = false;
  sfx.stretch(null);
  trajectory.show(false);
  jiggle.target = 0;
  const v = launchVelocity(aim.pull, new THREE.Vector3());
  if (v.lengthSq() === 0) { slingshot.release(true); game.shot = 'ready'; jiggle.impulse(-3); return; }
  slingshot.release(false); // empty band snaps back to the forks
  // Launch from exactly the point the preview used (the seated poop for this pull), independent of render timing
  slingshot.seatWorld(aim.pull, proj.p);
  proj.v.copy(v);
  proj.acc = 0;
  proj.spinAxis.crossVectors(v, new THREE.Vector3(0, 1, 0)).normalize().negate();
  proj.spin = 6 + v.length() * 0.8;
  game.shot = 'flying';
  game.flightTime = 0;
  game.missAnnounced = false;
  game.attempts++;
  updateHud();
  jiggle.impulse(9);   // stretch on launch
  sfx.launch();
}

function updateAimVisuals(dt) {
  slingshot.setPouchWorld(slingshot.pouchForPull(aim.pull, _v1)); // band wraps behind the poop
  const seat = slingshot.seatWorld(aim.pull, _v3);
  poop.root.position.copy(seat);
  poop.root.quaternion.copy(slingshot.root.quaternion);
  const k = aim.pull.length() / PHYS.maxPull;
  jiggle.target = -0.22 * k; // squash while pulled
  if (Math.abs(k - aim.lastStretch) > 0.02) { sfx.stretch(k); aim.lastStretch = k; }
  const v = launchVelocity(aim.pull, _v2);
  if (v.lengthSq() > 0) {
    trajectory.show(true);
    trajectory.update(world, seat, v);
  } else {
    trajectory.show(false);
  }
}

// Flight -----------------------------------------------------------------------------------------
const _q = new THREE.Quaternion();
function updateFlight(dt) {
  proj.acc += Math.min(dt, 0.05);
  game.flightTime += dt;
  while (proj.acc >= PHYS.dt && game.shot === 'flying') {
    proj.acc -= PHYS.dt;
    proj.prev.copy(proj.p);
    step(proj.p, proj.v);
    const hit = world.collide(proj.prev, proj.p, proj.v);
    if (hit) onHit(hit);
  }
  // tumble while flying, slow down after the first floor contact
  _q.setFromAxisAngle(proj.spinAxis, proj.spin * dt);
  poop.root.quaternion.premultiply(_q);
  poop.root.position.copy(proj.p);

  if (game.shot === 'flying') {
    const tooFar = placed && proj.p.distanceTo(placed.root.position) > 15;
    if (game.flightTime > 6 || tooFar || proj.p.y < world.floorY - 2) resolveMiss(true);
  }
}

function onHit(hit) {
  if (hit.type === 'score') {
    game.shot = 'sinking';
    game.shotTimer = 0;
    proj.sinkFrom.copy(proj.p);
    const b = placed.template.bowl;
    proj.sinkTo.set(b.x, (b.rimY + b.bottomY) / 2, b.z);
    placed.root.localToWorld(proj.sinkTo);
    game.score += 100;
    game.hits++;
    updateHud();
    jiggle.impulse(-14);
    sfx.splat(1);
    setTimeout(() => sfx.flush(), 180);
    const colors = { classic: ['#8b4a22', '#5fd4ff', '#ffffff'], golden: ['#ffd84a', '#fff2a8', '#5fd4ff'], rainbow: ['#ff4d4d', '#ffd84a', '#5be33c', '#3fc3ff', '#c26bff'], green: ['#5be33c', '#c6ff7a', '#5fd4ff'], galaxy: ['#c58bff', '#ffffff', '#5fd4ff'] }[poop.typeId];
    burst.fire(proj.p, colors, { up: 2.4, spread: 1.0 });
    floatText.show('+100', '#ffcc33', proj.p.clone().add(new THREE.Vector3(0, 0.25, 0)));
    toast('Nice Shot!', 'good');
    return;
  }
  if (hit.type === 'toilet') {
    jiggle.impulse(-8);
    sfx.splat(0.5);
    proj.spin *= 0.6;
    return;
  }
  if (hit.type === 'floor') {
    jiggle.impulse(-10 * Math.min(1, Math.abs(proj.v.y) + 0.3));
    proj.spin *= 0.4;
    if (!game.missAnnounced) {
      sfx.splat(0.8);
      resolveMiss(false);
    }
    if (proj.v.lengthSq() < 0.05) { proj.v.set(0, 0, 0); }
  }
}

function resolveMiss(lost) {
  game.missAnnounced = true;
  toast('Missed!', 'bad');
  sfx.boing();
  if (lost) { game.shot = 'settling'; game.shotTimer = 0.6; }
  else { game.settleStart = performance.now(); }
}

function endShot() {
  if (game.attempts >= SHOTS_PER_ROUND) {
    game.phase = 'over';
    hideGameplay();
    $('over-score').textContent = game.score;
    $('over-detail').textContent = `${game.hits} of ${game.attempts} shots landed in the bowl.`;
    if (game.mode === 'desktop' || xr.domOverlay) showScreen('screen-over');
    game.xrPanelMode = 'over';
    if (game.mode === 'xr') { layoutXRPanels(true); drawHud3d(); }
    return;
  }
  resetShot();
}

// ---------------------------------------------------------------------------------------------
// In-world HUD (XR)
// ---------------------------------------------------------------------------------------------
function drawHud3d() {
  hud3d.setRenderer((ctx, w, h, P) => {
    panelBackground(ctx, w, h);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    const mode = game.xrPanelMode;
    if (mode === 'pickToilet') {
      ctx.font = 'bold 34px Trebuchet MS, sans-serif';
      ctx.fillText('Choose a toilet', w / 2, 44);
      const cw = (w - 60) / 5;
      manifest.forEach((e, i) => {
        const x = 30 + i * cw, y = 78;
        P.button(`pick:${i}`, x + 4, y, cw - 8, cw + 26, '', { fill: i === selectedIndex ? '#ffcc33' : '#1d3a57' });
        const img = thumbImages[i];
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, x + 8, y + 4, cw - 16, cw - 16);
        ctx.fillStyle = i === selectedIndex ? '#10233a' : '#fff'; ctx.font = 'bold 20px Trebuchet MS, sans-serif';
        ctx.fillText(e.label, x + cw / 2, y + cw + 10);
      });
      P.button('cancelPick', w / 2 - 90, h - 74, 180, 54, 'Cancel');
      return;
    }
    if (mode === 'place') {
      ctx.font = 'bold 40px Trebuchet MS, sans-serif';
      ctx.fillText(`Place ${manifest[selectedIndex].label}`, w / 2, 70);
      ctx.font = '26px Trebuchet MS, sans-serif';
      ctx.fillText(xr.hitTestSource ? 'Look at the floor until the ring appears,' : 'Hit testing unavailable: using floor level.', w / 2, 140);
      ctx.fillText('then pinch or pull the trigger.', w / 2, 178);
      if (game.toastTimer > 0) { ctx.fillStyle = '#ffcc33'; ctx.fillText(game.toastText, w / 2, 230); }
      P.button('exit', w / 2 - 80, h - 70, 160, 50, 'Exit AR', { fill: '#3fc3ff' });
      return;
    }
    if (mode === 'over') {
      ctx.font = 'bold 44px Trebuchet MS, sans-serif';
      ctx.fillText('Round over!', w / 2, 60);
      ctx.fillStyle = '#ffcc33'; ctx.font = 'bold 72px Trebuchet MS, sans-serif';
      ctx.fillText(String(game.score), w / 2, 140);
      ctx.fillStyle = '#fff'; ctx.font = '26px Trebuchet MS, sans-serif';
      ctx.fillText(`${game.hits} of ${game.attempts} shots in the bowl`, w / 2, 200);
      P.button('again', 40, h - 80, 220, 56, 'Play Again');
      P.button('toilet', 280, h - 80, 140, 56, 'Toilet', { size: 24 });
      P.button('exit', 440, h - 80, w - 480, 56, 'Exit AR', { fill: '#3fc3ff', size: 24 });
      return;
    }
    // game
    ctx.textAlign = 'left';
    ctx.font = 'bold 22px Trebuchet MS, sans-serif'; ctx.fillStyle = '#9fb4c8';
    ctx.fillText('SCORE', 34, 42); ctx.fillText('HITS / SHOTS', 220, 42);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 56px Trebuchet MS, sans-serif';
    ctx.fillText(String(game.score), 32, 92);
    ctx.fillText(`${game.hits} / ${game.attempts}`, 218, 92);
    ctx.font = 'bold 24px Trebuchet MS, sans-serif'; ctx.fillStyle = '#ffcc33';
    ctx.fillText(`Poop: ${POOP_TYPES[poopTypeIndex].name}`, 34, 144);
    if (game.attempts === 0 || slingshot.held) {
      ctx.font = '20px Trebuchet MS, sans-serif'; ctx.fillStyle = '#9fb4c8';
      ctx.fillText(slingshot.held ? 'Holding it! Grab the poop with your other hand' : 'Grab the handle to hold it · grab the poop, pull, let go', 34, 192);
    }
    if (game.toastTimer > 0) { ctx.textAlign = 'right'; ctx.fillStyle = '#7be35a'; ctx.fillText(game.toastText, w - 34, 144); }
    const bw = (w - 60 - 30) / 4;
    ['poop', 'toilet', 'restart', 'exit'].forEach((id, i) => {
      P.button(id, 30 + i * (bw + 10), h - 82, bw, 58, ['Poop', 'Toilet', 'Restart', 'Exit'][i], { size: 24, fill: id === 'exit' ? '#3fc3ff' : undefined });
    });
  });
}
const thumbImages = [];
function loadThumbImages() { manifest.forEach((e, i) => { const im = new Image(); im.onload = () => game.xrPanelMode === 'pickToilet' && drawHud3d(); im.src = e.thumb; thumbImages[i] = im; }); }

// ---------------------------------------------------------------------------------------------
// Pointer input: desktop mouse
// ---------------------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const look = { yaw: 0, pitch: -0.22, dragging: false, lx: 0, ly: 0 };
const keys = new Set();
function applyLook() { camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ'); }
applyLook();

function uiTargets() {
  const t = [];
  if (radial?.mesh.visible) t.push(radial.mesh);
  if (hud3d.mesh.visible) t.push(hud3d.mesh);
  return t;
}

/** Hit test the in-world UI with a ray; returns { panel, id } or null. */
function hitUI(ray) {
  raycaster.ray.copy(ray);
  const hits = raycaster.intersectObjects(uiTargets(), false);
  for (const h of hits) {
    const panel = h.object.userData.panel;
    const id = panel.hitUV(h.uv);
    return { panel, id, distance: h.distance };
  }
  return null;
}
function clickUI(hit) {
  if (!hit || hit.id === null || hit.id === undefined) return false;
  if (hit.panel === radial.panel) {
    if (hit.id === 'close') radial.mesh.visible = false;
    else choosePoop(hit.id);
  } else action(hit.id);
  return true;
}

function poopHitByRay(ray, radius = 0.1) {
  const c = poop.root.position;
  const d = ray.distanceSqToPoint(c);
  if (d > radius * radius) return null;
  return ray.origin.distanceTo(c);
}

function floorHitFromRay(ray) {
  raycaster.ray.copy(ray);
  const floor = desktopEnv.getObjectByName('virtualFloor');
  const h = raycaster.intersectObject(floor, false)[0];
  return h ? h.point : null;
}

let hoverPanel = null;
function setHover(hit) {
  const p = hit?.panel || null;
  if (hoverPanel && hoverPanel !== p) hoverPanel.setHover(null);
  if (p) p.setHover(hit.id);
  hoverPanel = p;
}

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
const grabRadius = (e) => (e.pointerType === 'touch' ? 0.14 : 0.09); // fingers need a bigger target
function startLook(e) { look.dragging = true; look.pointerId = e.pointerId; look.lx = e.clientX; look.ly = e.clientY; }

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (game.mode !== 'desktop') return;
  sfx.initAudio();
  setMouse(e);
  if (e.button === 2) { startLook(e); return; }
  const ray = raycaster.ray.clone();
  if (clickUI(hitUI(ray))) return;
  if (game.phase === 'place') {
    // touch has no hover, so compute the floor point from the tap itself
    const p = floorHitFromRay(ray);
    if (p) { setReticle(p); placeToiletAt(reticle.matrix); }
    return;
  }
  if (game.phase === 'play' && poopHitByRay(ray, grabRadius(e)) !== null && startAim('screen')) {
    renderer.domElement.setPointerCapture(e.pointerId);
    setPullFromScreenRay(ray);
    return;
  }
  // dragging empty space looks around (the only way to turn on a phone)
  startLook(e);
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (game.mode !== 'desktop') return;
  if (look.dragging) {
    if (e.pointerId !== look.pointerId && look.pointerId !== undefined) return;
    const k = e.pointerType === 'touch' ? 0.006 : 0.004;
    look.yaw -= (e.clientX - look.lx) * k;
    look.pitch = THREE.MathUtils.clamp(look.pitch - (e.clientY - look.ly) * k, -1.3, 1.0);
    look.lx = e.clientX; look.ly = e.clientY;
    applyLook();
    if (game.phase === 'play' && game.shot === 'ready') resetShotPositionOnly();
    return;
  }
  setMouse(e);
  const ray = raycaster.ray.clone();
  if (aim.active) { setPullFromScreenRay(ray); return; }
  setHover(hitUI(ray));
  if (game.phase === 'place') {
    const p = floorHitFromRay(ray);
    reticle.visible = !!p;
    if (p) setReticle(p);
  }
  renderer.domElement.style.cursor = game.phase === 'play' && game.shot === 'ready' && poopHitByRay(ray, 0.09) !== null ? 'grab' : 'default';
});
function endPointer() {
  if (look.dragging) { look.dragging = false; look.pointerId = undefined; return; }
  if (game.mode === 'desktop' && aim.active) releaseAim();
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

function setMouse(e) {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
}

function setReticle(p, yawTowardHead = true) {
  const head = camera.getWorldPosition(_v3);
  const yaw = yawTowardHead ? Math.atan2(head.x - p.x, head.z - p.z) : 0;
  reticle.matrix.compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
  reticle.matrixWorldNeedsUpdate = true;
}

function updateDesktopMove(dt) {
  if (!keys.size || aim.active) return;
  const f = new THREE.Vector3(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const m = new THREE.Vector3();
  if (keys.has('KeyW')) m.add(f); if (keys.has('KeyS')) m.sub(f);
  if (keys.has('KeyD')) m.add(r); if (keys.has('KeyA')) m.sub(r);
  if (m.lengthSq() === 0) return;
  camera.position.addScaledVector(m.normalize(), dt * 1.6);
  if (game.phase === 'play' && game.shot === 'ready') resetShotPositionOnly();
}
function resetShotPositionOnly() {
  positionSlingshot();
  poop.root.position.copy(slingshot.seatWorld(ZERO, _v1));
  poop.root.quaternion.copy(slingshot.root.quaternion);
}

// ---------------------------------------------------------------------------------------------
// Hand models & poking (XR)
// ---------------------------------------------------------------------------------------------
// Full articulated hands rendered over the passthrough. three.js's XRHandModelFactory loads the official
// WebXR "generic-hand" meshes (jsDelivr CDN); if they can't be fetched we fall back to joint spheres.
const HAND_MESH_PATH = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/';
const handModels = new Map(); // XRInputSource -> { model, level }
let handsReady = false;
async function setupHandModels() {
  if (handsReady) return;
  handsReady = true;
  let profile = 'mesh';
  try {
    const r = await fetch(`${HAND_MESH_PATH}left.glb`, { method: 'HEAD' });
    if (!r.ok) throw new Error(r.status);
  } catch (e) {
    console.warn('Hand meshes unavailable, using joint spheres:', e);
    profile = 'spheres';
  }
  const factory = new XRHandModelFactory().setPath(HAND_MESH_PATH);
  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);
    const model = factory.createHandModel(hand, profile);
    hand.add(model);
    scene.add(hand);
    hand.addEventListener('connected', (e) => handModels.set(e.data, { model, level: 0 }));
    hand.addEventListener('disconnected', (e) => handModels.delete(e.data));
  }
}
const HAND_TINT = [0x000000, 0x5a4100, 0x1f6000]; // none / something in reach / holding
function tintHand(key, level) {
  const h = handModels.get(key);
  if (!h || h.level === level) return;
  h.level = level;
  h.model.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.tintable) { o.material = o.material.clone(); o.userData.tintable = true; }
    o.material.emissive?.setHex(HAND_TINT[level]);
  });
}

/** Index-fingertip pokes on in-world panels: press when the tip pushes through the panel surface. */
const pokeState = new Map(); // key -> { armed }
let pokeHover = null;
const _pk = new THREE.Vector3(), _ps = new THREE.Vector3();
function pokePanels(key, tip) {
  let st = pokeState.get(key);
  if (!st) pokeState.set(key, (st = { armed: true }));
  if (!tip) { st.armed = true; return; }
  let touching = false;
  for (const mesh of uiTargets()) {
    const { width, height } = mesh.geometry.parameters;
    const local = mesh.worldToLocal(_pk.copy(tip));
    if (Math.abs(local.x) > width / 2 || Math.abs(local.y) > height / 2) continue;
    const z = local.z * mesh.getWorldScale(_ps).z; // metres in front of the surface (+z faces the player)
    if (z > 0.08 || z < -0.05) continue;
    const panel = mesh.userData.panel;
    const id = panel.hitUV({ x: local.x / width + 0.5, y: local.y / height + 0.5 });
    if (id === null || id === undefined) continue;
    pokeHover = { panel, id };
    if (z < 0.01) {
      touching = true;
      if (st.armed) { st.armed = false; clickUI({ panel, id }); sfx.splat(0.2); }
    }
    break;
  }
  if (!touching) {
    // re-arm once the finger has moved back off the surface
    const anyClose = uiTargets().some((m) => { const l = m.worldToLocal(_pk.copy(tip)); return l.z * m.getWorldScale(_ps).z < 0.025 && l.z * m.getWorldScale(_ps).z > -0.05; });
    if (!anyClose) st.armed = true;
  }
}

// ---------------------------------------------------------------------------------------------
// XR input
//  - tracked hands & controllers: polled every frame and handed to the Interactors (grab the slingshot by its
//    handle, pinch/trigger the poop and pull back, point-and-pinch at UI). Select/squeeze events only record state.
//  - phone screen taps / gaze (transient inputs): select events, as before.
// ---------------------------------------------------------------------------------------------
const xr = { session: null, hitTestSource: null, refType: null, anchor: null, lastHit: null, activeSource: null, domOverlay: false };
const xrRays = [0, 1].map(() => {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.7 }));
  l.visible = false; l.frustumCulled = false;
  scene.add(l);
  return l;
});
const xrRay = new THREE.Ray();
const xrSnap = makeSnapshot();
const xrHeld = new Map(); // XRInputSource -> { select, squeeze }
const heldOf = (src) => { let h = xrHeld.get(src); if (!h) xrHeld.set(src, (h = { select: false, squeeze: false })); return h; };

function onXRSqueeze(ev) { if (ev.inputSource.targetRayMode === 'tracked-pointer') heldOf(ev.inputSource).squeeze = ev.type === 'squeezestart'; }

function onXRSelectStart(ev) {
  const frame = ev.frame, source = ev.inputSource;
  if (source.targetRayMode === 'tracked-pointer') { heldOf(source).select = true; return; } // handled by the Interactors
  const ref = renderer.xr.getReferenceSpace();
  if (!rayFromInput(frame, source, ref, xrRay)) return;
  // 1) in-world UI
  if (clickUI(hitUI(xrRay))) return;
  // 2) placement
  if (game.phase === 'place') {
    if (reticle.visible) placeToiletAt(reticle.matrix);
    return;
  }
  // 3) ray grab of the poop
  const d = poopHitByRay(xrRay, 0.12);
  if (game.phase === 'play' && d !== null) {
    const mode = source.targetRayMode === 'screen' ? 'screen' : 'ray';
    if (startAim(mode, source, d)) xr.activeSource = source;
  }
}
function onXRSelectEnd(ev) {
  if (ev.inputSource.targetRayMode === 'tracked-pointer') { heldOf(ev.inputSource).select = false; return; }
  if (aim.active && ev.inputSource === xr.activeSource) { releaseAim(); xr.activeSource = null; }
}

function updateXR(frame) {
  const ref = renderer.xr.getReferenceSpace();
  const session = renderer.xr.getSession();
  if (!session || !ref) return;

  // keep the toilet locked to its anchor (if the browser supports anchors)
  if (xr.anchor && placed && frame.trackedAnchors?.has(xr.anchor)) {
    const pose = frame.getPose(xr.anchor.anchorSpace, ref);
    if (pose) {
      const p = pose.transform.position;
      if (Math.abs(p.x - placed.root.position.x) + Math.abs(p.y - placed.root.position.y) + Math.abs(p.z - placed.root.position.z) > 0.002) {
        placed.root.position.set(p.x, p.y, p.z);
        world.floorY = p.y; world.refresh();
        toiletShadow.position.set(p.x, p.y + 0.002, p.z);
      }
    }
  }

  // placement reticle
  if (game.phase === 'place') {
    const head = camera.getWorldPosition(_v1);
    let pos = null;
    if (xr.hitTestSource) {
      const results = frame.getHitTestResults(xr.hitTestSource);
      for (const r of results) {
        const pose = r.getPose(ref);
        if (!pose) continue;
        const o = pose.transform.orientation;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
        const p = pose.transform.position;
        // horizontal surfaces clearly below the head (floor rather than a table/wall)
        if (up.y > 0.85 && p.y < head.y - 0.5) { pos = new THREE.Vector3(p.x, p.y, p.z); xr.lastHit = r; break; }
      }
    } else if (xr.refType === 'local-floor') {
      const dir = camera.getWorldDirection(_v2);
      if (dir.y < -0.05) { const t = -head.y / dir.y; pos = head.clone().addScaledVector(dir, t); xr.lastHit = null; }
    }
    reticle.visible = !!pos;
    if (pos) setReticle(pos);
  }

  // hands & controllers: interactors (grab/pull/UI), pointer rays and hover
  let idx = 0, hovered = null;
  pokeHover = null;
  for (const source of session.inputSources) {
    if (source.targetRayMode !== 'tracked-pointer') continue;
    readInput(frame, source, ref, heldOf(source), xrSnap);
    interactors.update(source, xrSnap);
    const line = xrRays[idx++];
    if (!xrSnap.ray || !line) continue;
    const hit = hitUI(xrSnap.ray);
    if (hit && !hovered) hovered = hit;
    // no laser while the hand is busy holding the slingshot or the poop
    line.visible = !interactors.busy(source);
    line.position.copy(xrSnap.ray.origin);
    line.quaternion.setFromUnitVectors(_fwd, xrSnap.ray.direction);
    line.scale.setScalar(hit ? hit.distance : 0.6);
  }
  setHover(pokeHover || hovered);
  for (; idx < xrRays.length; idx++) xrRays[idx].visible = false;

  // phone screen drag (transient input)
  if (aim.active && aim.source && aim.mode === 'screen' && rayFromInput(frame, aim.source, ref, xrRay)) setPullFromScreenRay(xrRay);
}
const _fwd = new THREE.Vector3(0, 0, -1);

// ---------------------------------------------------------------------------------------------
// Main loop (single loop for everything; no per-projectile loops)
// ---------------------------------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = time / 1000;
  tickPoopMaterials(t);

  if (frame && game.mode === 'xr') updateXR(frame);
  if (game.mode === 'desktop') updateDesktopMove(dt);

  if (game.phase === 'select' && previewObj && !renderer.xr.isPresenting) {
    previewObj.rotation.y += dt * 0.6;
    // frame the preview above the bottom selection panel
    camera.position.set(0, 1.6, 0); camera.rotation.set(-0.75, 0, 0);
  }

  if (placed && placed.popT < 1) {
    placed.popT = Math.min(1, placed.popT + dt * 3);
    const k = placed.popT, s = 1 + Math.sin(k * Math.PI) * 0.15 * (1 - k);
    placed.root.scale.setScalar(Math.max(0.01, easeOutBack(k)) * s);
    world.refresh();
  }

  if (slingshot) slingshot.update(dt);

  if (poop && poop.root.visible) {
    if (game.popIn < 1) { game.popIn = Math.min(1, game.popIn + dt * 4); poop.root.scale.setScalar(Math.max(0.01, easeOutBack(game.popIn))); }
    switch (game.shot) {
      case 'ready':
        // rides in the (possibly still springing, possibly hand-held) pouch
        slingshot.poopFromPouch(poop.root.position);
        poop.root.quaternion.copy(slingshot.root.quaternion);
        break;
      case 'aiming':
        updateAimVisuals(dt);
        break;
      case 'flying':
        updateFlight(dt);
        if (game.missAnnounced && game.shot === 'flying' && performance.now() - game.settleStart > 1300) { game.shot = 'settling'; game.shotTimer = 0.4; }
        break;
      case 'sinking': {
        game.shotTimer += dt;
        const k = Math.min(1, game.shotTimer / 0.6);
        poop.root.position.lerpVectors(proj.sinkFrom, proj.sinkTo, k * k);
        const fade = 1 - Math.max(0, (game.shotTimer - 0.6) / 0.5);
        poop.root.scale.setScalar(Math.max(0.01, fade));
        if (game.shotTimer > 1.15) endShot();
        break;
      }
      case 'settling':
        game.shotTimer -= dt;
        poop.root.scale.multiplyScalar(0.9);
        if (game.shotTimer <= 0) endShot();
        break;
    }
    jiggle.update(dt, t, game.shot === 'ready' || game.shot === 'aiming');
    poopShadow.visible = game.shot !== 'sinking' && game.phase === 'play';
    poopShadow.position.set(poop.root.position.x, world.floorY + 0.003, poop.root.position.z);
    const hgt = Math.max(0, poop.root.position.y - world.floorY);
    poopShadow.material.opacity = 0.35 / (1 + hgt * 1.5);
  }

  burst.update(dt);
  floatText.update(dt);
  if (game.toastTimer > 0) { game.toastTimer -= dt; if (game.toastTimer <= 0 && game.mode === 'xr') drawHud3d(); }

  renderer.render(scene, camera);
});

function easeOutBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }

let lastLowFraming = lowFraming();
window.addEventListener('resize', () => {
  fitCamera();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // phone rotated: re-frame the slingshot (and radial picker) for the new shape
  const low = lowFraming();
  if (game.mode === 'desktop' && low !== lastLowFraming) { look.pitch = low ? -0.4 : -0.22; applyLook(); }
  lastLowFraming = low;
  if (game.phase === 'play' && slingshot?.root.visible) {
    if (game.shot === 'ready' && game.mode === 'desktop') resetShotPositionOnly();
    else layoutXRPanels(false);
  }
});

window.__game = { game, PHYS, POOP_SIZE, get placed() { return placed; }, world, aim, startAim, setPullFromPoint, releaseAim, slingshot: () => slingshot, choosePoop, action, startDesktop, placeToiletAt, beginPlacement, setSelected: (i) => { selectedIndex = i; }, poop: () => poop, jiggle: () => jiggle, trajectory, radial: () => radial, hud3d, drawHud3d, camera, look, applyLook, get interactors() { return interactors; } };

boot().then(loadThumbImages);
