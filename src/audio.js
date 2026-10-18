// No sound assets were supplied, so every effect is synthesised with WebAudio.
// The context is created on the first user gesture (autoplay policies).
let ctx = null;
let master = null;
let stretchNode = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
}

function noiseBuffer(seconds) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function env(node, t0, a, peak, d) {
  node.gain.setValueAtTime(0.0001, t0);
  node.gain.exponentialRampToValueAtTime(peak, t0 + a);
  node.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}

/** Creaky rubber stretch; call with 0..1 while pulling, null to stop. */
export function stretch(amount) {
  if (!ctx) return;
  if (amount == null) {
    if (stretchNode) { stretchNode.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03); stretchNode.o.stop(ctx.currentTime + 0.2); stretchNode = null; }
    return;
  }
  if (!stretchNode) {
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    o.connect(f).connect(g).connect(master); o.start();
    stretchNode = { o, f, g };
  }
  const t = ctx.currentTime;
  stretchNode.o.frequency.setTargetAtTime(70 + amount * 140, t, 0.05);
  stretchNode.g.gain.setTargetAtTime(0.02 + amount * 0.06, t, 0.05);
}

export function launch() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.3);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
  f.frequency.setValueAtTime(2500, t); f.frequency.exponentialRampToValueAtTime(400, t + 0.25);
  const g = ctx.createGain(); env(g, t, 0.01, 0.6, 0.25);
  s.connect(f).connect(g).connect(master); s.start(t);
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.15);
  const g2 = ctx.createGain(); env(g2, t, 0.005, 0.4, 0.15);
  o.connect(g2).connect(master); o.start(t); o.stop(t + 0.2);
}

export function splat(strength = 1) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.25);
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
  const g = ctx.createGain(); env(g, t, 0.005, 0.7 * strength, 0.18);
  s.connect(f).connect(g).connect(master); s.start(t);
}

export function boing() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.45);
  const lfo = ctx.createOscillator(); lfo.frequency.value = 18;
  const lg = ctx.createGain(); lg.gain.value = 30; lfo.connect(lg).connect(o.frequency);
  const g = ctx.createGain(); env(g, t, 0.01, 0.35, 0.45);
  o.connect(g).connect(master); o.start(t); lfo.start(t); o.stop(t + 0.5); lfo.stop(t + 0.5);
}

export function flush() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(1.8);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
  f.frequency.setValueAtTime(500, t); f.frequency.linearRampToValueAtTime(1600, t + 0.5); f.frequency.exponentialRampToValueAtTime(250, t + 1.7);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.75);
  s.connect(f).connect(g).connect(master); s.start(t);
  // little victory arpeggio
  [523, 659, 784, 1046].forEach((hz, i) => {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = hz;
    const og = ctx.createGain(); env(og, t + i * 0.08, 0.005, 0.12, 0.14);
    o.connect(og).connect(master); o.start(t + i * 0.08); o.stop(t + i * 0.08 + 0.2);
  });
}
