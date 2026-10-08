// Multi-camera 3D tracking for XR Animator
//
// XR Animator's own camera stays "camera 1" and keeps doing face, hands and body.
// This adds extra cameras, each with its own pose tracker. After a one-time
// calibration (walk around for 30 s), body joints are triangulated in true 3D and
// handed to XR Animator's solver in place of the single-camera guess, so depth,
// turning around and self-occlusion are much more stable.
//
// Hooked in from SA_system_emulation.min.js: the pose result handler calls
// MC_multicam.process(result) before using it.
//
// Panel: Ctrl+Shift+M, or the small "3D" button in the bottom-left corner.

(function () {

'use strict';

const G = window.MC_geometry, FUSE = window.MC_fuse;
const STORE_KEY = 'XRA_multicam_v1';
const BLAZEPOSE = ['nose','left_eye_inner','left_eye','left_eye_outer','right_eye_inner','right_eye','right_eye_outer','left_ear','right_ear','mouth_left','mouth_right','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_pinky','right_pinky','left_index','right_index','left_thumb','right_thumb','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle','left_heel','right_heel','left_foot_index','right_foot_index'];
const PART_NAMES = BLAZEPOSE.map(n => n.replace(/\_(\w)/, (m, p1) => p1.toUpperCase()));
const CALIB_SECONDS = 30;

// ---------- settings ----------

const settings = Object.assign({
  enabled: true,
  level: true,
  extra_devices: [],      // deviceIds of the extra cameras
  calibration: null,
  user_height_cm: '',
  model_quality: '',
  width: 1280, height: 720,
  show_button: true,
}, load_settings());

function load_settings() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function save_settings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); }
  catch (e) {}
}

// ---------- state ----------

const extra = [];          // extra cameras
let fuser = null;
let recording = null;      // { samples, until, cams_info }
let calibrating = false;
const stats = { cam0_fps: 0, cam0_n: 0, cam0_t: 0, tri: 0, mono: 0, active: false, last_error: '' };

function camera() { return window.System?._browser?.camera; }

function cam0_device_id() {
  try { return camera()?.stream?.getVideoTracks()[0]?.getSettings().deviceId || null; }
  catch (e) { return null; }
}
function cam0_label() {
  try { return camera()?.stream?.getVideoTracks()[0]?.label || ''; }
  catch (e) { return ''; }
}

function set_calibration(cal) {
  settings.calibration = cal;
  fuser = cal ? FUSE.create(cal) : null;
  save_settings();
  ui_refresh();
}
if (settings.calibration) {
  try { fuser = FUSE.create(settings.calibration); }
  catch (e) { settings.calibration = null; }
}

// ---------- extra cameras ----------

async function open_extra(deviceId) {
  if (extra.some(c => c.deviceId == deviceId)) return;
  const cam = {
    deviceId, label: '', video: document.createElement('video'), stream: null,
    worker: null, ready: false, busy: false, history: [], frame_id: 0,
    fps: 0, n: 0, t: performance.now(), error: '', closed: false,
  };
  extra.push(cam);
  ui_refresh();

  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: {
      deviceId: { exact: deviceId },
      width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: 30 },
    } });
  }
  catch (err) {
    cam.error = 'could not open: ' + (err.message || err);
    ui_refresh();
    return;
  }
  cam.label = cam.stream.getVideoTracks()[0]?.label || deviceId.slice(0, 8);
  cam.video.muted = true;
  cam.video.playsInline = true;
  cam.video.srcObject = cam.stream;
  await cam.video.play().catch(() => {});

  cam.worker = new Worker('js/multicam/mc_pose_worker.js');
  cam.worker.onmessage = (e) => on_worker_message(cam, e.data);
  cam.worker.postMessage({ type: 'init', param: { model_quality: settings.model_quality } });

  const pump = () => {
    if (cam.closed) return;
    grab_frame(cam);
    if (cam.video.requestVideoFrameCallback) cam.video.requestVideoFrameCallback(pump);
    else setTimeout(pump, 15);
  };
  pump();
  ui_refresh();
}

async function grab_frame(cam) {
  if (!cam.ready || cam.busy || cam.video.readyState < 2) return;
  cam.busy = true;
  const ts = performance.now();
  try {
    const bitmap = await createImageBitmap(cam.video);
    cam.worker.postMessage({ type: 'frame', bitmap, ts, id: ++cam.frame_id }, [bitmap]);
  }
  catch (err) {
    cam.busy = false;
  }
}

