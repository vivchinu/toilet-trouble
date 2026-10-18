# Toilet Trouble

A mixed-reality slingshot game built with Three.js and WebXR. A toilet appears on your real floor, and you fling cartoon poop into it with a slingshot.

**Play it:** https://vivchinu.github.io/toilet-trouble/
Open it in Meta Quest Browser or Android Chrome for AR. Any other browser plays it on screen.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 – desktop test mode
npm run dev:quest    # https://<your-PC-LAN-IP>:5173 – for the headset (self-signed HTTPS, LAN exposed)
npm run build        # production build in dist/
npm run deploy       # build + publish dist/ to the gh-pages branch (GitHub Pages)
```

GitHub Pages serves the `gh-pages` branch over HTTPS, which WebXR needs. That means the hosted link works directly on the Quest and on phones, with no certificate warning.

## Desktop test mode (no headset)

1. **Start Game**, pick a toilet (the 3D preview spins above the cards), then **Desktop Test Mode**.
2. Move the mouse over the virtual floor and **click** to place the toilet.
3. Use the radial menu to the right of the slingshot to pick one of the five poops: Classic Brown, Golden, Rainbow, Green Slime or Galaxy.
4. **Drag the poop** and release. Dragging down gives a higher arc, and dragging left or right aims the other way. The dotted arc is the exact predicted flight path. It turns **green** when the shot will land in the bowl and **orange** when it will hit the toilet body.
5. **Right-drag** to look around and **WASD** to move. The slingshot follows you between shots.
6. Each round is 10 shots. A hit scores +100. **Play Again**, **Restart**, **Change Poop** and **Change Toilet** all work.

Add `?debug` to the URL to show the scoring ellipse (green) and collision boxes (yellow/magenta) on the placed toilet.

Desktop mode uses a virtual floor. It is a test harness, not mixed reality.

## On a Meta Quest (or another immersive-AR browser)

1. Put the PC and headset on the same Wi-Fi and run `npm run dev:quest`.
2. In Quest Browser, open `https://<PC-IP>:5173` and accept the self-signed certificate warning.
3. Pick a toilet, then **Select & Place in AR** and allow the passthrough/AR permission.
4. Look at the floor until the blue ring appears, then **pinch** (hands) or **pull the trigger** (controllers) to place it. The toilet turns to face you.
5. **Hand tracking (no controllers):** your hands are drawn as full 3D hands (the official WebXR generic-hand models). Your whole hand interacts, not just one point:
   - **Grab the slingshot's handle** with a fist, or pinch it. Any finger touching the handle counts. The slingshot glows, turns with your wrist, and goes where you carry it. Open your hand to set it down; it stays there between shots.
   - **Grab or pinch the poop** with your other hand, pull it back, and **open your hand** to launch. The dotted arc shows the shot.
   - **Poke** the panel buttons and the round poop menu with your index fingertip; push through the surface to press. **Poke the poop** to make it wobble.
   - Your hand glows **yellow** when something is in reach and **green** while holding.
   - Pointing and pinching at buttons still works from a distance. If tracking loses your hand mid-pull, the shot is cancelled, not fired.
6. **Controllers:** hold the **grip** button near the handle to carry the slingshot. Use the **trigger** on the poop to pull and release. You can also point the laser at the poop and hold the trigger.
7. **Restart** (or placing a new toilet) puts the slingshot back in front of you.
6. The in-world panel to the left of the slingshot has Poop, Toilet, Restart and Exit. The radial poop picker sits to the right.

## On a phone

| Phone | What you get |
|---|---|
| Android + Chrome (ARCore-supported phone) | **Real AR.** The toilet goes on your real floor through the camera. |
| iPhone / iPad, or Android without ARCore | **Play without AR.** Touch controls with a virtual floor. Apple's browsers don't support WebXR AR. |

**Open it on the phone:** connect the phone to the same Wi-Fi as your PC and run `npm run dev:quest`. On the phone, open `https://<PC-IP>:5173` and tap through the certificate warning (*Advanced → Proceed*). The page needs HTTPS for the camera and AR.
If Android AR still refuses with that certificate, use USB instead. Run `adb reverse tcp:5173 tcp:5173` with `npm run dev`, then open `http://localhost:5173` in Chrome on the phone. `localhost` counts as secure.

**Android AR controls**
1. Pick a toilet, then **Select & Place in AR**, and allow camera access.
2. Point the phone at the floor and move it slowly until the blue ring appears. **Tap the screen** to place the toilet.
3. The slingshot sits just below the middle of the screen. **Put your finger on the poop, drag down/towards you, and let go.** The dotted arc shows where it will land and turns green for a hit.
4. The HTML HUD (score, Change Poop / Toilet, Restart, Exit AR) is drawn over the camera view. Tapping a button never also places or shoots.

**Play without AR (touch)**
- **Tap the floor** to place the toilet.
- **Drag the poop down** and let go to shoot.
- **Drag empty space** to look around. The slingshot follows your view.
- It works in portrait and landscape. The view re-frames when you rotate the phone.

## What's in it

