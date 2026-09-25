// Tifo Studio editor UI.
import * as M from './model.js';
import { Renderer, FONT } from './renderer.js';
import { AudioEngine } from './audio.js';
import { exportVideo, buildSRT, projectDuration } from './exporter.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const r2 = (v) => Math.round(v * 100) / 100;
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

const canvas = $('#stage');
const R = new Renderer(canvas);
const A = new AudioEngine();
R.onImageLoad = () => draw();

const S = {
  project: null, si: 0, t: 0, sel: [], tool: 'select', drag: null, temp: null,
  playing: null, previewCam: true, undo: [], redo: [], pending: null, recording: false, exporting: null,
};
const scene = () => S.project.scenes[S.si];
const findObj = (id) => scene().objects.find((o) => o.id === id);

// ---------- undo / autosave ----------

function snapshot() {
  const { assets, ...rest } = S.project;
  return JSON.stringify({ p: rest, si: S.si });
}
function pushUndo(snap = snapshot()) {
  S.undo.push(snap);
  if (S.undo.length > 150) S.undo.shift();
  S.redo = [];
}
function restore(snap) {
  const { p, si } = JSON.parse(snap);
  p.assets = S.project.assets;
  S.project = p;
  S.si = Math.min(si, p.scenes.length - 1);
  S.t = Math.min(S.t, scene().duration);
  S.sel = [];
  refreshAll();
  autosave();
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  restore(S.undo.pop());
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  restore(S.redo.pop());
}

let saveTimer = 0;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('tifo-autosave', JSON.stringify(S.project));
    } catch {
      try {
        // Too big with audio; keep the structure at least.
        localStorage.setItem('tifo-autosave', JSON.stringify({ ...S.project, assets: {} }));
      } catch { /* storage unavailable */ }
    }
  }, 600);
}

function pruneAssets(p) {
  const used = new Set([p.music, ...p.scenes.flatMap((s) => [s.audio, s.image])].filter(Boolean));
  for (const k of Object.keys(p.assets)) if (!used.has(k)) delete p.assets[k];
  return p;
}

function setProject(p) {
  stop();
  p.assets ||= {};
  S.project = p;
  S.si = Math.min(1, p.scenes.length - 1);
  S.t = 0;
  S.sel = [];
  S.undo = [];
  S.redo = [];
  A.preload(p).then(() => renderProps());
  refreshAll();
  autosave();
}

function changed() {
  autosave();
  draw();
}
function changedAll() {
  autosave();
  refreshAll();
}

// ---------- drawing ----------

function draw() {
  if (S.exporting) return;
  R.draw(S.project, scene(), S.t, {
    editor: !S.playing,
    sel: S.sel,
    useCamera: S.previewCam || !!S.playing,
    temp: S.temp,
    showCaptions: S.project.showCaptions,
  });
}

function refreshAll() {
  renderScenes();
  renderProps();
  updateTimeline();
  updateTools();
  draw();
}

// ---------- scenes panel ----------

function renderScenes() {
  const total = projectDuration(S.project);
  $('#sceneList').innerHTML = S.project.scenes
    .map((sc, i) => `<li class="${i === S.si ? 'active' : ''}" data-i="${i}">
      <span class="idx">${i + 1}</span><span class="nm">${esc(sc.name)}</span>
      <span class="kind">${sc.kind === 'card' ? 'CARD' : 'PITCH'}</span>
      <span class="dur">${sc.duration.toFixed(1)}s${sc.audio ? ' · 🎙 voice' : ''}${sc.narration && !sc.audio ? ' · script' : ''}</span></li>`)
    .join('');
  $('#totalTime').textContent = `${S.project.scenes.length} · ${fmtTime(total)}`;
}

function gotoScene(i) {
  stop();
  S.si = M.clamp(i, 0, S.project.scenes.length - 1);
  S.t = 0;
  S.sel = [];
  refreshAll();
}

$('#sceneList').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) gotoScene(+li.dataset.i);
});

function insertScene(sc) {
  pushUndo();
  S.project.scenes.splice(S.si + 1, 0, sc);
  gotoScene(S.si + 1);
  autosave();
}
$('#scAddPitch').onclick = () => insertScene(M.newPitchScene(`Scene ${S.project.scenes.length + 1}`));
$('#scAddCard').onclick = () => insertScene(M.newCardScene('Card'));
$('#scDup').onclick = () => {
  const c = structuredClone(scene());
  c.id = M.uid();
  c.name += ' copy';
  insertScene(c);
};
$('#scCont').onclick = () => {
  if (scene().kind !== 'pitch') return alert('“Continue” works on pitch scenes.');
  insertScene(M.continueScene(scene()));
};
function moveScene(d) {
  const j = S.si + d;
  const arr = S.project.scenes;
  if (j < 0 || j >= arr.length) return;
  pushUndo();
  [arr[S.si], arr[j]] = [arr[j], arr[S.si]];
  S.si = j;
  changedAll();
}
$('#scUp').onclick = () => moveScene(-1);
$('#scDown').onclick = () => moveScene(1);
$('#scDel').onclick = () => {
  if (S.project.scenes.length < 2) return;
  if (!confirm(`Delete scene “${scene().name}”?`)) return;
  pushUndo();
  S.project.scenes.splice(S.si, 1);
  gotoScene(Math.min(S.si, S.project.scenes.length - 1));
  autosave();
};

