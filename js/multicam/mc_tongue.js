// Tongue-out tracking (experimental) for the face mapping.
//
// MediaPipe's face model has no tongue value, so this watches camera 1's mouth
// area itself (mc_tongue_worker.js) and learns, from a 6 second calibration, what
// "tongue in" and "tongue out" look like for this person, face and lighting.
// The result is written into MC_face's ARKit values as tongueOut (0..1).

(function () {

'use strict';

const STORE_KEY = 'XRA_multicam_tongue_v1';
const FPS = 15;
const PHASE_SECONDS = 3;

const settings = Object.assign({ enabled: false, model: null }, load());
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); }
  catch (e) {}
}

let worker = null, ready = false, busy = false, timer = 0, frame_id = 0;
let value = 0, last_found = 0, last_error = '';
let preview = null, want_preview = false, last_mouth = null;
let source_override = null;   // test hook: read frames from this canvas instead of camera 1
let calib = null;        // { phase: 'wait_in'|'in'|'wait_out'|'out', until, in: [], out: [], log }
const listeners = new Set();

function camera() { return window.System?._browser?.camera; }

function start() {
  if (worker) return;
  worker = new Worker('js/multicam/mc_tongue_worker.js');
  worker.onmessage = (e) => on_message(e.data);
  worker.postMessage({ type: 'init' });
  timer = setInterval(pump, 1000 / FPS);
}

function stop() {
  clearInterval(timer);
  worker?.terminate();
  worker = null; ready = false; busy = false;
  set_value(0);
}

