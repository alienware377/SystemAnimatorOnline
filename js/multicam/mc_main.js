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
// left <-> right partner of every BlazePose joint. In a mirrored image the tracker
// calls your right hand "left", so mirrored data needs both x flipped and labels swapped.
const MIRROR = BLAZEPOSE.map(n => BLAZEPOSE.indexOf(n.replace(/left|right/, (m) => (m == 'left') ? 'right' : 'left')));
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
  hands: true,            // track hands on the extra cameras too, and fuse them in 3D
  face: true,             // read the face on the extra cameras too, and mix it by which camera the face points at
  position_3d: true,      // avatar position (walking, crouching, jumping) from the real 3D distance
  feet: true,             // keep feet on the floor and stop them sliding while they stand still
  setup_prompt: 'ask',    // 'ask' = offer setup when another camera is found, 'never' = don't
  phones_server: false,   // let phones connect as cameras (remembered, so phones can reconnect)
  phone_port: 39600,
  phone_token: '',        // part of the phone link; "New link" changes it
  phone_names: {},
  layout: [],             // rough camera layout from the Layout tab: [{ x, z, h, fov }] in metres / degrees
  layout_hint: true,      // give that layout to Calibrate as a starting guess
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
// latest frame, for the live views
const live = { cam0_kp: null, cam0_flip: false, fused: null, hands: null, cam0_hands: null, face: null, t: 0 };
let hand_fuser = null;
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

// rough layout (Layout tab) -> cameras in the calibration format
function current_sizes() {
  const C = camera();
  return [{ width: C?.video_canvas?.width || 1280, height: C?.video_canvas?.height || 720 }]
    .concat(extra.map(c => ({ width: c.w || c.video?.videoWidth || 1280, height: c.h || c.video?.videoHeight || 720 })));
}

function default_layout(i) {
  const spots = [{ x: 0, z: 2.5, h: 1.3 }, { x: 2.2, z: 1.2, h: 1.5 }, { x: -2.2, z: 1.2, h: 1.5 }, { x: 0, z: -2.5, h: 1.5 }];
  return Object.assign({ fov: 65 }, spots[i] || { x: 2.5 * Math.cos(i), z: 2.5 * Math.sin(i), h: 1.5 });
}

function layout_entry(i) {
  if (!settings.layout[i]) settings.layout[i] = default_layout(i);
  return settings.layout[i];
}

function layout_cams(sizes) {
  sizes = sizes || current_sizes();
  return sizes.map((sz, i) => {
    const L = layout_entry(i);
    const pos = [+L.x, +L.h, +L.z];
    let z = G.v_sub([0, 1.0, 0], pos);
    z = G.v_norm(G.v_len(z) > 1e-6 ? z : [0, 0, -1]);
    const x = G.v_norm(G.v_cross(z, [0, 1, 0]));
    const y = G.v_cross(z, x);
    const R = [...x, ...y, ...z];
    return { R, t: G.v_scale(G.m3_v(R, pos), -1), f: G.default_focal(sz.width, +L.fov || 65), width: sz.width, height: sz.height,
      center: pos, solved: true, hfov_deg: +L.fov || 65 };
  });
}

// skip calibration and track straight from the rough layout (less accurate)
function use_layout_as_calibration() {
  const cams = layout_cams();
  cams[0].label = cam0_label();
  extra.forEach((c, i) => { cams[i + 1].label = c.label; cams[i + 1].deviceId = c.deviceId; });
  set_calibration({ version: 1, created: new Date().toISOString(), rms_px: NaN, from_layout: true, cameras: cams });
  ui_log('Using your rough layout as the calibration. A real calibration is more accurate.');
}

function set_calibration(cal) {
  settings.calibration = cal;
  fuser = cal ? FUSE.create(cal) : null;
  hand_fuser = cal ? FUSE.create_hands(cal) : null;
  save_settings();
  ui_refresh();
}
if (settings.calibration) {
  try { fuser = FUSE.create(settings.calibration); hand_fuser = FUSE.create_hands(settings.calibration); }
  catch (e) { settings.calibration = null; }
}

// ---------- extra cameras ----------