function on_worker_message(cam, d) {
  if (d.type == 'ready') { cam.ready = true; ui_refresh(); return; }
  if (d.type == 'error') { cam.error = d.message; cam.busy = false; ui_refresh(); return; }
  if (d.type != 'result') return;
  cam.busy = false;
  cam.w = d.w; cam.h = d.h;
  cam.history.push({ ts: d.ts, landmarks: d.landmarks, worldLandmarks: d.worldLandmarks });
  if (cam.history.length > 12) cam.history.shift();
  cam.n++;
  const now = performance.now();
  if (now - cam.t > 1000) { cam.fps = cam.n * 1000 / (now - cam.t); cam.n = 0; cam.t = now; }
}

function close_extra(deviceId) {
  const i = extra.findIndex(c => c.deviceId == deviceId);
  if (i < 0) return;
  const cam = extra[i];
  cam.closed = true;
  cam.stream?.getTracks().forEach(t => t.stop());
  cam.worker?.terminate();
  extra.splice(i, 1);
  ui_refresh();
}

// landmarks of an extra camera at time t (interpolated between the two closest results)
function view_at(cam, t) {
  const h = cam.history;
  let a = null, b = null;
  for (const r of h) {
    if (!r.landmarks) continue;
    if (r.ts <= t && (!a || r.ts > a.ts)) a = r;
    if (r.ts >= t && (!b || r.ts < b.ts)) b = r;
  }
  const max_gap = 70;
  if (a && b && a !== b && b.ts - a.ts < 2 * max_gap) {
    const k = (t - a.ts) / (b.ts - a.ts);
    const lerp = (p, q) => p + (q - p) * k;
    return {
      landmarks: a.landmarks.map((l, i) => ({
        x: lerp(l.x, b.landmarks[i].x), y: lerp(l.y, b.landmarks[i].y),
        visibility: Math.min(l.visibility, b.landmarks[i].visibility),
      })),
      worldLandmarks: (a.worldLandmarks && b.worldLandmarks) ? a.worldLandmarks.map((l, i) => ({
        x: lerp(l.x, b.worldLandmarks[i].x), y: lerp(l.y, b.worldLandmarks[i].y), z: lerp(l.z, b.worldLandmarks[i].z),
      })) : null,
    };
  }
  const n = [a, b].filter(Boolean).sort((p, q) => Math.abs(p.ts - t) - Math.abs(q.ts - t))[0];
  if (n && Math.abs(n.ts - t) < max_gap) return { landmarks: n.landmarks, worldLandmarks: n.worldLandmarks };
  return null;
}

// ---------- the hook ----------

// XR Animator's camera 1 result -> normalized, un-mirrored landmarks
function cam0_view(posenet) {
  const kp = posenet?.keypoints;
  if (!kp || kp.length != 33) return null;
  const C = camera();
  const canvas = C?.video_canvas;
  if (!canvas || !canvas.width) return null;
  const W = canvas.width, H = canvas.height;
  const flip = !!C.video_flipped;
  const landmarks = kp.map(k => ({
    x: flip ? 1 - k.position.x / W : k.position.x / W,
    y: k.position.y / H,
    visibility: k.score ?? 0,
  }));
  const w3 = posenet.keypoints3D_raw || posenet.keypoints3D;
  const worldLandmarks = (w3 && w3.length == 33) ? w3.map(p => ({ x: flip ? -p.x : p.x, y: p.y, z: p.z })) : null;
  return { landmarks, worldLandmarks, W, H, flip };
}

function process(result) {
  if (!result || typeof result != 'object' || !('posenet' in result)) return result;
  try {
    return _process(result);
  }
  catch (err) {
    stats.last_error = String(err.message || err);
    return result;
  }
}