// ---------- toolbar ----------

$('#formSel').innerHTML = Object.keys(M.FORMATIONS).map((f) => `<option>${f}</option>`).join('');

function setTool(t) {
  S.tool = t;
  updateTools();
}
function updateTools() {
  $$('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === S.tool));
  canvas.classList.toggle('select', S.tool === 'select');
  $('.dot.home').style.background = S.project.teams.home.color;
  $('.dot.away').style.background = S.project.teams.away.color;
  $('#formTeam').options[0].text = S.project.teams.home.name;
  $('#formTeam').options[1].text = S.project.teams.away.name;
}
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setTool(b.dataset.tool);
});

$('#formInsert').onclick = () => {
  const sc = scene();
  if (sc.kind !== 'pitch') return alert('Select a pitch scene first.');
  const team = $('#formTeam').value;
  const f = M.FORMATIONS[$('#formSel').value];
  const removed = new Set(sc.objects.filter((o) => o.type === 'player' && o.team === team).map((o) => o.id));
  if (removed.size && !confirm(`Replace the ${removed.size} existing ${S.project.teams[team].name} players?`)) return;
  pushUndo();
  sc.objects = sc.objects.filter((o) => !removed.has(o.id) && !(o.type === 'chain' && o.ids.some((i) => removed.has(i))));
  for (const [x, y, n] of f) {
    sc.objects.push(M.makePlayer(team, n, team === 'home' ? x : M.PITCH.w - x, team === 'home' ? y : M.PITCH.h - y));
  }
  S.sel = [];
  changedAll();
};

$('#previewCam').onchange = (e) => {
  S.previewCam = e.target.checked;
  draw();
};
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;

// ---------- timeline ----------

function updateTimeline() {
  const sc = scene();
  const scrub = $('#scrub');
  scrub.max = sc.duration;
  scrub.value = S.t;
  $('#timeLabel').textContent = `${S.t.toFixed(2)} / ${sc.duration.toFixed(2)}s`;
  $('#btnPlay').textContent = S.playing && !S.playing.all ? '❚❚' : '▶';
  $('#btnPlayAll').textContent = S.playing?.all ? '❚❚ All' : '▶▶ All';
  if (S.playing) return;
  const o = S.sel.length === 1 && findObj(S.sel[0]);
  let marks = [];
  if (o) {
    if (o.kf) marks = o.kf.map((k) => ({ t: k.t, cls: 'kf', title: 'keyframe' }));
    marks.push({ t: o.in || 0, cls: 'in', title: 'appears' });
    if (o.out != null) marks.push({ t: o.out, cls: 'out', title: 'disappears' });
  } else if (sc.kind === 'pitch') {
    marks = sc.camera.map((k) => ({ t: k.t, cls: 'cam', title: 'camera keyframe' }));
  }
  $('#kfTrack').innerHTML = marks
    .map((m) => `<i class="${m.cls}" title="${m.title} @ ${m.t.toFixed(2)}s" style="left:${(m.t / sc.duration) * 100}%" data-t="${m.t}"></i>`)
    .join('');
}

$('#kfTrack').addEventListener('click', (e) => {
  const t = e.target.dataset?.t;
  if (t == null) return;
  stop();
  S.t = +t;
  updateTimeline();
  draw();
});
$('#scrub').addEventListener('input', (e) => {
  stop();
  S.t = parseFloat(e.target.value);
  updateTimeline();
  draw();
});

function play(all = false, { mute = false } = {}) {
  if (S.playing) return stop();
  if (S.t >= scene().duration - 0.02) S.t = 0;
  const startScene = S.si;
  const startT = S.t;
  if (!mute) A.play(S.project, startScene, startT, all);
  const t0 = performance.now();
  S.playing = { all, raf: 0 };
  S.temp = null;
  const tick = () => {
    if (!S.playing) return;
    let el = (performance.now() - t0) / 1000 + startT;
    let si = startScene;
    const scenes = S.project.scenes;
    if (all) {
      while (si < scenes.length && el >= scenes[si].duration) {
        el -= scenes[si].duration;
        si++;
      }
      if (si >= scenes.length) {
        S.si = scenes.length - 1;
        S.t = scene().duration;
        return stop();
      }
    } else if (el >= scenes[si].duration) {
      S.t = scenes[si].duration;
      return stop();
    }
    if (si !== S.si) {
      S.si = si;
      S.sel = [];
      renderScenes();
      renderProps();
    }
    S.t = el;
    updateTimeline();
    draw();
    S.playing.raf = requestAnimationFrame(tick);
  };
  updateTimeline();
  tick();
}

function stop() {
  if (!S.playing) return;
  cancelAnimationFrame(S.playing.raf);
  S.playing = null;
  A.stop();
  window.speechSynthesis?.cancel();
  updateTimeline();
  draw();
}

$('#btnPlay').onclick = () => play(false);
$('#btnPlayAll').onclick = () => play(true);