async function open_extra(deviceId) {
  if (extra.some(c => c.deviceId == deviceId)) return;
  if (is_phone(deviceId)) { extra.push(make_phone(deviceId)); ui_refresh(true); return; }
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
  cam.worker.postMessage({ type: 'init', param: { model_quality: settings.model_quality, hands: true, face: true } });

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
    cam.worker.postMessage({ type: 'frame', bitmap, ts, id: ++cam.frame_id, hands: !!settings.hands, face: !!settings.face }, [bitmap]);
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
  cam.history.push({ ts: d.ts, landmarks: d.landmarks, worldLandmarks: d.worldLandmarks, hands: d.hands || null, face: d.face || null });
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
  if (cam.remote) { cam.conn?.send({ type: 'bye' }); cam.conn?.close(); }
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
  // phones arrive over Wi-Fi with more timing jitter, so they get a wider window
  const max_gap = cam.remote ? 120 : 70;
  if (a && b && a !== b && b.ts - a.ts < 2 * max_gap) {
    const k = (t - a.ts) / (b.ts - a.ts);
    const lerp = (p, q) => p + (q - p) * k;
    const near = (t - a.ts < b.ts - t) ? a : b;
    return {
      hands: near.hands,
      face: near.face,
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
  if (n && Math.abs(n.ts - t) < max_gap) return { landmarks: n.landmarks, worldLandmarks: n.worldLandmarks, hands: n.hands, face: n.face };
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
  // camera 1 is usually mirrored: undo it so every camera sees the real, un-mirrored person
  const src = (j) => flip ? MIRROR[j] : j;
  const landmarks = kp.map((_, j) => {
    const k = kp[src(j)];
    return { x: flip ? 1 - k.position.x / W : k.position.x / W, y: k.position.y / H, visibility: k.score ?? 0 };
  });
  const w3 = posenet.keypoints3D_raw || posenet.keypoints3D;
  const worldLandmarks = (w3 && w3.length == 33) ? w3.map((_, j) => { const p = w3[src(j)]; return { x: flip ? -p.x : p.x, y: p.y, z: p.z }; }) : null;
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

  const v0 = cam0_view(result.posenet);
  const kp = result.posenet?.keypoints;
  live.cam0_kp = (kp && kp.length == 33) ? kp.map(k => ({ x: k.position.x, y: k.position.y, score: k.score })) : null;
  live.cam0_flip = !!camera()?.video_flipped;
  live.fused = null;
  // camera 1's own hands: for the live view, and to learn what its Left/Right labels mean
  const hp = Array.isArray(result.handpose) ? result.handpose : null;
  live.cam0_hands = hp && hp.map(h => ({ label: h.label, kp: h.keypoints?.map(k => [k[0], k[1]]) }));
  if (hp) learn_labels(hp, live.cam0_flip);
  live.t = now;
  if (!extra.length) { stats.active = false; return result; }
  // capture time of camera 1's frame: now minus the time XR Animator's worker spent on it
  const t_cap = now - (result._t || 0);
  const views_norm = [v0 ? { landmarks: v0.landmarks, worldLandmarks: v0.worldLandmarks } : null]
    .concat(extra.map(c => (c.ready ? view_at(c, t_cap) : null)));

  if (recording) {
    if (!recording.cams_info) {
      const C = camera();
      recording.cams_info = [{ width: C.video_canvas.width, height: C.video_canvas.height, label: cam0_label() }]
        .concat(extra.map(c => ({ width: c.w || c.video?.videoWidth || 1280, height: c.h || c.video?.videoHeight || 720, label: c.label, deviceId: c.deviceId })));
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
  plant_feet(fused, now);
  live.fused = fused;
  live.pos_ok = position_sample_ok(fused, v0, cal.cameras[0]);

  update_face_mix(fused, views_norm, cal, now);

  const vcam = virtual_cam(cal.cameras[0]);
  if (settings.hands && hand_fuser && (result.handpose == null || Array.isArray(result.handpose))) {
    const hand_views = [cam0_hand_views(result.handpose, cal.cameras[0])]
      .concat(views_norm.slice(1).map((v, i) => extra_hand_views(v?.hands, cal.cameras[i + 1])));
    const hands = hand_fuser.fuse(hand_views, fused);
    live.hands = hands;
    stats.hands = ['L', 'R'].map(s => hands[s] ? hands[s].source : '-').join('/');
    const hp = build_handpose(hands, result.handpose, cal.cameras[0], vcam);
    if (hp) result.handpose = hp;
  }
  else live.hands = null;

  result.posenet = build_posenet(fused, result.posenet, cal.cameras[0], vcam);
  return result;
}

// ---------- avatar position ----------
// XR Animator places the avatar along the ray through the hips in camera 1's picture
// (already exact with the 3D data), at a distance it guesses from body size. Here the
// distance comes from the real 3D hips instead. Its distance units depend on the
// avatar, so the conversion is learned from moments it can judge well itself:
// standing upright, facing camera 1, whole torso in view.

const pos = { ratios: [], k: null, n: 0 };

function position_sample_ok(fused, v0, cal0) {
  const P = fused.points, S = fused.source;
  if (![11, 12, 23, 24].every(j => P[j] && S[j] == 'tri')) return false;
  if (!v0 || ![11, 12, 23, 24].every(j => v0.landmarks[j].visibility > 0.8)) return false;
  const hip = fused.hip, sh = G.v_scale(G.v_add(P[11], P[12]), 0.5);
  const spine = G.v_norm(G.v_sub(sh, hip));
  if (spine[1] < 0.9) return false;                                   // upright
  const to_cam = G.v_norm(G.v_sub(cal0.center || G.camera_center(cal0), hip));
  const across = G.v_norm(G.v_sub(P[12], P[11]));
  return Math.abs(G.v_dot(across, to_cam)) < 0.3;                     // facing camera 1
}

// called from XR Animator's hip code with its current hip vector C (camera-relative);
// returns how much to scale C so its length matches the real distance
function hip_depth_scale(C) {
  try {
    if (!settings.position_3d || !stats.active || !live.fused || performance.now() - live.t > 250) return null;
    const cal = settings.calibration;
    const hc = G.cam_to_local(virtual_cam(cal.cameras[0]), live.fused.hip);
    const dist = G.v_len(hc);
    const len = Math.hypot(C.x, C.y, C.z);
    if (!(len > 0) || !(dist > 0.3)) return null;
    if (live.pos_ok) {
      pos.ratios.push(len / dist);
      if (pos.ratios.length > 600) pos.ratios.shift();
      if (++pos.n % 15 == 0 && pos.ratios.length >= 45) {
        const r = pos.ratios.slice().sort((a, b) => a - b);
        pos.k = r[r.length >> 1];
      }
    }
    if (!pos.k) return null;
    return pos.k * dist / len;
  }
  catch (e) { return null; }
}

// ---------- feet ----------
// The floor is at height 0 (calibration levels the room). A foot close to the floor
// that isn't moving is "planted": it's kept exactly on the floor and held in place,
// so standing feet don't slide or jitter. Feet never go below the floor.

const FOOT = { L: [27, 29, 31], R: [28, 30, 32] };
const feet = { L: null, R: null };

function plant_feet(fused, now) {
  if (!settings.feet || !settings.calibration) return;
  for (const side of ['L', 'R']) {
    const idx = FOOT[side];
    const pts = idx.map(j => fused.points[j]);
    if (pts.some(p => !p)) { feet[side] = null; continue; }
    let low = Math.min(...pts.map(p => p[1]));
    const shift = (dx, dy, dz) => idx.forEach(j => { fused.points[j] = G.v_add(fused.points[j], [dx, dy, dz]); });
    if (low < 0) { shift(0, -low, 0); low = 0; }
    const c = [pts.reduce((s, p) => s + p[0], 0) / 3, pts.reduce((s, p) => s + p[2], 0) / 3];
    const st = feet[side] || (feet[side] = { smooth: c, t: now, anchor: null });
    const dt = Math.max(1e-3, (now - st.t) / 1000);
    // judge movement on a smoothed position, so tracking jitter doesn't count as moving
    const prev = st.smooth;
    st.smooth = [prev[0] + (c[0] - prev[0]) * 0.3, prev[1] + (c[1] - prev[1]) * 0.3];
    const speed = Math.hypot(st.smooth[0] - prev[0], st.smooth[1] - prev[1]) / dt;
    st.t = now;
    if (low < 0.04 && speed < 0.3) {
      shift(0, -low, 0);
      const cur = idx.map(j => fused.points[j]);
      // planted: hold the whole foot where it is, only following very slowly
      if (!st.anchor || Math.hypot(c[0] - st.anchor.c[0], c[1] - st.anchor.c[1]) > 0.06) st.anchor = { c, pts: cur.map(p => p.slice()) };
      else st.anchor.pts = st.anchor.pts.map((q, k) => [q[0] + (cur[k][0] - q[0]) * 0.05, q[1] + (cur[k][1] - q[1]) * 0.05, q[2] + (cur[k][2] - q[2]) * 0.05]);
      idx.forEach((j, k) => { fused.points[j] = st.anchor.pts[k].slice(); });
    }
    else st.anchor = null;
  }
}

// ---------- face ----------
// Every camera that sees the face gets a weight from how directly the face points
// at it (from the 3D nose and ears): straight on counts most, beyond about 70
// degrees off it doesn't count. mc_face.js mixes the ARKit values with these.

function update_face_mix(fused, views_norm, cal, now) {
  live.face = null;
  if (!settings.face) return;
  const P = fused.points;
  if (!P[0] || !P[7] || !P[8]) return;
  const fwd = G.v_norm(G.v_sub(P[0], G.v_scale(G.v_add(P[7], P[8]), 0.5)));
  const weights = cal.cameras.map((c, i) => {
    if (!c.solved) return 0;
    if (i > 0 && !views_norm[i]?.face) return 0;
    const d = G.v_norm(G.v_sub(c.center || G.camera_center(c), P[0]));
    const f = G.v_dot(fwd, d);
    return f > 0.35 ? Math.pow((f - 0.35) / 0.65, 2) : 0;
  });
  live.face = { weights, faces: views_norm.map((v, i) => i ? (v?.face || null) : null), t: now };
  // camera 1 can't see the face at all: keep the face going from the other cameras
  const F = window.MC_face;
  if (F && !F.xra_face_alive && weights.some((w, i) => i && w > 0)) F.feed_extra();
}

function face_mix() {
  if (!live.face || performance.now() - live.face.t > 300) return null;
  return live.face;
}

// ---------- hands ----------
// XR Animator pairs a hand with an arm by its "Left"/"Right" label. Which real hand
// that label means depends on mirroring, so it's learned live: every hand XR Animator
// reports is matched to the nearest wrist in its own picture (seen so far: in the
// usual mirrored view, "Left" is the person's real left hand).

const FINGERS = { palm: [0], thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
function annotate(kp) {
  const a = {};
  for (const k in FINGERS) a[k] = FINGERS[k].map(i => kp[i]);
  return a;
}
const label_votes = { Left: { L: 0, R: 0 }, Right: { L: 0, R: 0 } };
function learn_labels(handpose, flip) {
  const kp = live.cam0_kp;
  if (!kp) return;
  for (const h of handpose) {
    const v = label_votes[h.label], k0 = h.keypoints?.[0];
    if (!v || !k0 || !kp[15] || !kp[16]) continue;
    const d15 = Math.hypot(k0[0] - kp[15].x, k0[1] - kp[15].y), d16 = Math.hypot(k0[0] - kp[16].x, k0[1] - kp[16].y);
    if (Math.min(d15, d16) > 0.6 * Math.max(d15, d16)) continue;   // too close to call
    const slot = d15 < d16 ? 15 : 16;
    const real = flip ? MIRROR[slot] : slot;                        // the person's own wrist
    const side = real == 15 ? 'L' : 'R';
    v[side] = Math.min(v[side] + 1, 50);
    v[side == 'L' ? 'R' : 'L'] = Math.max(v[side == 'L' ? 'R' : 'L'] - 1, 0);
  }
}
function label_side(label) {
  const v = label_votes[label];
  if (v && v.L != v.R) return v.L > v.R ? 'L' : 'R';
  return label == 'Left' ? 'L' : 'R';
}
function side_label(side) {
  return (label_side('Left') == side) ? 'Left' : 'Right';
}

function cam0_hand_views(handpose, cal0) {
  const out = {};
  const C = camera();
  const W = C?.video_canvas?.width, H = C?.video_canvas?.height;
  if (!Array.isArray(handpose) || !W) return out;
  const flip = !!C.video_flipped;
  for (const h of handpose) {
    if (!h?.keypoints || h.keypoints.length != 21) continue;
    const side = label_side(h.label);
    const wk = h.worldLandmarks?.keypoints;
    out[side] = {
      score: h.score ?? 0.8,
      lm: h.keypoints.map(k => {
        const x = flip ? 1 - k[0] / W : k[0] / W;
        return { u: (x - 0.5) * cal0.width, v: (k[1] / H - 0.5) * cal0.height, vis: h.score ?? 0.8 };
      }),
      wl: (wk && wk.length == 21 && Array.isArray(wk[0])) ? wk.map(p => ({ x: flip ? -p[0] : p[0], y: p[1], z: p[2] })) : null,
    };
  }
  return out;
}

function extra_hand_views(hands, cam) {
  const out = {};
  if (!hands) return out;
  for (const h of hands) {
    out[h.side] = {
      score: h.score,
      lm: h.landmarks.map(l => ({ u: (l.x - 0.5) * cam.width, v: (l.y - 0.5) * cam.height, vis: h.score })),
      wl: h.world,
    };
  }
  return out;
}

// fused hands -> XR Animator's handpose list (2D keypoints in camera 1's picture + true 3D shape)
function build_handpose(hands, original, cal0, vcam) {
  const C = camera();
  const W = C.video_canvas.width;
  const flip = !!C.video_flipped;
  const sx = W / cal0.width;
  const orig = Array.isArray(original) ? original : [];
  const out = [];
  for (const side of ['L', 'R']) {
    const label = side_label(side);
    const fh = hands[side];
    const o = orig.find(h => h.label == label);
    if (!fh) { if (o) out.push(o); continue; }
    const wrist_c = G.cam_to_local(vcam, fh.points[0]);
    const keypoints = fh.points.map(X => {
      const pc = G.cam_to_local(vcam, X);
      let x = (cal0.f * pc[0] / pc[2] + cal0.width / 2) * sx;
      const y = (cal0.f * pc[1] / pc[2] + cal0.height / 2) * sx;
      if (flip) x = W - x;
      return [x, y, cal0.f * (pc[2] - wrist_c[2]) / wrist_c[2] * sx];
    });
    const world = fh.points.map(X => {
      const r = G.m3_v(vcam.R, G.v_sub(X, fh.points[0]));
      return [flip ? -r[0] : r[0], r[1], r[2]];
    });
    out.push({
      score: fh.source == 'tri' ? 0.95 : 0.8,
      label,
      keypoints,
      annotations: annotate(keypoints),
      worldLandmarks: { keypoints: world, annotations: annotate(world) },
      _multicam: fh.source,
    });
  }
  return out.length ? out : null;
}

// camera 1's position and heading; levelled if "Keep the avatar level" is on
function virtual_cam(cal0) {
  let R = cal0.R;
  const center = cal0.center || G.camera_center(cal0);
  if (settings.level) {
    let z = [R[6], 0, R[8]];
    z = G.v_norm((G.v_len(z) > 1e-6) ? z : [0, 0, -1]);
    const x = G.v_norm(G.v_cross(z, [0, 1, 0]));
    const y = G.v_cross(z, x);
    R = [...x, ...y, ...z];
  }
  return { R, t: G.v_scale(G.m3_v(R, center), -1), f: cal0.f };
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
function build_posenet(fused, original, cal0, vcam) {
  const C = camera();
  const W = C.video_canvas.width, H = C.video_canvas.height;
  const flip = !!C.video_flipped;
  const sx = W / cal0.width;
  vcam = vcam || virtual_cam(cal0);
  const R = vcam.R;

  const hip_c = G.cam_to_local(vcam, fused.hip);
  const orig_kp = original?.keypoints?.length == 33 ? original.keypoints : null;

  const keypoints = [], keypoints3D = [];
  for (let j = 0; j < 33; j++) {
    // slot j in XR Animator's (possibly mirrored) convention comes from real joint s
    const s = flip ? MIRROR[j] : j;
    const X = fused.points[s];
    const part = orig_kp?.[j]?.part || PART_NAMES[j];
    if (!X) {
      // nobody sees it: keep camera 1's own estimate
      const o = orig_kp?.[j];
      keypoints.push(o || { position: { x: 0, y: 0, z: 0 }, score: 0, part });
      const o3 = original?.keypoints3D?.[j];
      keypoints3D.push(o3 || { x: 0, y: 0, z: 0, name: BLAZEPOSE[j], score: 0 });
      continue;
    }
    const src = fused.source[s];
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
    options: {
      user_height_m: (h > 100 && h < 250) ? h / 100 : undefined,
      layout: settings.layout_hint ? layout_cams(rec.cams_info).map(c => ({ R: c.R, t: c.t, f: c.f })) : undefined,
    },
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
#mc_btn{position:fixed;left:8px;bottom:48px;z-index:2147483000;background:rgba(40,40,60,.8);color:#fff;border:0;border-radius:6px;
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
    el('button', { textContent: 'Live view', title: 'Cameras, 3D view, layout and face (Ctrl+Shift+L)', onclick: () => window.MC_view?.toggle() }),
    build_phones_ui(),
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
    el('label', {}, [el('input', { type: 'checkbox', checked: settings.hands,
      onchange: (e) => { settings.hands = e.target.checked; save_settings(); } }), ' Use the extra cameras for hands too']),
    el('label', {}, [el('input', { type: 'checkbox', checked: settings.face,
      onchange: (e) => { settings.face = e.target.checked; save_settings(); } }), ' Use the extra cameras for the face too']),
    el('label', {}, [el('input', { type: 'checkbox', checked: settings.position_3d,
      onchange: (e) => { settings.position_3d = e.target.checked; save_settings(); } }), ' Avatar position from 3D (walking, crouching, jumping)']),
    el('label', {}, [el('input', { type: 'checkbox', checked: settings.feet,
      onchange: (e) => { settings.feet = e.target.checked; save_settings(); } }), ' Keep feet on the floor']),
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
  extra.forEach((c, i) => lines.push(`Camera ${i + 2}${c.remote ? ' (' + c.label + ')' : ''}: ` + (c.error ? 'ERROR ' + c.error
    : c.remote && !c.connected ? 'phone not connected'
    : c.ready ? (c.fps || 0).toFixed(0) + ' fps' : (c.remote ? 'phone connected, waiting for its camera' : 'loading tracker...'))));
  if (phones_state().running) lines.push(`Phones can connect at ${phones_state().urls[0] || ''}`);
  if (recording) lines.push(`Recording... ${Math.max(0, (recording.until - performance.now()) / 1000).toFixed(0)} s left, ${recording.samples.length} frames`);
  else if (calibrating) lines.push('Calculating calibration...');
  else if (!cal) lines.push('Not calibrated yet.');
  else {
    lines.push(cal.from_layout ? `Using your rough layout for ${cal.cameras.length} cameras (not calibrated).`
      : `Calibrated for ${cal.cameras.length} cameras (${cal.rms_px.toFixed(1)} px).`);
    if (cal.cameras.length != extra.length + 1) lines.push(`Needs ${cal.cameras.length - 1} extra camera(s) open, you have ${extra.length}.`);
    if (cal.cameras[0].label && cam0_label() && cal.cameras[0].label != cam0_label()) lines.push('Warning: camera 1 is a different camera than when calibrated.');
    lines.push(stats.active ? `3D active: ${stats.tri} joints triangulated, ${stats.mono} from one camera.` : '3D not active right now.');
    if (stats.active && settings.position_3d) lines.push(pos.k ? 'Avatar position: from 3D.' : 'Avatar position: learning the distance scale. Stand facing camera 1 for a few seconds.');
    if (stats.active && settings.hands && live.hands) lines.push(`Hands (left/right): ${['L', 'R'].map(s => live.hands[s] ? (live.hands[s].source == 'tri' ? '3D' : 'one camera') : 'not seen').join(' / ')}.`);
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
      if (v && cam?.stream && v.srcObject !== cam.stream) { v.srcObject = cam.stream; v.play().catch(() => {}); }
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
  for (const cam of extra.filter(c => c.remote)) {
    const row = el('div', { className: 'mc_cam' }, [
      el('input', { type: 'checkbox', checked: true, title: 'Untick to stop using this phone', onchange: () => {
        settings.extra_devices = settings.extra_devices.filter(x => x != cam.deviceId);
        close_extra(cam.deviceId);
        save_settings();
      } }),
      cam.preview ? el('img', { src: cam.preview.src, style: 'width:96px;height:54px;object-fit:cover;border-radius:4px;background:#000' }) : el('div', { style: 'width:96px;height:54px;background:#000;border-radius:4px' }),
      el('span', { textContent: `${cam.label} (phone, ${cam.connected ? 'connected' : 'not connected'})` }),
    ]);
    row.dataset.id = cam.deviceId;
    list_el.append(row);
  }
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

// ---------- phone cameras ----------
// Phones open a page this app serves (mc_remote_server.js), track themselves, and
// send results here. Each phone is an extra camera like a webcam: same history,
// same fusion, same calibration. It's remembered by an id the phone keeps, so it
// slots back into its place after a reconnect.

const is_phone = (id) => typeof id == 'string' && id.startsWith('phone:');
const phones_state = () => window.MC_remote_server?.state || { running: false, urls: [] };

function make_phone(id, name) {
  return { deviceId: id, label: name || settings.phone_names[id] || 'Phone', remote: true, video: null, stream: null, worker: null,
    ready: false, busy: false, history: [], frame_id: 0, fps: 0, n: 0, t: performance.now(), error: '', closed: false,
    conn: null, connected: false, preview: null };
}

function phone_token() {
  if (!settings.phone_token) {
    settings.phone_token = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    save_settings();
  }
  return settings.phone_token;
}

async function phones_start(host) {
  const S = window.MC_remote_server;
  if (!S?.available) { ui_log('Phone cameras need the XR Animator desktop app.'); return; }
  const st = await S.start({ port: settings.phone_port, host, token: phone_token(), on_connection: on_phone });
  if (!st.running) { ui_log('Could not let phones connect: ' + (st.error || 'unknown error')); return; }
  settings.phones_server = true;
  save_settings();
  phones_ui_update();
}

function phones_stop() {
  window.MC_remote_server?.stop();
  settings.phones_server = false;
  save_settings();
  extra.filter(c => c.remote).forEach(c => { c.conn?.close(); c.conn = null; c.connected = false; c.ready = false; });
  phones_ui_update();
}

function on_phone(conn, hello) {
  const id = 'phone:' + String(hello.id).replace(/[^\w-]/g, '').slice(0, 32);
  const name = String(hello.name || 'Phone').slice(0, 40);
  let cam = extra.find(c => c.deviceId == id);
  if (!cam) {
    cam = make_phone(id, name);
    extra.push(cam);
    settings.extra_devices = [...new Set(settings.extra_devices.concat(id))];
    ui_log(`Phone "${name}" connected and added. ${settings.calibration ? 'Calibrate again so it gets a place in the room.' : ''}`);
  }
  if (cam.conn && cam.conn !== conn) cam.conn.close();
  Object.assign(cam, { conn, connected: true, label: name, closed: false });
  settings.phone_names[id] = name;
  save_settings();
  conn.send({ type: 'welcome', settings: { hands: settings.hands, face: settings.face, model_quality: settings.model_quality } });
  conn.onmessage = (m) => on_phone_message(cam, conn, m);
  conn.onclose = () => { if (cam.conn === conn) { cam.conn = null; cam.connected = false; cam.ready = false; ui_refresh(true); } };
  ui_refresh(true);
}

function on_phone_message(cam, conn, m) {
  if (cam.conn !== conn) return;
  if (m.type == 'ping') conn.send({ type: 'pong', t0: m.t0, t1: performance.now() });
  else if (m.type == 'result') {
    cam.ready = true;
    cam.busy = true;   // on_worker_message clears it
    on_worker_message(cam, { type: 'result', ts: +m.ts, w: m.w, h: m.h, landmarks: m.landmarks, worldLandmarks: m.worldLandmarks, hands: m.hands || null, face: m.face || null });
  }
  else if (m.type == 'preview' && typeof m.jpeg == 'string' && m.jpeg.startsWith('data:image/jpeg')) {
    const img = new Image();
    img.onload = () => { cam.preview = img; };
    img.src = m.jpeg;
  }
  else if (m.type == 'hello') { cam.label = String(m.name || cam.label).slice(0, 40); }
  else if (m.type == 'stopped') { cam.ready = false; }
}

let phones_box = null;
function build_phones_ui() {
  phones_box = el('div');
  phones_ui_update();
  return el('div', {}, [el('h4', { textContent: 'Phone cameras' }), phones_box]);
}

function phones_ui_update() {
  if (!phones_box) return;
  phones_box.textContent = '';
  const S = window.MC_remote_server;
  if (!S?.available) { phones_box.append(el('div', { className: 'mc_small', textContent: 'Phones and tablets can be cameras too, in the XR Animator desktop app.' })); return; }
  const st = S.state;
  if (!st.running) {
    phones_box.append(
      el('div', { className: 'mc_small', textContent: 'Use iPhones, Android phones or tablets as extra cameras over Wi-Fi. No app needed.' }),
      el('button', { textContent: 'Let phones connect', onclick: () => phones_start() }));
    return;
  }
  const url = st.urls[0] || '';
  const qr = el('canvas', { style: 'width:150px;height:150px;image-rendering:pixelated;border-radius:6px;display:block;margin:6px 0' });
  try { window.MC_qr.draw(qr, url, 4, 3); } catch (e) {}
  phones_box.append(
    el('div', { className: 'mc_small', textContent: 'On the phone (same Wi-Fi): scan this, or open the address below in Safari / Chrome.' }),
    qr,
    el('div', { style: 'font:12px monospace;word-break:break-all;user-select:text;white-space:pre-line', textContent: st.urls.join('\n') }),
    el('div', { className: 'mc_small', style: 'margin-top:4px', textContent: 'The first time, the phone warns that the connection is not private (this PC made its own certificate). Tap "Advanced" then "Proceed" (Android), or "Show Details" then "visit this website" (iPhone). Then allow the camera and tap "Start camera". If nothing connects, allow XR Animator through the Windows firewall for private networks.' }),
    el('button', { textContent: 'Stop phones connecting', onclick: phones_stop }),
    el('button', { textContent: 'New link', title: 'Old links stop working', onclick: () => { settings.phone_token = ''; phones_stop(); phones_start(); } }));
}

// reopen the extra cameras from last time, once XR Animator's own camera is running
function auto_reopen() {
  const timer = setInterval(() => {
    if (!camera()?.stream) return;
    clearInterval(timer);
    const own = cam0_device_id();
    navigator.mediaDevices.enumerateDevices().then(list => {
      const cams = list.filter(d => d.kind == 'videoinput' && d.deviceId);
      const ids = new Set(cams.map(d => d.deviceId));
      for (const id of settings.extra_devices) if (is_phone(id) || (id != own && ids.has(id))) open_extra(id);
      const others = cams.filter(d => d.deviceId != own);
      if (!settings.extra_devices.length && others.length && settings.setup_prompt != 'never') setup_prompt(others);
    }).catch(() => {});
  }, 1000);
}

// First time another camera is around: offer to set multi-camera up, so nobody
// has to know the shortcut. Never switches a camera on by itself (it could be a
// capture card or a virtual camera).
function setup_prompt(others) {
  if (document.getElementById('mc_prompt')) return;
  const one = others.length == 1;
  const name = one ? (others[0].label || 'another camera') : `${others.length} other cameras`;
  const close = () => box.remove();
  const btn = (text, fn, main) => el('button', { textContent: text, onclick: () => { close(); fn(); },
    style: `margin:8px 6px 0 0;padding:6px 12px;border:0;border-radius:6px;cursor:pointer;font:inherit;color:#fff;background:${main ? '#5b5fc7' : '#3a3f5c'}` });
  const box = el('div', { id: 'mc_prompt', style: 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:2147483002;max-width:380px;' +
    'background:rgba(20,20,28,.97);color:#eee;font:14px/1.45 system-ui,sans-serif;border-radius:12px;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.6)' }, [
    el('div', { style: 'font-weight:600;font-size:15px;margin-bottom:6px', textContent: 'Another camera found' }),
    el('div', { textContent: `Found ${name}. Use it together with this camera for 3D body, hand and face tracking?` }),
    el('div', {}, [
      btn('Set up', () => {
        if (one) {
          settings.extra_devices = [others[0].deviceId];
          save_settings();
          open_extra(others[0].deviceId);
          ui_log('Camera added. Next: click "Calibrate" and walk around for 30 seconds where both cameras can see you.');
        }
        else ui_log('Tick the cameras you want to use, then click "Calibrate".');
        if (panel && panel.style.display != 'block') toggle_panel();
      }, true),
      btn('Not now', () => {}),
      btn('Don\'t ask again', () => { settings.setup_prompt = 'never'; save_settings(); }),
    ]),
    el('div', { style: 'color:#99a;font-size:12px;margin-top:8px', textContent: 'You can always open this later with Ctrl+Shift+M or the 3D button.' }),
  ]);
  for (const ev of ['keydown', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'wheel', 'touchstart', 'touchend']) box.addEventListener(ev, (e) => e.stopPropagation());
  document.body.appendChild(box);
}

function start() {
  build_ui();
  auto_reopen();
  if (settings.phones_server) phones_start();
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
  phones_start, phones_stop, _on_phone: on_phone,
  _cam0_view: cam0_view, _label_votes: label_votes, face_mix, hip_depth_scale, _pos: pos, _feet: feet, _setup_prompt: setup_prompt,
  live, MIRROR, BLAZEPOSE, camera,
  layout_entry, layout_cams, use_layout_as_calibration, save_settings, ui_log,
  get calibration() { return settings.calibration; },
};

})();