function _process(result) {
  const now = performance.now();
  stats.cam0_n++;
  if (now - stats.cam0_t > 1000) { stats.cam0_fps = stats.cam0_n * 1000 / (now - stats.cam0_t); stats.cam0_n = 0; stats.cam0_t = now; }

  if (!extra.length) { stats.active = false; return result; }

  const v0 = cam0_view(result.posenet);
  // capture time of camera 1's frame: now minus the time XR Animator's worker spent on it
  const t_cap = now - (result._t || 0);
  const views_norm = [v0 ? { landmarks: v0.landmarks, worldLandmarks: v0.worldLandmarks } : null]
    .concat(extra.map(c => (c.ready ? view_at(c, t_cap) : null)));

  if (recording) {
    if (!recording.cams_info) {
      const C = camera();
      recording.cams_info = [{ width: C.video_canvas.width, height: C.video_canvas.height, label: cam0_label() }]
        .concat(extra.map(c => ({ width: c.w || c.video.videoWidth, height: c.h || c.video.videoHeight, label: c.label, deviceId: c.deviceId })));
      recording.n_cams = recording.cams_info.length;
    }
    if (views_norm.length == recording.n_cams && views_norm.filter(Boolean).length >= 2) {
      recording.samples.push({ views: views_norm.map((v, i) => v && to_px(v, recording.cams_info[i])) });
    }
    if (now > recording.until) finish_recording();
  }

  if (!settings.enabled || !fuser || calibrating) { stats.active = false; return result; }
  const cal = settings.calibration;
  if (cal.cameras.length != views_norm.length) { stats.active = false; return result; }

  const fused = fuser.fuse(views_norm.map((v, i) => v && to_px(v, cal.cameras[i])));
  if (!fused) { stats.active = false; return result; }

  stats.tri = fused.source.filter(s => s == 'tri').length;
  stats.mono = fused.source.filter(s => s == 'mono').length;
  stats.active = true;

  result.posenet = build_posenet(fused, result.posenet, cal.cameras[0]);
  return result;
}

function to_px(v, cam) {
  return {
    lm: v.landmarks.map(l => ({ u: (l.x - 0.5) * cam.width, v: (l.y - 0.5) * cam.height, vis: l.visibility ?? 0 })),
    wl: v.worldLandmarks || null,
  };
}

// Express the fused world skeleton the way XR Animator expects a single camera's
// result: 2D keypoints in camera 1's (possibly mirrored) image, and hip-centred
// metric 3D keypoints in camera axes. With "level" on, the virtual camera keeps
// camera 1's position and heading but is levelled, so a tilted tablet doesn't tilt the avatar.
function build_posenet(fused, original, cal0) {
  const C = camera();
  const W = C.video_canvas.width, H = C.video_canvas.height;
  const flip = !!C.video_flipped;
  const sx = W / cal0.width;

  let R = cal0.R;
  const center = cal0.center || G.camera_center(cal0);
  if (settings.level) {
    let z = [R[6], 0, R[8]];
    z = G.v_norm((G.v_len(z) > 1e-6) ? z : [0, 0, -1]);
    const x = G.v_norm(G.v_cross(z, [0, 1, 0]));
    const y = G.v_cross(z, x);
    R = [...x, ...y, ...z];
  }
  const t = G.v_scale(G.m3_v(R, center), -1);
  const vcam = { R, t, f: cal0.f };

  const hip_c = G.cam_to_local(vcam, fused.hip);
  const orig_kp = original?.keypoints?.length == 33 ? original.keypoints : null;

  const keypoints = [], keypoints3D = [];
  for (let j = 0; j < 33; j++) {
    const X = fused.points[j];
    const part = orig_kp?.[j]?.part || PART_NAMES[j];
    if (!X) {
      // nobody sees it: keep camera 1's own estimate
      const o = orig_kp?.[j];
      keypoints.push(o || { position: { x: 0, y: 0, z: 0 }, score: 0, part });
      const o3 = original?.keypoints3D?.[j];
      keypoints3D.push(o3 || { x: 0, y: 0, z: 0, name: BLAZEPOSE[j], score: 0 });
      continue;
    }
    const src = fused.source[j];
    const score = (src == 'tri') ? 0.95 : (src == 'mono') ? 0.75 : 0.45;

    const pc = G.cam_to_local(vcam, X);
    let u = cal0.f * pc[0] / pc[2] + cal0.width / 2;
    const v = cal0.f * pc[1] / pc[2] + cal0.height / 2;
    let x_px = u * sx, y_px = v * sx;
    if (flip) x_px = W - x_px;
    const z_px = cal0.f * (pc[2] - hip_c[2]) / hip_c[2] * sx;
    keypoints.push({ position: { x: x_px, y: y_px, z: z_px }, score, part });

    const rel = G.m3_v(R, G.v_sub(X, fused.hip));
    keypoints3D.push({ x: flip ? -rel[0] : rel[0], y: rel[1], z: rel[2], name: BLAZEPOSE[j], score });
  }

  const out = { score: 1, keypoints, keypoints3D };
  if (original?.keypoints3D_raw) out.keypoints3D_raw = keypoints3D.map(p => Object.assign({}, p));
  return out;
}