function keyAtPlayhead() {
  const t = M.snapT(S.t);
  const objs = S.sel.map(findObj).filter((o) => o?.kf);
  if (!objs.length) return alert('Select a player or ball first.');
  pushUndo();
  for (const o of objs) M.setKF(o.kf, t, M.sampleKF(o.kf, t));
  updateTimeline();
  changed();
}
$('#btnKey').onclick = keyAtPlayhead;
$('#btnDelKey').onclick = () => {
  const snap = snapshot();
  let did = false;
  const objs = S.sel.map(findObj).filter((o) => o?.kf);
  if (objs.length) for (const o of objs) did = M.removeKF(o.kf, S.t) || did;
  else if (scene().kind === 'pitch') did = M.removeKF(scene().camera, S.t);
  if (did) {
    pushUndo(snap);
    updateTimeline();
    changed();
  }
};
$('#btnCamReset').onclick = () => {
  if (scene().kind !== 'pitch') return;
  pushUndo();
  M.setKF(scene().camera, S.t, { cx: M.PITCH.w / 2, cy: M.PITCH.h / 2, zoom: 1 });
  updateTimeline();
  renderProps();
  changed();
};

// ---------- canvas interaction ----------

function evWorld(e) {
  const r = canvas.getBoundingClientRect();
  const px = ((e.clientX - r.left) * canvas.width) / r.width;
  const py = ((e.clientY - r.top) * canvas.height) / r.height;
  const cam = R.camAt(scene(), S.t, S.previewCam);
  return { ...R.toWorld(px, py, cam), zoom: cam.zoom };
}

function distToPoly(pts, w) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    const u = M.clamp(((w.x - ax) * dx + (w.y - ay) * dy) / L, 0, 1);
    best = Math.min(best, Math.hypot(ax + u * dx - w.x, ay + u * dy - w.y));
  }
  return best;
}

function hitObj(sc, o, w, t) {
  switch (o.type) {
    case 'player':
    case 'ball': {
      const p = M.sampleKF(o.kf, t);
      return Math.hypot(p.x - w.x, p.y - w.y) < (o.type === 'ball' ? 1.2 : 1.8);
    }
    case 'text': {
      const tw = R.measure(String(o.text).toUpperCase(), o.size);
      return Math.abs(w.x - o.x) < tw / 2 + 0.5 && Math.abs(w.y - o.y) < o.size / 2 + 0.5;
    }
    case 'arrow':
      return distToPoly(M.arrowPath(o, 1), w) < 1;
    case 'chain': {
      const pts = M.chainPts(sc, o, t);
      return pts.length > 1 && distToPoly(pts, w) < 0.8;
    }
    case 'zone':
      if (o.shape === 'ellipse') {
        const dx = (w.x - (o.x + o.w / 2)) / (o.w / 2);
        const dy = (w.y - (o.y + o.h / 2)) / (o.h / 2);
        return dx * dx + dy * dy <= 1;
      }
      return w.x >= o.x && w.x <= o.x + o.w && w.y >= o.y && w.y <= o.y + o.h;
  }
  return false;
}
const HIT_ORDER = { text: 0, ball: 1, player: 2, arrow: 3, chain: 4, zone: 5 };
function hitTest(sc, w, t) {
  const list = [...sc.objects].sort((a, b) => HIT_ORDER[a.type] - HIT_ORDER[b.type]);
  for (const visible of [true, false]) {
    for (const o of list) if (M.inWindow(o, t) === visible && hitObj(sc, o, w, t)) return o;
  }
  return null;
}

function handleHit(w) {
  if (S.sel.length !== 1) return null;
  const o = findObj(S.sel[0]);
  if (!o) return null;
  const r = 1.2 / w.zoom;
  for (const h of M.handlesFor(o)) if (Math.hypot(h.x - w.x, h.y - w.y) < r) return { ...h, id: o.id };
  return null;
}

