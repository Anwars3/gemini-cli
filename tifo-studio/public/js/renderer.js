// Canvas renderer that draws a scene at time t in a flat, textured "Tifo" style.
import {
  PITCH, sampleKF, alphaAt, inWindow, arrowPath, handlesFor, chainPts, clamp, easeInOut,
} from './model.js';

export const FONT = '"Oswald", "Bebas Neue", Impact, "Arial Narrow", sans-serif';
const TAU = Math.PI * 2;
const LINE = '#ece6d3';
const STYLE_COLORS = { pass: '#f4f1e6', run: '#f2c14e', dribble: '#f4f1e6', line: '#ffffff' };
const LAYER = { zone: 0, chain: 1, arrow: 2, player: 3, ball: 4, text: 5 };
const SEL = '#5ad1ff';
// Text is drawn at TS× size then scaled down: keeps glyphs crisp at metre-scale font sizes.
const TS = 20;

function rgb(hex) {
  let c = String(hex || '#000').replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const n = parseInt(c, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function shade(hex, amt) {
  const f = (v) => Math.round(clamp(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt, 0, 255));
  const [r, g, b] = rgb(hex);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
const withAlpha = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;
const luminance = (hex) => {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

function makeNoise() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const d = g.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = Math.random() * 28;
  }
  g.putImageData(d, 0, 0);
  return c;
}

function wrap(g, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (g.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.W = canvas.width;
    this.H = canvas.height;
    this.base = Math.min((this.W - 160) / PITCH.w, (this.H - 160) / PITCH.h);
    this.noise = makeNoise();
    this.noisePattern = this.g.createPattern(this.noise, 'repeat');
    this.images = new Map();
  }

  camAt(scene, t, useCamera = true) {
    if (!useCamera || !scene.camera?.length) return { cx: PITCH.w / 2, cy: PITCH.h / 2, zoom: 1 };
    return sampleKF(scene.camera, t, ['cx', 'cy', 'zoom']);
  }
  viewSize(zoom = 1) {
    return { w: this.W / (this.base * zoom), h: this.H / (this.base * zoom) };
  }
  toWorld(px, py, cam) {
    const s = this.base * cam.zoom;
    return { x: (px - this.W / 2) / s + cam.cx, y: (py - this.H / 2) / s + cam.cy };
  }

  image(src) {
    if (!src) return null;
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.onImageLoad?.();
      img.src = src;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  // Text in world units (metres), rendered crisp via a scale trick.
  text(txt, x, y, size, { weight = 700, fill = '#fff', stroke = null, strokeW = 0, align = 'center' } = {}) {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.scale(1 / TS, 1 / TS);
    g.font = `${weight} ${size * TS}px ${FONT}`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    if (stroke) {
      g.lineJoin = 'round';
      g.lineWidth = strokeW * TS;
      g.strokeStyle = stroke;
      g.strokeText(txt, 0, 0);
    }
    g.fillStyle = fill;
    g.fillText(txt, 0, 0);
    g.restore();
  }
  measure(txt, size, weight = 700) {
    const g = this.g;
    g.save();
    g.font = `${weight} ${size * TS}px ${FONT}`;
    const w = g.measureText(txt).width / TS;
    g.restore();
    return w;
  }

  // opts: { editor, sel:[ids], useCamera, temp, showCaptions }
  draw(project, sc, t, o = {}) {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.setLineDash([]);
    if (sc.kind === 'card') this.drawCard(project, sc, t);
    else this.drawPitchScene(project, sc, t, o);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    if (o.showCaptions && sc.caption) this.drawCaption(sc.caption, o.editor ? 1 : clamp(t / 0.35, 0, 1));
    this.drawGrain();
    if (!o.editor && sc.transition === 'fade' && t < 0.5) {
      g.fillStyle = `rgba(0,0,0,${1 - easeInOut(t / 0.5)})`;
      g.fillRect(0, 0, this.W, this.H);
    }
  }

  drawGrain() {
    const g = this.g;
    g.fillStyle = this.noisePattern;
    g.fillRect(0, 0, this.W, this.H);
    if (!this.vignette) {
      const v = g.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.42, this.W / 2, this.H / 2, this.W * 0.72);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.38)');
      this.vignette = v;
    }
    g.fillStyle = this.vignette;
    g.fillRect(0, 0, this.W, this.H);
  }

  drawCaption(text, a) {
    const g = this.g;
    g.save();
    g.globalAlpha = a;
    g.font = `500 44px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = wrap(g, text, this.W - 520);
    const lh = 56;
    const h = lines.length * lh + 28;
    const maxW = Math.max(...lines.map((l) => g.measureText(l).width));
    const y0 = this.H - 64 - h;
    g.fillStyle = 'rgba(14,18,16,0.78)';
    g.beginPath();
    g.roundRect(this.W / 2 - maxW / 2 - 34, y0, maxW + 68, h, 8);
    g.fill();
    g.fillStyle = '#fff';
    lines.forEach((l, i) => g.fillText(l, this.W / 2, y0 + 14 + lh * i + lh / 2));
    g.restore();
  }

  drawCard(project, sc, t) {
    const g = this.g;
    const { W, H } = this;
    g.fillStyle = sc.bg || '#e8dfc8';
    g.fillRect(0, 0, W, H);
    const img = this.image(sc.image && project.assets?.[sc.image]);
    if (img) {
      // slow "Ken Burns" push-in
      const z = 1 + 0.08 * (t / Math.max(0.1, sc.duration));
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * z;
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      if (sc.title || sc.subtitle) {
        const grad = g.createLinearGradient(0, H * 0.35, 0, H);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.7)');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
    } else {
      // soft diagonal paper bands for a printed-poster feel
      g.save();
      g.globalAlpha = 0.06;
      g.fillStyle = luminance(sc.bg || '#e8dfc8') > 0.5 ? '#000' : '#fff';
      for (let i = -H; i < W; i += 140) {
        g.beginPath();
        g.moveTo(i, H);
        g.lineTo(i + 70, H);
        g.lineTo(i + 70 + H, 0);
        g.lineTo(i + H, 0);
        g.fill();
      }
      g.restore();
    }
    const ink = img || luminance(sc.bg || '#e8dfc8') < 0.5 ? '#f6f1e4' : '#1d2621';
    const accent = project.teams.home.color;
    const p = easeInOut(clamp(t / 0.9, 0, 1));
    const p2 = easeInOut(clamp((t - 0.35) / 0.9, 0, 1));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 124px ${FONT}`;
    const lines = sc.title ? wrap(g, sc.title.toUpperCase(), W - 320) : [];
    g.font = `400 48px ${FONT}`;
    const sub = sc.subtitle ? wrap(g, sc.subtitle, W - 420) : [];
    const blockH = lines.length * 130 + (sub.length ? 30 + sub.length * 60 : 0);
    const cy = img ? H * 0.74 : H * 0.5;
    let y = cy - blockH / 2;
    g.globalAlpha = p;
    g.fillStyle = accent;
    const bw = 240 * p;
    g.fillRect(W / 2 - bw / 2, y - 46, bw, 12);
    g.fillStyle = ink;
    g.font = `700 124px ${FONT}`;
    for (const l of lines) {
      g.fillText(l, W / 2, y + 65 + (1 - p) * 40);
      y += 130;
    }
    g.globalAlpha = p2;
    g.font = `400 48px ${FONT}`;
    y += 30;
    for (const l of sub) {
      g.fillText(l, W / 2, y + 30 + (1 - p2) * 30);
      y += 60;
    }
    g.globalAlpha = 1;
  }

  drawPitch() {
    const g = this.g;
    const L = PITCH.w;
    const Wd = PITCH.h;
    const stripes = 14;
    const sw = (L + 16) / stripes;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? '#3b7245' : '#417a4b';
      g.fillRect(-8 + i * sw, -8, sw + 0.02, Wd + 16);
    }
    g.strokeStyle = LINE;
    g.lineWidth = 0.22;
    g.setLineDash([]);
    const line = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    const arc = (x, y, r, a0, a1) => { g.beginPath(); g.arc(x, y, r, a0, a1); g.stroke(); };
    const spot = (x, y) => { g.fillStyle = LINE; g.beginPath(); g.arc(x, y, 0.3, 0, TAU); g.fill(); };
    const D = Math.acos(5.5 / 9.15);
    g.strokeRect(0, 0, L, Wd);
    line(L / 2, 0, L / 2, Wd);
    arc(L / 2, Wd / 2, 9.15, 0, TAU);
    spot(L / 2, Wd / 2);
    g.strokeRect(0, 13.84, 16.5, 40.32);
    g.strokeRect(0, 24.84, 5.5, 18.32);
    spot(11, 34);
    arc(11, 34, 9.15, -D, D);
    g.strokeRect(L - 16.5, 13.84, 16.5, 40.32);
    g.strokeRect(L - 5.5, 24.84, 5.5, 18.32);
    spot(L - 11, 34);
    arc(L - 11, 34, 9.15, Math.PI - D, Math.PI + D);
    arc(0, 0, 1, 0, Math.PI / 2);
    arc(L, 0, 1, Math.PI / 2, Math.PI);
    arc(0, Wd, 1, -Math.PI / 2, 0);
    arc(L, Wd, 1, Math.PI, Math.PI * 1.5);
    g.strokeRect(-2, 30.34, 2, 7.32);
    g.strokeRect(L, 30.34, 2, 7.32);
  }

  drawPitchScene(project, sc, t, o) {
    const g = this.g;
    const cam = this.camAt(sc, t, o.useCamera !== false);
    const s = this.base * cam.zoom;
    g.fillStyle = '#2a5332';
    g.fillRect(0, 0, this.W, this.H);
    g.setTransform(s, 0, 0, s, this.W / 2 - cam.cx * s, this.H / 2 - cam.cy * s);
    this.drawPitch();

    const list = [...sc.objects].sort((a, b) => LAYER[a.type] - LAYER[b.type]);
    for (const ob of list) {
      const a = o.editor ? (inWindow(ob, t) ? 1 : 0.15) : alphaAt(ob, t);
      if (a <= 0) continue;
      g.save();
      g.globalAlpha = a;
      this.drawObj(project, sc, ob, t, o, false);
      g.restore();
    }
    if (o.temp) {
      g.save();
      g.globalAlpha = 0.85;
      if (o.temp.type === 'camrect') {
        g.setLineDash([1.2, 0.8]);
        g.lineWidth = 0.35 / cam.zoom;
        g.strokeStyle = SEL;
        g.strokeRect(o.temp.x, o.temp.y, o.temp.w, o.temp.h);
      } else this.drawObj(project, sc, o.temp, t, o, true);
      g.restore();
    }
    if (o.editor) this.drawEditorOverlay(sc, t, o, cam);
  }

  drawEditorOverlay(sc, t, o, cam) {
    const g = this.g;
    const hr = 0.75 / cam.zoom;
    g.save();
    g.lineWidth = 0.25 / cam.zoom;
    for (const id of o.sel || []) {
      const ob = sc.objects.find((x) => x.id === id);
      if (!ob) continue;
      g.strokeStyle = SEL;
      g.setLineDash([0.8 / cam.zoom, 0.5 / cam.zoom]);
      if (ob.kf) {
        const p = sampleKF(ob.kf, t);
        // motion path preview
        if (ob.kf.length > 1) {
          g.save();
          g.setLineDash([0.4, 0.4]);
          g.strokeStyle = 'rgba(90,209,255,0.6)';
          g.beginPath();
          const t0 = ob.kf[0].t;
          const t1 = ob.kf[ob.kf.length - 1].t;
          for (let i = 0; i <= 40; i++) {
            const q = sampleKF(ob.kf, t0 + ((t1 - t0) * i) / 40);
            if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y);
          }
          g.stroke();
          g.fillStyle = SEL;
          for (const k of ob.kf) { g.beginPath(); g.arc(k.x, k.y, 0.35, 0, TAU); g.fill(); }
          g.restore();
        }
        g.beginPath();
        g.arc(p.x, p.y, ob.type === 'ball' ? 1.3 : 2.2, 0, TAU);
        g.stroke();
      } else if (ob.type === 'zone') {
        g.strokeRect(ob.x - 0.4, ob.y - 0.4, ob.w + 0.8, ob.h + 0.8);
      } else if (ob.type === 'text') {
        const w = this.measure(ob.text.toUpperCase(), ob.size);
        g.strokeRect(ob.x - w / 2 - 0.5, ob.y - ob.size / 2 - 0.4, w + 1, ob.size + 0.8);
      } else if (ob.type === 'chain') {
        const pts = chainPts(sc, ob, t);
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
      if ((o.sel || []).length === 1) {
        g.setLineDash([]);
        for (const h of handlesFor(ob)) {
          g.fillStyle = SEL;
          g.strokeStyle = '#fff';
          g.beginPath();
          g.arc(h.x, h.y, hr, 0, TAU);
          g.fill();
          g.stroke();
        }
      }
    }
    if (o.useCamera === false && sc.camera?.length) {
      const c = sampleKF(sc.camera, t, ['cx', 'cy', 'zoom']);
      const v = this.viewSize(c.zoom);
      g.setLineDash([1.4, 0.8]);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 0.3;
      g.strokeRect(c.cx - v.w / 2, c.cy - v.h / 2, v.w, v.h);
      this.text('CAMERA', c.cx - v.w / 2 + 0.6, c.cy - v.h / 2 + 1.4, 1.4, { fill: '#fff', align: 'left' });
    }
    g.restore();
  }

  drawObj(project, sc, ob, t, o, isTemp) {
    const g = this.g;
    switch (ob.type) {
      case 'player': {
        const p = sampleKF(ob.kf, t);
        const team = project.teams[ob.team] || project.teams.home;
        const col = ob.color || team.color;
        const r = 1.35;
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.beginPath();
        g.ellipse(p.x + 0.3, p.y + 0.45, r, r * 0.92, 0, 0, TAU);
        g.fill();
        if (ob.highlight) {
          const pulse = 1 + 0.12 * Math.sin(t * 6);
          g.beginPath();
          g.arc(p.x, p.y, (r + 0.95) * pulse, 0, TAU);
          g.fillStyle = 'rgba(242,193,78,0.2)';
          g.fill();
          g.strokeStyle = '#f2c14e';
          g.lineWidth = 0.3;
          g.stroke();
        }
        g.fillStyle = col;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, TAU);
        g.fill();
        g.lineWidth = 0.28;
        g.strokeStyle = shade(col, -0.42);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.13)';
        g.beginPath();
        g.arc(p.x, p.y, r - 0.14, Math.PI * 1.05, Math.PI * 1.95);
        g.fill();
        this.text(String(ob.num ?? ''), p.x, p.y + 0.06, 1.45, { fill: team.text || '#fff' });
        if (ob.name) {
          const label = ob.name.toUpperCase();
          const tw = this.measure(label, 1.1, 600);
          const y = p.y + r + 1.25;
          g.fillStyle = 'rgba(16,20,18,0.8)';
          g.beginPath();
          g.roundRect(p.x - tw / 2 - 0.45, y - 0.78, tw + 0.9, 1.56, 0.35);
          g.fill();
          this.text(label, p.x, y + 0.03, 1.1, { weight: 600, fill: '#fff' });
        }
        break;
      }
      case 'ball': {
        const p = sampleKF(ob.kf, t);
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.beginPath();
        g.ellipse(p.x + 0.2, p.y + 0.3, 0.6, 0.5, 0, 0, TAU);
        g.fill();
        g.fillStyle = '#fbfaf5';
        g.beginPath();
        g.arc(p.x, p.y, 0.62, 0, TAU);
        g.fill();
        g.lineWidth = 0.14;
        g.strokeStyle = '#1b1b1b';
        g.stroke();
        g.fillStyle = '#1b1b1b';
        g.beginPath();
        g.arc(p.x, p.y, 0.2, 0, TAU);
        g.fill();
        break;
      }
      case 'arrow': {
        let p = 1;
        if (!o.editor && !isTemp) p = easeInOut(clamp((t - (ob.in || 0)) / Math.max(0.01, ob.dur || 0.8), 0, 1));
        if (p <= 0) return;
        const pts = arrowPath(ob, p);
        const col = ob.color || STYLE_COLORS[ob.style] || '#fff';
        const lw = ob.style === 'run' ? 0.5 : ob.style === 'line' ? 0.3 : 0.38;
        const path = (dx, dy) => {
          g.beginPath();
          pts.forEach(([x, y], i) => (i ? g.lineTo(x + dx, y + dy) : g.moveTo(x + dx, y + dy)));
        };
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.setLineDash(ob.style === 'pass' ? [1.1, 0.8] : []);
        g.lineWidth = lw;
        g.strokeStyle = 'rgba(0,0,0,0.25)';
        path(0.18, 0.24);
        g.stroke();
        g.strokeStyle = col;
        path(0, 0);
        g.stroke();
        g.setLineDash([]);
        if (ob.style !== 'line' && pts.length > 2) {
          const [x, y] = pts[pts.length - 1];
          const [px, py] = pts[Math.max(0, pts.length - 5)];
          const ang = Math.atan2(y - py, x - px);
          const sz = 1.5;
          g.fillStyle = col;
          g.beginPath();
          g.moveTo(x + Math.cos(ang) * sz * 0.35, y + Math.sin(ang) * sz * 0.35);
          g.lineTo(x + Math.cos(ang + 2.6) * sz, y + Math.sin(ang + 2.6) * sz);
          g.lineTo(x + Math.cos(ang - 2.6) * sz, y + Math.sin(ang - 2.6) * sz);
          g.closePath();
          g.fill();
        }
        break;
      }
      case 'chain': {
        const pts = chainPts(sc, ob, t);
        if (pts.length < 2) return;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.lineWidth = 0.32;
        g.strokeStyle = ob.color || '#fff';
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
        break;
      }
      case 'zone': {
        const col = ob.color || '#f2c14e';
        let k = 1;
        if (!o.editor && !isTemp && ob.in > 0) k = 0.85 + 0.15 * easeInOut(clamp((t - ob.in) / 0.4, 0, 1));
        g.translate(ob.x + ob.w / 2, ob.y + ob.h / 2);
        g.scale(k, k);
        g.beginPath();
        if (ob.shape === 'ellipse') g.ellipse(0, 0, ob.w / 2, ob.h / 2, 0, 0, TAU);
        else g.rect(-ob.w / 2, -ob.h / 2, ob.w, ob.h);
        g.fillStyle = withAlpha(col, 0.26);
        g.fill();
        g.setLineDash([0.9, 0.6]);
        g.lineWidth = 0.28;
        g.strokeStyle = col;
        g.stroke();
        break;
      }
      case 'text': {
        this.text(String(ob.text || '').toUpperCase(), ob.x, ob.y, ob.size || 3, {
          fill: ob.color || '#fff', stroke: 'rgba(15,20,17,0.85)', strokeW: (ob.size || 3) * 0.14,
        });
        break;
      }
    }
  }
}