// ---------- calibration ----------

function start_calibration() {
  if (!extra.some(c => c.ready)) { ui_log('Add at least one extra camera first.'); return; }
  if (recording || calibrating) return;
  let count = 5;
  ui_log(`Get ready: stand where all cameras can see your whole body. Recording starts in ${count}...`);
  const timer = setInterval(() => {
    count--;
    if (count > 0) { ui_log(`${count}...`); return; }
    clearInterval(timer);
    recording = { samples: [], until: performance.now() + CALIB_SECONDS * 1000, cams_info: null };
    ui_log(`Recording ${CALIB_SECONDS} s: walk around slowly, turn around, raise and swing your arms, step forward and back.`);
    ui_refresh();
  }, 1000);
}

function finish_recording() {
  const rec = recording;
  recording = null;
  // keep it quick: ~400 samples is plenty
  let samples = rec.samples;
  if (samples.length > 400) {
    const step = samples.length / 400;
    samples = Array.from({ length: 400 }, (_, i) => samples[Math.floor(i * step)]);
  }
  const both = samples.filter(s => s.views.filter(Boolean).length >= 2).length;
  ui_log(`Recorded ${rec.samples.length} frames (${both} used). Calculating, this can take up to a minute...`);
  if (both < 60) {
    ui_log('Not enough frames where 2+ cameras saw you. Check that every camera sees your whole body, then try again.');
    ui_refresh();
    return;
  }

  calibrating = true;
  ui_refresh();
  const worker = new Worker('js/multicam/mc_calib_worker.js');
  const h = parseFloat(settings.user_height_cm);
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type == 'log') { ui_log(d.message); return; }
    worker.terminate();
    calibrating = false;
    if (d.type == 'error') { ui_log('Calibration failed: ' + d.message); ui_refresh(); return; }
    const cal = d.result;
    cal.cameras.forEach((c, i) => { c.label = rec.cams_info[i].label; c.deviceId = rec.cams_info[i].deviceId; });
    const bad = cal.cameras.filter(c => !c.solved).length;
    ui_log(`Done. Average error ${cal.rms_px.toFixed(1)} px` + (bad ? `, ${bad} camera(s) could not be placed` : '') +
      ((cal.rms_px > 8) ? '. That is high: try again with more movement and good lighting.' : '.'));
    set_calibration(cal);
  };
  worker.postMessage({
    samples,
    cams_info: rec.cams_info.map(c => ({ width: c.width, height: c.height })),
    options: { user_height_m: (h > 100 && h < 250) ? h / 100 : undefined },
  });
}

function export_calibration() {
  if (!settings.calibration) return;
  const blob = new Blob([JSON.stringify(settings.calibration, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'xra_multicam_calibration.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function import_calibration(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const cal = JSON.parse(r.result);
      if (!cal.cameras?.length) throw new Error('not a calibration file');
      set_calibration(cal);
      ui_log('Calibration loaded.');
    }
    catch (e) { ui_log('Could not load: ' + e.message); }
  };
  r.readAsText(file);
}

// ---------- panel ----------

let panel = null, log_el = null, status_el = null, list_el = null, button = null;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k == 'style') e.style.cssText = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (k in e) e[k] = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of [].concat(children)) e.append(c);
  return e;
}