function nextNum(team) {
  const used = new Set(scene().objects.filter((o) => o.team === team).map((o) => +o.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function selectOnly(ids) {
  S.sel = ids;
  renderProps();
  updateTimeline();
  draw();
}

canvas.addEventListener('pointerdown', (e) => {
  const sc = scene();
  if (sc.kind !== 'pitch' || S.exporting) return;
  stop();
  const w = evWorld(e);
  canvas.setPointerCapture(e.pointerId);
  const t = M.snapT(S.t);
  const tin = t > 0.01 ? t : 0;
  const tool = S.tool;

  if (tool === 'select') {
    const h = handleHit(w);
    if (h) {
      S.drag = { kind: 'handle', h, snap: snapshot(), moved: false };
      return;
    }
    const o = hitTest(sc, w, t);
    if (!o) return selectOnly([]);
    if (e.shiftKey) S.sel = S.sel.includes(o.id) ? S.sel.filter((i) => i !== o.id) : [...S.sel, o.id];
    else if (!S.sel.includes(o.id)) S.sel = [o.id];
    S.drag = {
      kind: 'move', start: w, snap: snapshot(), moved: false,
      orig: S.sel.map((id) => {
        const x = findObj(id);
        return { id, pos: x.kf ? M.sampleKF(x.kf, t) : null, o: structuredClone(x) };
      }),
    };
    return selectOnly(S.sel);
  }
  if (tool === 'home' || tool === 'away') {
    pushUndo();
    const o = M.makePlayer(tool, nextNum(tool), w.x, w.y);
    o.in = tin;
    sc.objects.push(o);
    S.sel = [o.id];
    return changedAll();
  }
  if (tool === 'ball') {
    pushUndo();
    const o = M.makeBall(w.x, w.y);
    o.in = tin;
    sc.objects.push(o);
    S.sel = [o.id];
    return changedAll();
  }
  if (tool === 'text') {
    const txt = prompt('Label text:', 'Half-space');
    if (!txt) return;
    pushUndo();
    const o = M.makeText(txt, w.x, w.y, tin, 2.6);
    sc.objects.push(o);
    S.sel = [o.id];
    return changedAll();
  }
  if (['pass', 'run', 'dribble', 'line'].includes(tool)) {
    S.temp = M.makeArrow(tool, w.x, w.y, w.x, w.y, tin);
    S.drag = { kind: 'create' };
    return draw();
  }
  if (tool === 'zone' || tool === 'ellipse') {
    S.temp = M.makeZone(tool === 'zone' ? 'rect' : 'ellipse', w.x, w.y, 0, 0, tin);
    S.drag = { kind: 'create', ox: w.x, oy: w.y };
    return draw();
  }
  if (tool === 'camera') {
    S.temp = { type: 'camrect', x: w.x, y: w.y, w: 0, h: 0 };
    S.drag = { kind: 'create', ox: w.x, oy: w.y };
    return draw();
  }
});

canvas.addEventListener('pointermove', (e) => {
  const d = S.drag;
  if (!d) return;
  const w = evWorld(e);
  const t = M.snapT(S.t);
  if (d.kind === 'move') {
    const dx = w.x - d.start.x;
    const dy = w.y - d.start.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 0.2) return;
      pushUndo(d.snap);
      d.moved = true;
    }
    for (const it of d.orig) {
      const o = findObj(it.id);
      if (!o) continue;
      if (o.kf) M.setKF(o.kf, t, { x: it.pos.x + dx, y: it.pos.y + dy });
      else if (o.type === 'arrow') Object.assign(o, { x1: it.o.x1 + dx, y1: it.o.y1 + dy, x2: it.o.x2 + dx, y2: it.o.y2 + dy });
      else if (o.type === 'zone' || o.type === 'text') Object.assign(o, { x: it.o.x + dx, y: it.o.y + dy });
    }
    draw();
  } else if (d.kind === 'handle') {
    const o = findObj(d.h.id);
    if (!d.moved) {
      pushUndo(d.snap);
      d.moved = true;
    }
    if (d.h.k === 'p1') Object.assign(o, { x1: w.x, y1: w.y });
    else if (d.h.k === 'p2') Object.assign(o, { x2: w.x, y2: w.y });
    else if (d.h.k === 'bend') {
      const { nx, ny } = M.arrowCtrl(o);
      o.bend = r2(((w.x - (o.x1 + o.x2) / 2) * nx + (w.y - (o.y1 + o.y2) / 2) * ny) * 2);
    } else if (d.h.k === 'size') Object.assign(o, { w: Math.max(1, w.x - o.x), h: Math.max(1, w.y - o.y) });
    draw();
  } else if (d.kind === 'create') {
    const o = S.temp;
    if (o.type === 'arrow') Object.assign(o, { x2: w.x, y2: w.y });
    else Object.assign(o, { x: Math.min(d.ox, w.x), y: Math.min(d.oy, w.y), w: Math.abs(w.x - d.ox), h: Math.abs(w.y - d.oy) });
    draw();
  }
});

canvas.addEventListener('pointerup', () => {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  const sc = scene();
  if (d.kind === 'create') {
    const o = S.temp;
    S.temp = null;
    if (o.type === 'camrect') {
      if (o.w > 2 && o.h > 2) {
        const v = R.viewSize(1);
        const zoom = r2(M.clamp(Math.min(v.w / o.w, v.h / o.h), 1, 5));
        pushUndo();
        M.setKF(sc.camera, S.t, { cx: r2(o.x + o.w / 2), cy: r2(o.y + o.h / 2), zoom });
      }
    } else {
      const ok = o.type === 'arrow' ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) > 1 : o.w > 1 && o.h > 1;
      if (ok) {
        pushUndo();
        sc.objects.push(o);
        S.sel = [o.id];
      }
    }
    return changedAll();
  }
  if (d.moved) {
    autosave();
    renderProps();
    updateTimeline();
  }
});

// ---------- keyboard ----------

const TOOL_KEYS = { v: 'select', h: 'home', a: 'away', b: 'ball', p: 'pass', r: 'run', d: 'dribble', l: 'line', z: 'zone', e: 'ellipse', t: 'text', c: 'camera' };
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if ((e.ctrlKey || e.metaKey) && k === 'y') return redo();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === ' ') {
    e.preventDefault();
    return play(e.shiftKey);
  }
  if (k === 'delete' || k === 'backspace') return deleteSelected();
  if (k === 'escape') return selectOnly([]);
  if (k === 'k') return keyAtPlayhead();
  if (k === 'arrowleft' || k === 'arrowright') {
    e.preventDefault();
    stop();
    const step = e.shiftKey ? 1 : 1 / M.FPS;
    S.t = M.clamp(M.snapT(S.t + (k === 'arrowleft' ? -step : step)), 0, scene().duration);
    updateTimeline();
    return draw();
  }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