| File | Purpose |
|---|---|
| `src/main.js` | Game state machine, one render loop, desktop and XR input, shot lifecycle, scoring, HUD |
| `src/assets.js` | GLB loading with cache, toilet normalisation (uniform scale to 0.8 m, base on floor, centred from the bounding box), bowl/collision data |
| `src/poop.js` | Poop loader, the 5 materials (body only, eyes untouched), the spring-based jiggle and squash/stretch |
| `src/slingshot.js` | Uses `isle_of_pigs_slingshot.glb`; drives its rubber-band bone so the real band stretches to the pouch |
| `src/physics.js` | Fixed-step ballistic sim, floor/toilet collisions, bowl-entry scoring, trajectory preview (same code as the flight) |
| `src/xr.js` | Support detection, `immersive-ar` session with hit-test (falls back to `local-floor`), per-frame hand/controller snapshots (pinch distance, pinch point, wrist pose, ray) |
| `src/interact.js` | Whole-hand and controller interaction: fist/pinch grab with reach from all 25 joints, carry the slingshot, pull the poop, fingertip poke on buttons and the poop, hand highlight. It has no WebXR calls, so it can be driven by simulated hands. |
| `src/ui3d.js` | Canvas-texture panels and the radial menu for in-headset UI |
| `src/effects.js`, `src/audio.js` | Reticle, contact shadows, particle burst; synthesised WebAudio SFX (no sound assets were supplied) |
| `public/models/` | `toilet_01..05.glb`, `poop.glb`, `slingshot.glb`, `toilets.json` (bowl opening per toilet) |
| `public/thumbs/` | Toilet thumbnails rendered in Blender |
| `tools/` | Blender scripts used to export the 5 toilets and measure each bowl |

### The five toilets

They were picked from the 55-toilet `SkibidiToiletsProps.blend` for visual variety and an open, reachable bowl. All five use identical gameplay rules.

| In game | Object in .blend |
|---|---|
| Toilet 1 | `6.1` (classic) |
| Toilet 2 | `1.1` (gadget toilet) |
| Toilet 3 | `12.1` (pillars) |
| Toilet 4 | `16.1` (armoured) |
| Toilet 5 | `18.1` (jet engines) |

Each was exported with its hidden 30° rotation cleared so it faces +Z. Its bowl opening (centre, radii, rim height) was measured with a downward ray-cast heightmap and stored in `toilets.json`. To swap in a different toilet, change the `picks` map in `tools/export_toilets.py`, then re-run the three tools scripts with Blender (`blender -b <file.blend> --python tools/... -- <out dir>`).

## Verified here (desktop, Chromium)

- All 5 toilets load, preview, place and can be swapped. The scoring ellipse sits inside each bowl (checked visually in `?debug`).
- On all five toilets, 15 shots the preview predicted would score did score, and 5 predicted misses missed.
- The preview hides on launch, misses reset, a round ends after 10 shots, and Play Again works.
- All 5 materials render. The idle jiggle, pull squash, launch stretch and landing squash all run.
- The production build succeeds.

## Not verified / known limitations

- **Phone AR (Android Chrome) was not tested on a real phone.** The touch/no-AR mode was tested in a 375×812 portrait and 812×375 landscape phone emulation, including tap-to-place, touch drag-shoot, the radial picker and rotation. The AR path (screen-tap select events, DOM overlay, `beforexrselect`) follows the WebXR spec but needs a real ARCore phone.
- **Hand interaction was verified with simulated 25-joint hands, not real ones.** Desktop tests fed fake open, pinching and fist hands through the same code and confirmed:
  - fist-grab of the handle, and grabbing by a single finger touching it;
  - carry/rotate, and release on opening the hand;
  - fist and pinch pull with launch on open;
  - an empty fist does nothing;
  - fingertip poke on the radial menu and panel buttons (one press per push, re-arms after pulling back);
  - poke-to-jiggle, and cancel when a hand is lost.

  The thresholds (pinch 2/3.5 cm, fist curl 10.5/13 cm, reach 3.5–9 cm) may need tuning on a real Quest.
- Hand meshes load from the jsDelivr CDN (about 94 KB each). Without internet, the hands fall back to joint spheres.
- The poop sits between the forks. When loaded, the band's centre sits about 5 cm behind and 3.5 cm below the poop, so the strap cups it from behind and its face stays visible. Preview and launch both use the poop's centre (re-verified).
- **WebXR was not tested on a headset.** No device was available. Session start, hit-test placement, anchors, the pinch/trigger grab and the in-world panels are implemented to the WebXR spec, but they need a run on the Quest.
- Hit test uses the head gaze (viewer space) and only accepts horizontal surfaces at least 0.5 m below your head. Tables are ignored on purpose.
- Toilet collision is approximated by two boxes plus the bowl ellipse. Thin side gadgets on toilets 2 and 4 are inside the boxes, so a shot clipping them bounces.
- A shot that banks off the tank and drops into the bowl counts. It enters the opening from above, which is the rule.
- Sounds are synthesised. Drop real files into `public/` and swap the calls in `src/audio.js` if you prefer.
- The radial menu and HUD are 3D panels in AR. HTML overlay is only used when the browser supports `dom-overlay` (e.g. Android Chrome). Quest Browser does not.
