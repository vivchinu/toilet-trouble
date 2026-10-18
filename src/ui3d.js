import * as THREE from 'three';

/**
 * World-space UI drawn into a canvas texture. Used inside immersive AR where HTML overlays are usually
 * not available (e.g. Quest Browser), and for the radial poop picker in every mode.
 * Interaction is by ray (mouse, controller, hand pinch ray, screen tap) -> uv -> button.
 */
export class Panel3D {
  constructor(widthM, heightM, pxPerM = 1400) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(widthM * pxPerM);
    this.canvas.height = Math.round(heightM * pxPerM);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    );
    this.mesh.renderOrder = 10;
    this.mesh.userData.panel = this;
    this.buttons = [];
    this.hover = null;
    this.renderFn = null;
  }
  setRenderer(fn) { this.renderFn = fn; this.redraw(); }
  redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.buttons = [];
    if (this.renderFn) this.renderFn(ctx, canvas.width, canvas.height, this);
    this.texture.needsUpdate = true;
  }
  /** Draw and register a button. */
  button(id, x, y, w, h, label, opts = {}) {
    const { ctx } = this;
    const hot = this.hover === id;
    roundRect(ctx, x, y, w, h, h * 0.28);
    ctx.fillStyle = opts.fill || (hot ? '#ffe27a' : '#ffcc33');
    ctx.fill();
    if (hot) { ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
    ctx.fillStyle = opts.color || '#10233a';
    ctx.font = `bold ${opts.size || Math.round(h * 0.42)}px Trebuchet MS, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 2);
    this.buttons.push({ id, x, y, w, h });
  }
  hitUV(uv) {
    const px = uv.x * this.canvas.width, py = (1 - uv.y) * this.canvas.height;
    const b = this.buttons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    return b ? b.id : null;
  }
  setHover(id) { if (id !== this.hover) { this.hover = id; this.redraw(); } }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function panelBackground(ctx, w, h) {
  roundRect(ctx, 4, 4, w - 8, h - 8, 36);
  ctx.fillStyle = 'rgba(13, 27, 42, 0.86)'; ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = '#3fc3ff'; ctx.stroke();
}

/**
 * Radial picker: N wedges around a centre hub. hitUV returns the wedge index (or 'close' for the hub).
 */
export class RadialMenu {
  constructor(items, sizeM = 0.26) {
    this.items = items;           // [{ id, name, icon: HTMLImageElement|null, swatch }]
    this.selected = 0;
    this.hover = -1;
    this.panel = new Panel3D(sizeM, sizeM, 2000);
    this.panel.hitUV = (uv) => this.hit(uv);
    this.panel.setHover = (id) => { const i = id === 'close' ? -2 : typeof id === 'number' ? id : -1; if (i !== this.hover) { this.hover = i; this.redraw(); } };
    this.mesh = this.panel.mesh;
    this.redraw();
  }
  hit(uv) {
    const dx = uv.x - 0.5, dy = uv.y - 0.5;
    const r = Math.hypot(dx, dy);
    if (r > 0.5) return null;
    if (r < 0.17) return 'close';
    const n = this.items.length;
    let a = Math.atan2(dx, dy); // 0 at top, clockwise
    if (a < 0) a += Math.PI * 2;
    return Math.floor(((a + Math.PI / n) % (Math.PI * 2)) / ((Math.PI * 2) / n));
  }
  redraw() {
    const { ctx, canvas } = this.panel;
    const W = canvas.width, c = W / 2, R = W * 0.49, r0 = W * 0.17;
    const n = this.items.length;
    ctx.clearRect(0, 0, W, W);
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + (i - 0.5) * (Math.PI * 2) / n, a1 = a0 + (Math.PI * 2) / n;
      ctx.beginPath(); ctx.arc(c, c, R, a0 + 0.02, a1 - 0.02); ctx.arc(c, c, r0 + 8, a1 - 0.05, a0 + 0.05, true); ctx.closePath();
      ctx.fillStyle = i === this.selected ? 'rgba(255, 204, 51, 0.92)' : i === this.hover ? 'rgba(63, 195, 255, 0.85)' : 'rgba(13, 27, 42, 0.86)';
      ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = '#3fc3ff'; ctx.stroke();
      const am = (a0 + a1) / 2, rm = (R + r0) / 2 + 6;
      const x = c + Math.cos(am) * rm, y = c + Math.sin(am) * rm;
      const it = this.items[i];
      const sz = W * 0.2;
      if (it.icon && it.icon.complete && it.icon.naturalWidth) ctx.drawImage(it.icon, x - sz / 2, y - sz / 2 - 18, sz, sz);
      ctx.fillStyle = i === this.selected ? '#10233a' : '#fff';
      ctx.font = `bold ${Math.round(W * 0.042)}px Trebuchet MS, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(it.short || it.name, x, y + sz / 2 - 6);
    }
    ctx.beginPath(); ctx.arc(c, c, r0, 0, Math.PI * 2);
    ctx.fillStyle = this.hover === -2 ? '#3fc3ff' : 'rgba(13, 27, 42, 0.95)'; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = '#3fc3ff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(W * 0.045)}px Trebuchet MS, sans-serif`;
    ctx.fillText('SELECT', c, c - W * 0.03); ctx.fillText('POOP', c, c + W * 0.03);
    this.panel.texture.needsUpdate = true;
  }
  setSelected(i) { this.selected = i; this.redraw(); }
}

/** A camera-facing text label (canvas sprite) – used for "+100", "Nice Shot!" etc. Re-uses one canvas. */
export class FloatingText {
  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = 512; this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, toneMapped: false }));
    this.sprite.scale.set(0.42, 0.13, 1);
    this.sprite.renderOrder = 20;
    this.sprite.visible = false;
    this.t = 0; this.life = 0;
  }
  show(text, color, pos) {
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, 512, 160);
    g.font = 'bold 96px Trebuchet MS, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 14; g.strokeStyle = '#10233a'; g.strokeText(text, 256, 84);
    g.fillStyle = color; g.fillText(text, 256, 84);
    this.tex.needsUpdate = true;
    this.sprite.position.copy(pos);
    this.base = pos.clone();
    this.sprite.visible = true; this.t = 0; this.life = 1.4;
  }
  update(dt) {
    if (!this.sprite.visible) return;
    this.t += dt;
    const k = this.t / this.life;
    this.sprite.position.copy(this.base).y += k * 0.25;
    const pop = Math.min(1, this.t * 8);
    const s = 0.6 + 0.4 * pop + (k > 0.8 ? 0 : 0);
    this.sprite.scale.set(0.42 * s, 0.13 * s, 1);
    this.sprite.material.opacity = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    if (k >= 1) this.sprite.visible = false;
  }
}