function deleteSelected() {
  if (!S.sel.length) return;
  pushUndo();
  const sc = scene();
  const gone = new Set(S.sel);
  sc.objects = sc.objects.filter((o) => !gone.has(o.id));
  for (const o of sc.objects) if (o.type === 'chain') o.ids = o.ids.filter((i) => !gone.has(i));
  sc.objects = sc.objects.filter((o) => o.type !== 'chain' || o.ids.length > 1);
  S.sel = [];
  changedAll();
}

// ---------- properties panel ----------

const field = (label, k, v, type = 'text', extra = '') =>
  `<label class="f"><span>${label}</span><input data-k="${k}" type="${type}" ${type === 'number' ? 'data-t="num" step="0.1"' : ''} value="${esc(v ?? '')}" ${extra}></label>`;
const area = (label, k, v, rows = 4) =>
  `<label class="f stack"><span>${label}</span><textarea data-k="${k}" rows="${rows}">${esc(v ?? '')}</textarea></label>`;
const select = (label, k, v, opts) =>
  `<label class="f"><span>${label}</span><select data-k="${k}">${opts.map(([val, txt]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${txt}</option>`).join('')}</select></label>`;
const check = (label, k, v) => `<label class="chk"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}> ${label}</label>`;
const timing = (o) => `<div class="section"><h3>Timing</h3>
  ${field('Appears (s)', 'in', o.in ?? 0, 'number', 'min="0"')}
  ${field('Disappears', 'out', o.out ?? '', 'number', 'min="0" placeholder="end of scene"')}
  <div class="btnrow"><button data-act="inHere">In = playhead</button><button data-act="outHere">Out = playhead</button><button data-act="clearOut">Stay to end</button></div></div>`;

function renderProps() {
  const el = $('#props');
  el.className = 'right panel props';
  const sc = scene();
  const objs = S.sel.map(findObj).filter(Boolean);
  if (objs.length > 1) {
    const players = objs.filter((o) => o.type === 'player');
    el.innerHTML = `<h3>${objs.length} selected</h3>
      <p class="hint">Drag to move them together (creates keyframes for players at the playhead).</p>
      <div class="btnrow">
        ${players.length > 1 ? '<button data-act="chain">Connect with line</button>' : ''}
        <button data-act="keyAll">◆ Key all</button>
        <button data-act="deleteObj" class="danger">Delete</button></div>
      <p class="hint">“Connect with line” draws a line that follows the players (back four, pressing line…). Shift-click players in the order the line should run.</p>`;
    return;
  }
  if (objs.length === 1) return renderObjProps(el, objs[0]);

  const dur = sc.audio ? A.duration(sc.audio) : null;
  let html = `<h3>Scene ${S.si + 1}</h3>
    ${field('Name', 'name', sc.name)}
    ${select('Type', 'kind', sc.kind, [['pitch', 'Tactics pitch'], ['card', 'Title / illustration card']])}
    ${field('Duration (s)', 'duration', sc.duration, 'number', 'min="0.5"')}
    ${select('Transition', 'transition', sc.transition, [['cut', 'Cut'], ['fade', 'Fade from black']])}`;
  if (sc.kind === 'card') {
    html += `<div class="section"><h3>Card</h3>
      ${field('Title', 'title', sc.title)}
      ${field('Subtitle', 'subtitle', sc.subtitle)}
      ${field('Background', 'bg', sc.bg, 'color')}
      <label class="f"><span>Illustration</span><input type="file" accept="image/*" data-act="imageFile"></label>
      ${sc.image ? '<div class="btnrow"><button data-act="clearImage">Remove image</button></div>' : ''}
      <p class="hint">Drop in an illustration (drawn in Krita, Procreate, Illustrator…) and it gets a slow Ken Burns push-in.</p></div>`;
  }
  html += `<div class="section"><h3>Narration</h3>
    ${area('Script for this scene', 'narration', sc.narration, 5)}
    <div class="hint">${words(sc.narration)} words ≈ ${(words(sc.narration) / 2.6).toFixed(1)}s spoken</div>
    <div class="btnrow"><button data-act="speak">🔊 Preview with voice</button><button data-act="fitWords">Fit to script</button></div>
    ${area('On-screen caption', 'caption', sc.caption, 2)}
    <h3>Voiceover</h3>
    <div class="hint">${sc.audio ? `🎙 ${esc(sc.audioName || 'recording')} ${dur ? `(${dur.toFixed(1)}s)` : ''}` : 'No voiceover yet.'}</div>
    <div class="btnrow">
      <button data-act="rec" class="${S.recording ? 'rec' : ''}">${S.recording ? '■ Stop recording' : '● Record mic'}</button>
      <span><input type="file" accept="audio/*" data-act="audioFile" hidden><button type="button" data-act="pickAudio">Upload audio</button></span>
      ${sc.audio ? '<button data-act="fitAudio">Fit to audio</button><button data-act="clearAudio">Remove</button>' : ''}
    </div>
    <p class="hint">While recording, the scene animation plays so you can narrate in time with it.</p></div>`;
  if (sc.kind === 'pitch') {
    html += `<div class="section"><h3>Camera</h3>
      <p class="hint">Use the 🎥 Camera tool and drag a frame over the pitch to add a zoom keyframe at the playhead. Untick “Camera view” to edit on the full pitch.</p>
      <ul class="camlist">${sc.camera.map((k, i) => `<li><span>${k.t.toFixed(2)}s · zoom ${k.zoom.toFixed(2)}×</span><button data-act="delCam" data-i="${i}" ${sc.camera.length < 2 ? 'disabled' : ''}>✕</button></li>`).join('')}</ul></div>`;
  }
  el.innerHTML = html;
}

function renderObjProps(el, o) {
  const titles = { player: 'Player', ball: 'Ball', arrow: 'Arrow', zone: 'Zone', text: 'Label', chain: 'Connected line' };
  let html = `<h3>${titles[o.type]}</h3>`;
  if (o.type === 'player') {
    html += select('Team', 'team', o.team, [['home', esc(S.project.teams.home.name)], ['away', esc(S.project.teams.away.name)]]) +
      field('Number', 'num', o.num) + field('Name', 'name', o.name, 'text', 'placeholder="optional"') +
      field('Colour', 'color', o.color || S.project.teams[o.team].color, 'color') +
      `<div class="btnrow">${check('Highlight (pulse)', 'highlight', o.highlight)}<button data-act="resetColor">Team colour</button></div>`;
  }
  if (o.kf) {
    html += `<div class="section"><h3>Motion</h3>
      <p class="hint">${o.kf.length} keyframe${o.kf.length > 1 ? 's' : ''}. Move the playhead, then drag the ${o.type} — a keyframe is created there. Press ◆ Key (K) first to hold a position until that moment.</p>
      <div class="btnrow"><button data-act="keyAll">◆ Key here</button><button data-act="clearMotion">Clear motion</button></div></div>`;
  }
  if (o.type === 'arrow') {
    html += select('Style', 'style', o.style, [['pass', 'Pass (dashed)'], ['run', 'Run (solid)'], ['dribble', 'Dribble (wavy)'], ['line', 'Line (no head)']]) +
      field('Colour', 'color', o.color || { pass: '#f4f1e6', run: '#f2c14e', dribble: '#f4f1e6', line: '#ffffff' }[o.style], 'color') +
      field('Curve', 'bend', o.bend, 'number') +
      field('Draw time (s)', 'dur', o.dur, 'number', 'min="0.05"') +
      '<p class="hint">Drag the round handles to move the ends or bend the arrow.</p>';
  }
  if (o.type === 'zone') {
    html += select('Shape', 'shape', o.shape, [['rect', 'Rectangle'], ['ellipse', 'Ellipse']]) + field('Colour', 'color', o.color, 'color');
  }
  if (o.type === 'text') {
    html += field('Text', 'text', o.text) + field('Size (m)', 'size', o.size, 'number', 'min="0.5"') + field('Colour', 'color', o.color, 'color');
  }
  if (o.type === 'chain') html += field('Colour', 'color', o.color, 'color');
  html += timing(o);
  html += `<div class="btnrow"><button data-act="deleteObj" class="danger">Delete</button></div>`;
  el.innerHTML = html;
}

function propTarget() {
  if (S.sel.length === 1) return findObj(S.sel[0]);
  return S.sel.length ? null : scene();
}

const props = $('#props');
props.addEventListener('focusin', () => (S.pending = snapshot()));
props.addEventListener('input', (e) => {
  const inp = e.target;
  const k = inp.dataset.k;
  const tgt = propTarget();
  if (!k || !tgt) return;
  let v;
  if (inp.type === 'checkbox') v = inp.checked;
  else if (inp.dataset.t === 'num') {
    v = inp.value === '' ? null : parseFloat(inp.value);
    if (v !== null && Number.isNaN(v)) return;
  } else v = inp.value;
  if (k === 'duration') v = Math.max(0.5, v ?? 0.5);
  if (S.pending) {
    pushUndo(S.pending);
    S.pending = null;
  }
  tgt[k] = v;
  if (k === 'duration') S.t = Math.min(S.t, v);
  if (k === 'name' || k === 'duration' || k === 'narration') renderScenes();
  if (k === 'narration') {
    const hint = inp.closest('.f').nextElementSibling;
    if (hint) hint.textContent = `${words(v)} words ≈ ${(words(v) / 2.6).toFixed(1)}s spoken`;
  }
  updateTimeline();
  changed();
});
props.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') renderProps();
  if (e.target.type === 'file') onPropFile(e.target);
});

props.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const sc = scene();
  const o = S.sel.length === 1 ? findObj(S.sel[0]) : null;
  const t = M.snapT(S.t);
  const edit = (fn) => {
    pushUndo();
    fn();
    renderProps();
    updateTimeline();
    changed();
  };
  switch (act) {
    case 'inHere': return edit(() => (o.in = t));
    case 'outHere': return edit(() => (o.out = t));
    case 'clearOut': return edit(() => (o.out = null));
    case 'resetColor': return edit(() => (o.color = ''));
    case 'clearMotion': return edit(() => (o.kf = [{ t: 0, ...M.sampleKF(o.kf, t) }]));
    case 'keyAll': return keyAtPlayhead();
    case 'deleteObj': return deleteSelected();
    case 'chain': {
      pushUndo();
      const ids = S.sel.filter((id) => findObj(id)?.type === 'player');
      const c = M.makeChain(ids, S.t > 0.01 ? t : 0);
      sc.objects.push(c);
      S.sel = [c.id];
      return changedAll();
    }
    case 'delCam': return edit(() => sc.camera.splice(+b.dataset.i, 1));
    case 'fitWords': return edit(() => (sc.duration = Math.max(2, r2(words(sc.narration) / 2.6 + 0.6))));
    case 'fitAudio': {
      const d = A.duration(sc.audio);
      if (d) edit(() => (sc.duration = r2(d + 0.3)));
      return renderScenes();
    }
    case 'clearAudio': edit(() => { sc.audio = null; sc.audioName = ''; }); return renderScenes();
    case 'clearImage': return edit(() => (sc.image = null));
    case 'pickAudio': return b.previousElementSibling.click();
    case 'speak': {
      if (!sc.narration) return alert('Write some narration first.');
      stop();
      S.t = 0;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(sc.narration);
      u.rate = 1.02;
      speechSynthesis.speak(u);
      return play(false, { mute: true });
    }
    case 'rec': return toggleRecord();
  }
});

async function toggleRecord() {
  const sc = scene();
  if (!S.recording) {
    try {
      await A.recStart();
    } catch (err) {
      return alert('Microphone not available: ' + err.message);
    }
    S.recording = true;
    stop();
    S.t = 0;
    renderProps();
    play(false, { mute: true });
    return;
  }
  const blob = await A.recStop();
  S.recording = false;
  stop();
  if (blob?.size) {
    const id = M.uid();
    pushUndo();
    S.project.assets[id] = await blobToDataURL(blob);
    sc.audio = id;
    sc.audioName = `mic take ${new Date().toLocaleTimeString()}`;
    await A.preload(S.project);
    const d = A.duration(id);
    if (d && confirm(`Recorded ${d.toFixed(1)}s. Set the scene duration to match?`)) sc.duration = r2(d + 0.3);
  }
  changedAll();
}

async function onPropFile(input) {
  const f = input.files?.[0];
  if (!f) return;
  const sc = scene();
  const id = M.uid();
  pushUndo();
  S.project.assets[id] = await blobToDataURL(f);
  if (input.dataset.act === 'imageFile') sc.image = id;
  else {
    sc.audio = id;
    sc.audioName = f.name;
    await A.preload(S.project);
    const d = A.duration(id);
    if (d && confirm(`Audio is ${d.toFixed(1)}s. Set the scene duration to match?`)) sc.duration = r2(d + 0.3);
  }
  changedAll();
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const slug = (s) => String(s || 'project').replace(/[^a-z0-9_\- ]/gi, '').trim().replace(/\s+/g, '-') || 'project';

// ---------- top bar ----------

$('#btnNew').onclick = () => confirm('Start a new empty project? (Unsaved changes are lost.)') && setProject(M.newProject());
$('#btnSample').onclick = () => confirm('Load the sample “High Press” project? (Unsaved changes are lost.)') && setProject(M.sampleProject());
$('#btnExportJson').onclick = () =>
  download(new Blob([JSON.stringify(pruneAssets(S.project))], { type: 'application/json' }), `${slug(S.project.title)}.tifo.json`);
$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    setProject(JSON.parse(await f.text()));
  } catch (err) {
    alert('Could not read project: ' + err.message);
  }
  e.target.value = '';
};

$('#btnSave').onclick = async () => {
  const name = prompt('Save project as:', S.project.title);
  if (!name) return;
  S.project.title = name;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(slug(name))}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pruneAssets(S.project)),
    });
    if (!r.ok) throw new Error(await r.text());
    alert(`Saved to projects/${slug(name)}.json`);
  } catch (err) {
    alert('Save failed (is server.js running?): ' + err.message);
  }
};

$('#btnOpen').onclick = async () => {
  const list = $('#openList');
  try {
    const items = await (await fetch('/api/projects')).json();
    list.innerHTML = items.length
      ? items.map((p) => `<li><span><b>${esc(p.name)}</b><br><span class="muted">${new Date(p.mtime).toLocaleString()} · ${(p.size / 1e6).toFixed(1)} MB</span></span>
          <span><button type="button" data-open="${esc(p.name)}" class="primary">Open</button> <button type="button" data-del="${esc(p.name)}" class="danger">✕</button></span></li>`).join('')
      : '<li class="muted">No saved projects yet.</li>';
  } catch {
    list.innerHTML = '<li class="muted">Server not reachable. Start it with <code>npm start</code>.</li>';
  }
  $('#dlgOpen').showModal();
};
$('#openList').addEventListener('click', async (e) => {
  const open = e.target.dataset.open;
  const del = e.target.dataset.del;
  if (open) {
    const p = await (await fetch(`/api/projects/${encodeURIComponent(open)}`)).json();
    $('#dlgOpen').close();
    setProject(p);
  } else if (del && confirm(`Delete ${del}?`)) {
    await fetch(`/api/projects/${encodeURIComponent(del)}`, { method: 'DELETE' });
    e.target.closest('li').remove();
  }
});

// Project dialog
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const setPath = (obj, path, v) => {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = v;
};
function fillProjectDlg() {
  $$('#dlgProject [data-pk]').forEach((inp) => {
    const v = getPath(S.project, inp.dataset.pk);
    if (inp.type === 'checkbox') inp.checked = !!v;
    else inp.value = v ?? '';
  });
  $('#musicInfo').textContent = S.project.music ? `♪ ${S.project.musicName || 'music'}` : 'No music. Tip: YouTube Audio Library has free tracks.';
}
$('#btnProject').onclick = () => {
  S.pending = snapshot();
  fillProjectDlg();
  $('#dlgProject').showModal();
};
$('#dlgProject').addEventListener('input', (e) => {
  const pk = e.target.dataset.pk;
  if (!pk) return;
  if (S.pending) {
    pushUndo(S.pending);
    S.pending = null;
  }
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? +e.target.value : e.target.value;
  setPath(S.project, pk, v);
  updateTools();
  changed();
});
$('#musicFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const id = M.uid();
  S.project.assets[id] = await blobToDataURL(f);
  S.project.music = id;
  S.project.musicName = f.name;
  await A.preload(S.project);
  fillProjectDlg();
  autosave();
  e.target.value = '';
};
$('#musicClear').onclick = () => {
  S.project.music = null;
  fillProjectDlg();
  autosave();
};
$('#dlgProject').addEventListener('close', () => refreshAll());

// Script → scenes
$('#btnScript').onclick = () => $('#dlgScript').showModal();
$('#scriptGo').onclick = (e) => {
  const text = $('#scriptText').value;
  const paras = text.split(/\n\s*\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!paras.length) {
    e.preventDefault();
    return alert('Paste a script with paragraphs separated by blank lines.');
  }
  const wps = +$('#scriptWps').value || 2.6;
  const carry = $('#scriptCarry').checked;
  const caps = $('#scriptCaptions').checked;
  pushUndo();
  let base = scene();
  let at = S.si + 1;
  for (const p of paras) {
    const sc = carry && base.kind === 'pitch' ? M.continueScene(base) : M.newPitchScene();
    sc.name = p.split(' ').slice(0, 4).join(' ') + (words(p) > 4 ? '…' : '');
    sc.narration = p;
    if (caps) sc.caption = p;
    sc.duration = Math.max(3, r2(words(p) / wps + 0.6));
    S.project.scenes.splice(at++, 0, sc);
    base = sc;
  }
  gotoScene(S.si + 1);
  autosave();
};

$('#btnSrt').onclick = () => {
  const srt = buildSRT(S.project);
  if (!srt) return alert('No narration text in any scene yet.');
  download(new Blob([srt], { type: 'text/plain' }), `${slug(S.project.title)}.srt`);
};

// Export
let exportAbort = null;
$('#btnVideo').onclick = () => {
  stop();
  $('#expProgress').value = 0;
  $('#expStatus').textContent = `Length: ${fmtTime(projectDuration(S.project))} — export takes the same time.`;
  $('#expStart').disabled = false;
  $('#dlgExport').showModal();
};
$('#expCancel').onclick = () => {
  if (exportAbort) exportAbort.abort();
  else $('#dlgExport').close();
};
$('#dlgExport').addEventListener('cancel', (e) => exportAbort && e.preventDefault());
$('#expStart').onclick = async () => {
  $('#expStart').disabled = true;
  exportAbort = new AbortController();
  S.exporting = true;
  S.sel = [];
  const total = projectDuration(S.project);
  try {
    const res = await exportVideo({
      project: S.project, renderer: R, audio: A, bitrate: +$('#expBitrate').value, signal: exportAbort.signal,
      onProgress: (p) => {
        $('#expProgress').value = p;
        $('#expStatus').textContent = `Recording… ${fmtTime(p * total)} / ${fmtTime(total)}`;
      },
    });
    if (res) {
      download(res.blob, `${slug(S.project.title)}.${res.ext}`);
      $('#expStatus').textContent = `Done — ${(res.blob.size / 1e6).toFixed(1)} MB ${res.ext.toUpperCase()} downloaded.` +
        (res.ext === 'webm' ? ' Convert to MP4 with: ffmpeg -i in.webm -c:v libx264 -crf 18 -c:a aac out.mp4' : '');
    } else $('#expStatus').textContent = 'Export cancelled.';
  } catch (err) {
    $('#expStatus').textContent = 'Export failed: ' + err.message;
  }
  S.exporting = null;
  exportAbort = null;
  $('#expStart').disabled = false;
  $('#expProgress').value = 1;
  refreshAll();
};

// ---------- boot ----------

function boot() {
  let p = null;
  try {
    const saved = localStorage.getItem('tifo-autosave');
    if (saved) p = JSON.parse(saved);
  } catch { /* ignore */ }
  setProject(p?.scenes?.length ? p : M.sampleProject());
  document.fonts?.load(`700 40px ${FONT}`).then(draw).catch(() => {});
  document.fonts?.ready.then(draw);
}
boot();

// Handy for debugging from the console.
window.tifo = { S, R, A, M };