function build_ui() {
  const css = el('style', { textContent: `
#mc_panel{position:fixed;top:12px;right:12px;width:340px;max-height:calc(100vh - 24px);overflow:auto;z-index:2147483000;
 background:rgba(20,20,28,.94);color:#eee;font:13px/1.4 system-ui,sans-serif;border-radius:10px;padding:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);display:none}
#mc_panel h3{margin:0 0 8px;font-size:15px}
#mc_panel h4{margin:12px 0 4px;font-size:13px;color:#aab}
#mc_panel button{background:#3a3f5c;color:#fff;border:0;border-radius:6px;padding:5px 9px;margin:2px 4px 2px 0;cursor:pointer;font:inherit}
#mc_panel button:hover{background:#4c5378}
#mc_panel button:disabled{opacity:.45;cursor:default}
#mc_panel label{display:block;margin:3px 0}
#mc_panel input[type=text]{width:60px;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px}
#mc_panel .mc_cam{display:flex;align-items:center;gap:6px;margin:3px 0}
#mc_panel .mc_cam video{width:96px;height:54px;background:#000;border-radius:4px;object-fit:cover}
#mc_panel .mc_small{color:#99a;font-size:11px}
#mc_panel pre{white-space:pre-wrap;background:#111;border-radius:6px;padding:6px;max-height:160px;overflow:auto;font-size:11px;margin:4px 0 0}
#mc_btn{position:fixed;left:8px;bottom:8px;z-index:2147483000;background:rgba(40,40,60,.8);color:#fff;border:0;border-radius:6px;
 padding:4px 8px;font:12px system-ui,sans-serif;cursor:pointer}
` });
  document.head.appendChild(css);

  status_el = el('div', { className: 'mc_small' });
  list_el = el('div');
  log_el = el('pre', { textContent: '', style: 'display:none' });

  const file_in = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none',
    onchange: (e) => { if (e.target.files[0]) import_calibration(e.target.files[0]); e.target.value = ''; } });

  panel = el('div', { id: 'mc_panel' }, [
    el('h3', { textContent: 'Multi-camera 3D' }),
    status_el,
    el('h4', { textContent: 'Extra cameras' }),
    el('div', { className: 'mc_small', textContent: 'XR Animator\'s own camera is camera 1. Tick the other cameras here.' }),
    list_el,
    el('button', { textContent: 'Refresh list', onclick: () => ui_refresh(true) }),
    el('h4', { textContent: 'Calibration' }),
    el('label', {}, ['Your height (cm, optional): ',
      el('input', { type: 'text', value: settings.user_height_cm, oninput: (e) => { settings.user_height_cm = e.target.value; save_settings(); } })]),
    el('button', { id: 'mc_calib_btn', textContent: `Calibrate (${CALIB_SECONDS} s)`, onclick: start_calibration }),
    el('button', { textContent: 'Save file', onclick: export_calibration }),
    el('button', { textContent: 'Load file', onclick: () => file_in.click() }),
    el('button', { textContent: 'Clear', onclick: () => { set_calibration(null); ui_log('Calibration cleared.'); } }),
    file_in,
    el('h4', { textContent: 'Options' }),
    el('label', {}, [el('input', { type: 'checkbox', id: 'mc_enabled', checked: settings.enabled,
      onchange: (e) => { settings.enabled = e.target.checked; fuser?.reset(); save_settings(); } }), ' Use multi-camera 3D']),
    el('label', {}, [el('input', { type: 'checkbox', checked: settings.level,
      onchange: (e) => { settings.level = e.target.checked; save_settings(); } }), ' Keep the avatar level (ignore camera 1 tilt)']),
    el('label', {}, [el('input', { type: 'checkbox', checked: settings.show_button,
      onchange: (e) => { settings.show_button = e.target.checked; save_settings(); if (button) button.style.display = settings.show_button ? '' : 'none'; } }), ' Show the "3D" button (Ctrl+Shift+M always works)']),
    log_el,
  ]);
  document.body.appendChild(panel);

  button = el('button', { id: 'mc_btn', textContent: '3D', title: 'Multi-camera 3D (Ctrl+Shift+M)', onclick: toggle_panel });
  if (!settings.show_button) button.style.display = 'none';
  document.body.appendChild(button);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key == 'M' || e.key == 'm')) { e.preventDefault(); e.stopPropagation(); toggle_panel(); }
  }, true);

  // keep XR Animator's own keyboard/mouse handlers out of the panel
  for (const ev of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) {
    panel.addEventListener(ev, (e) => e.stopPropagation());
    button.addEventListener(ev, (e) => { if (ev != 'click') e.stopPropagation(); });
  }

  ui_refresh();
  setInterval(ui_status, 1000);
}

function toggle_panel() {
  if (!panel) return;
  panel.style.display = (panel.style.display == 'block') ? 'none' : 'block';
  if (panel.style.display == 'block') ui_refresh(true);
}

function ui_log(msg) {
  console.log('[multicam] ' + msg);
  if (!log_el) return;
  log_el.style.display = '';
  log_el.textContent += msg + '\n';
  log_el.scrollTop = log_el.scrollHeight;
}

function ui_status() {
  if (!status_el) return;
  try { _ui_status(); }
  catch (e) { console.warn('[multicam] status', e); }
}