// The face model needs a close-up: crop around the head using the body tracker's
// head points (same picture as camera 1, so same pixel positions).
const CROP = 256;
let crop = null;
function head_crop(cv) {
  const kp = window.MC_multicam?.live?.cam0_kp;
  if (!kp) return null;
  const pts = [0, 2, 5, 7, 8, 9, 10].map(i => kp[i]).filter(p => p && p.score > 0.3);
  if (pts.length < 4) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const size = Math.max(96, 2.6 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2 + 0.1 * size;
  const sx = Math.round(Math.max(0, Math.min(cv.width - size, cx - size / 2))), sy = Math.round(Math.max(0, Math.min(cv.height - size, cy - size / 2)));
  return { sx, sy, size: Math.round(Math.min(size, cv.width, cv.height)) };
}

async function pump() {
  const cv = source_override || camera()?.video_canvas;
  if (!ready || busy || !cv || !cv.width) return;
  busy = true;
  try {
    const c = head_crop(cv);
    const bitmap = c
      ? await createImageBitmap(cv, c.sx, c.sy, c.size, c.size, { resizeWidth: CROP, resizeHeight: CROP, resizeQuality: 'high' })
      : await createImageBitmap(cv);
    crop = c;
    worker.postMessage({ type: 'frame', bitmap, ts: performance.now(), id: ++frame_id, want_preview }, [bitmap]);
  }
  catch (e) { busy = false; }
}

// mouth info from the worker (crop pixels) -> camera 1 picture pixels
function to_source(m, c) {
  if (!m || !c) return m;
  const k = c.size / CROP;
  return Object.assign({}, m, { M: [c.sx + m.M[0] * k, c.sy + m.M[1] * k], W: m.W * k, y_up: m.y_up * k, y_low: m.y_low * k, y_chin: m.y_chin * k });
}

function set_value(v) {
  value = v;
  const face = window.MC_face;
  if (face) face.arkit.tongueOut = v;
}

function project(f) {
  const m = settings.model;
  let s = 0;
  for (let i = 0; i < f.length; i++) s += m.w[i] * f[i];
  return s;
}

function on_message(d) {
  if (d.type == 'ready') { ready = true; notify(); return; }
  if (d.type == 'error') { last_error = d.message; notify(); return; }
  if (d.type != 'result') return;
  busy = false;
  if (d.preview) { preview?.close?.(); preview = d.preview; }
  if (d.error) last_error = d.error;
  if (!d.found) {
    if (performance.now() - last_found > 500) set_value(value * 0.8);
    return;
  }
  last_found = performance.now();
  last_mouth = to_source(d.mouth, crop);

  if (calib) step_calibration(d.f);

  if (settings.model && settings.model.w.length == d.f.length) {
    const m = settings.model;
    const raw = (project(d.f) - m.b_in) / (m.b_out - m.b_in);
    const v = Math.min(1, Math.max(0, raw));
    set_value(value + (v - value) * 0.5);
  }
  else set_value(0);
}

// ---------- calibration ----------

function start_calibration(log) {
  if (!settings.enabled) { settings.enabled = true; save(); start(); }
  calib = { phase: 'wait_in', until: performance.now() + 2500, in: [], out: [], log: log || (() => {}) };
  calib.log('Tongue IN: relax your face. Open and close your mouth a little, talk if you like... (starts in 2 s)');
  notify();
}

function step_calibration(f) {
  const now = performance.now();
  const c = calib;
  if (c.phase == 'wait_in' && now > c.until) { c.phase = 'in'; c.until = now + PHASE_SECONDS * 1000; c.log('Recording tongue IN...'); }
  else if (c.phase == 'in') {
    c.in.push(f);
    if (now > c.until) { c.phase = 'wait_out'; c.until = now + 2500; c.log('Now stick your tongue OUT and keep it there... (starts in 2 s)'); }
  }
  else if (c.phase == 'wait_out' && now > c.until) { c.phase = 'out'; c.until = now + PHASE_SECONDS * 1000; c.log('Recording tongue OUT...'); }
  else if (c.phase == 'out') {
    c.out.push(f);
    if (now > c.until) finish_calibration();
  }
  notify();
}

function finish_calibration() {
  const c = calib;
  calib = null;
  if (c.in.length < 10 || c.out.length < 10) {
    c.log('Calibration failed: your face was not found often enough. Face camera 1 with good light and try again.');
    notify();
    return;
  }
  const n = c.in[0].length;
  const mean = (arr) => { const m = new Array(n).fill(0); arr.forEach(f => f.forEach((x, i) => { m[i] += x / arr.length; })); return m; };
  const vari = (arr, m) => { const v = new Array(n).fill(0); arr.forEach(f => f.forEach((x, i) => { v[i] += (x - m[i]) ** 2 / arr.length; })); return v; };
  const mi = mean(c.in), mo = mean(c.out), vi = vari(c.in, mi), vo = vari(c.out, mo);
  // diagonal linear discriminant: weight each colour by how well it separates the two states
  const w = mi.map((_, i) => (mo[i] - mi[i]) / (vi[i] + vo[i] + 1e-5));
  const model = { w, b_in: 0, b_out: 1, created: new Date().toISOString() };
  settings.model = model;
  const pin = c.in.map(project).sort((a, b) => a - b), pout = c.out.map(project).sort((a, b) => a - b);
  const med = (a) => a[a.length >> 1];
  model.b_in = med(pin);
  model.b_out = med(pout);
  const spread = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  const d = (model.b_out - model.b_in) / (0.5 * (spread(pin, model.b_in) + spread(pout, model.b_out)) + 1e-9);
  model.quality = d;
  if (!(model.b_out > model.b_in)) {
    settings.model = null;
    c.log('Calibration failed: tongue in and out looked the same. Try again, with your tongue clearly out.');
  }
  else {
    save();
    c.log(`Tongue calibrated. Separation ${d.toFixed(1)} (${d > 4 ? 'great' : d > 2 ? 'good' : 'weak: try better light or a clearer tongue-out'}).`);
  }
  notify();
}

function notify() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }

function set_enabled(on) {
  settings.enabled = !!on;
  save();
  if (on) start(); else stop();
  notify();
}

if (settings.enabled) {
  if (document.readyState == 'complete') start();
  else window.addEventListener('load', start);
}

window.MC_tongue = {
  settings, set_enabled, start_calibration,
  get value() { return value; },
  get ready() { return ready; },
  get calibrating() { return calib ? calib.phase : null; },
  get calibrated() { return !!settings.model; },
  get active() { return settings.enabled && !!settings.model && performance.now() - last_found < 1000; },
  get face_found() { return performance.now() - last_found < 1000; },
  get preview() { return preview; },
  set want_preview(v) { want_preview = !!v; },
  get last_error() { return last_error; },
  get last_mouth() { return last_mouth; },
  set _source(cv) { source_override = cv || null; },
  on_change(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  clear() { settings.model = null; save(); set_value(0); notify(); },
};

})();