function _ui_status() {
  const cal = settings.calibration;
  const lines = [];
  lines.push(`Camera 1 (XR Animator): ${cam0_label() || 'not started'}, ${stats.cam0_fps.toFixed(0)} fps`);
  extra.forEach((c, i) => lines.push(`Camera ${i + 2}: ${c.error ? 'ERROR ' + c.error : (c.ready ? (c.fps || 0).toFixed(0) + ' fps' : 'loading tracker...')}`));
  if (recording) lines.push(`Recording... ${Math.max(0, (recording.until - performance.now()) / 1000).toFixed(0)} s left, ${recording.samples.length} frames`);
  else if (calibrating) lines.push('Calculating calibration...');
  else if (!cal) lines.push('Not calibrated yet.');
  else {
    lines.push(`Calibrated for ${cal.cameras.length} cameras (${cal.rms_px.toFixed(1)} px).`);
    if (cal.cameras.length != extra.length + 1) lines.push(`Needs ${cal.cameras.length - 1} extra camera(s) open, you have ${extra.length}.`);
    if (cal.cameras[0].label && cam0_label() && cal.cameras[0].label != cam0_label()) lines.push('Warning: camera 1 is a different camera than when calibrated.');
    lines.push(stats.active ? `3D active: ${stats.tri} joints triangulated, ${stats.mono} from one camera.` : '3D not active right now.');
  }
  if (stats.last_error) lines.push('Last error: ' + stats.last_error);
  status_el.textContent = '';
  lines.forEach(l => status_el.append(el('div', { textContent: l })));
  const b = document.getElementById('mc_calib_btn');
  if (b) b.disabled = !!(recording || calibrating);
}

async function ui_refresh(relist) {
  if (!panel) return;
  ui_status();
  if (!relist && list_el.childElementCount) {
    // update previews only
    list_el.querySelectorAll('.mc_cam').forEach(row => {
      const cam = extra.find(c => c.deviceId == row.dataset.id);
      const v = row.querySelector('video');
      if (cam?.stream && v.srcObject !== cam.stream) { v.srcObject = cam.stream; v.play().catch(() => {}); }
      row.querySelector('input').checked = !!cam;
    });
    return;
  }
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind == 'videoinput'); }
  catch (e) {}
  const own = cam0_device_id();
  list_el.textContent = '';
  // before camera permission is granted, devices come back with empty ids
  const others = devices.filter(d => d.deviceId && d.deviceId != own);
  if (!others.length) list_el.append(el('div', { className: 'mc_small', textContent: 'No other cameras found (start XR Animator\'s camera first so labels show up).' }));
  for (const d of others) {
    const cam = extra.find(c => c.deviceId == d.deviceId);
    const v = el('video', { muted: true, playsInline: true, autoplay: true });
    if (cam?.stream) { v.srcObject = cam.stream; v.play().catch(() => {}); }
    const row = el('div', { className: 'mc_cam' }, [
      el('input', { type: 'checkbox', checked: !!cam, onchange: (e) => {
        if (e.target.checked) { settings.extra_devices = [...new Set(settings.extra_devices.concat(d.deviceId))]; open_extra(d.deviceId); }
        else { settings.extra_devices = settings.extra_devices.filter(x => x != d.deviceId); close_extra(d.deviceId); }
        save_settings();
      } }),
      v,
      el('span', { textContent: d.label || ('camera ' + d.deviceId.slice(0, 6)) }),
    ]);
    row.dataset.id = d.deviceId;
    list_el.append(row);
  }
}

// reopen the extra cameras from last time, once XR Animator's own camera is running
function auto_reopen() {
  const timer = setInterval(() => {
    if (!camera()?.stream) return;
    clearInterval(timer);
    const own = cam0_device_id();
    navigator.mediaDevices.enumerateDevices().then(list => {
      const ids = new Set(list.filter(d => d.kind == 'videoinput').map(d => d.deviceId));
      for (const id of settings.extra_devices) if (id != own && ids.has(id)) open_extra(id);
    }).catch(() => {});
  }, 1000);
}

function start() {
  build_ui();
  auto_reopen();
}

if (document.readyState == 'complete') start();
else window.addEventListener('load', start);

window.MC_multicam = {
  process,
  open_extra, close_extra, start_calibration, set_calibration,
  get settings() { return settings; },
  get extra() { return extra; },
  get stats() { return stats; },
  toggle_panel,
};

})();
