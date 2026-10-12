// Synthetic test for the multi-camera maths: fake cameras watch a fake moving
// body, with pixel noise, low-visibility joints and outliers. Checks that
// self-calibration recovers the rig and that triangulation is accurate.
//
// Run: node tools/multicam_selftest.js

const G = require('../js/multicam/mc_geometry.js');
const CAL = require('../js/multicam/mc_calibrate.js');
const FUSE = require('../js/multicam/mc_fuse.js');

const rand = G.seeded_random(4242);
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v); };

function look_at(pos, target, hfov, width, height) {
  const z = G.v_norm(G.v_sub(target, pos));
  const x = G.v_norm(G.v_cross(z, [0,1,0]));
  const y = G.v_cross(z, x);
  const R = [...x, ...y, ...z];
  return { R, t: G.v_scale(G.m3_v(R, pos), -1), f: G.default_focal(width, hfov), width, height };
}

// body frame: Y up, facing +Z, person's left = +X
function body(t, k) {
  const sw = Math.sin(t * 2.2 + k), sw2 = Math.sin(t * 1.3 + 2*k);
  const J = new Array(33);
  J[0] = [0, 1.58, 0.10];
  J[1] = [0.02, 1.62, 0.085]; J[2] = [0.035, 1.62, 0.08]; J[3] = [0.05, 1.62, 0.07];
  J[4] = [-0.02, 1.62, 0.085]; J[5] = [-0.035, 1.62, 0.08]; J[6] = [-0.05, 1.62, 0.07];
  J[7] = [0.075, 1.60, 0.0]; J[8] = [-0.075, 1.60, 0.0];
  J[9] = [0.025, 1.54, 0.09]; J[10] = [-0.025, 1.54, 0.09];
  J[11] = [0.18, 1.42, 0]; J[12] = [-0.18, 1.42, 0];
  J[23] = [0.09, 0.95, 0]; J[24] = [-0.09, 0.95, 0];

  const arm = (s, side, a1, a2) => {
    const d1 = G.v_norm([side * (0.35 + 0.6*Math.max(0, a2)), -Math.cos(a1), Math.sin(a1)]);
    const e = G.v_add(s, G.v_scale(d1, 0.29));
    const d2 = G.v_norm([side * 0.2, -Math.cos(a1 + 0.8 + 0.6*a2), Math.sin(a1 + 0.8 + 0.6*a2)]);
    return [e, G.v_add(e, G.v_scale(d2, 0.25))];
  };
  [J[13], J[15]] = arm(J[11], 1, 0.9*sw, sw2);
  [J[14], J[16]] = arm(J[12], -1, -0.9*sw, -sw2);
  for (const [w, list] of [[15, [17, 19, 21]], [16, [18, 20, 22]]]) {
    list.forEach((j, n) => { J[j] = G.v_add(J[w], [0.02*(n-1), -0.06, 0.03]); });
  }

  const leg = (h, a) => {
    const kn = G.v_add(h, [0, -0.42*Math.cos(a), 0.42*Math.sin(a)]);
    const b = a - Math.max(0, a) * 1.2;
    const an = G.v_add(kn, [0, -0.42*Math.cos(b), 0.42*Math.sin(b)]);
    return [kn, an, G.v_add(an, [0, -0.05, -0.05]), G.v_add(an, [0, -0.07, 0.14])];
  };
  [J[25], J[27], J[29], J[31]] = leg(J[23], 0.5*sw);
  [J[26], J[28], J[30], J[32]] = leg(J[24], -0.5*sw);
  return J;
}

function world_pose(t) {
  const yaw = 0.8 * Math.sin(t * 0.35) + 0.3 * t * 0.1;
  const pos = [0.7 * Math.sin(t * 0.25), 0, 0.5 * Math.sin(t * 0.4)];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const Ry = [c,0,s, 0,1,0, -s,0,c];
  return { Ry, pos, yaw };
}

function make_frame(t, k) {
  const { Ry, pos } = world_pose(t);
  const J = body(t, k).map(p => G.v_add(G.m3_v(Ry, p), pos));
  return { J, Ry };
}

function observe(cam, J, Ry, opts) {
  const lm = [], hip = G.v_scale(G.v_add(J[23], J[24]), 0.5);
  const side_n = G.m3_v(Ry, [1, 0, 0]);
  const cc = G.camera_center(cam);
  let seen = 0;
  for (let j = 0; j < 33; j++) {
    const p = G.project(cam, J[j]);
    const inside = p[2] > 0 && Math.abs(p[0]) < cam.width/2 && Math.abs(p[1]) < cam.height/2;
    const side = (j >= 11 && j % 2 === 1) ? 1 : (j >= 11 && j % 2 === 0) ? -1 : 0;
    const to_cam = G.v_norm(G.v_sub(cc, J[j]));
    let vis = inside ? 0.97 - 0.45 * Math.max(0, -side * G.v_dot(side_n, to_cam)) : 0.05;
    let u = p[0] + gauss() * opts.noise, v = p[1] + gauss() * opts.noise;
    if (rand() < opts.outliers) { u += (rand() - 0.5) * 120; v += (rand() - 0.5) * 120; }
    if (vis > 0.7) seen++;
    lm.push({ u, v, vis });
  }
  // MediaPipe-style world landmarks: hip-centred, camera axes, a bit of scale error
  const wl = J.map(X => {
    const d = G.m3_v(cam.R, G.v_sub(X, hip));
    return { x: d[0]*1.03 + gauss()*0.01, y: d[1]*1.03 + gauss()*0.01, z: d[2]*1.03 + gauss()*0.02 };
  });
  return seen >= 8 ? { lm, wl } : null;
}

function rot_angle_deg(A, B) {
  const M = G.m3_mul(A, G.m3_T(B));
  return Math.acos(Math.min(1, Math.max(-1, (M[0] + M[4] + M[8] - 1) / 2))) * 180 / Math.PI;
}

function run(name, true_cams, opts) {
  console.log(`\n=== ${name} ===`);
  const samples = [];
  for (let i = 0; i < opts.frames; i++) {
    const t = i / 10;
    const { J, Ry } = make_frame(t, i * 0.01);
    samples.push({ views: true_cams.map(c => observe(c, J, Ry, opts)) });
  }

  const mode = process.env.FOV_MODE || "fixed";
  const info = true_cams.map(c => ({ width: c.width, height: c.height, hfov_deg: mode === "true" ? 2 * Math.atan(c.width / 2 / c.f) * 180 / Math.PI : (+process.env.FOV_GUESS || 60) }));
  // optional rough layout: true cameras moved ~25 cm, turned a few degrees, zoom 10% off
  let layout;
  if (opts.layout) {
    layout = true_cams.map(c => {
      const C = G.v_add(G.camera_center(c), [gauss() * 0.25, gauss() * 0.15, gauss() * 0.25]);
      const look = G.v_add(C, G.v_scale(G.v_norm([c.R[6], c.R[7], c.R[8]]), 3));
      const r = look_at(C, G.v_add(look, [gauss() * 0.2, gauss() * 0.1, gauss() * 0.2]), 2 * Math.atan(c.width / 2 / c.f) * 180 / Math.PI * 1.1, c.width, c.height);
      return { R: r.R, t: r.t, f: r.f };
    });
  }
  const cal = CAL.calibrate(samples, info, { log: (s) => console.log("  " + s), user_height_m: opts.height, search_fov: mode === "search", layout });
  const est = cal.cameras;

  let ok = true;
  const check = (label, val, lim, unit) => {
    const pass = val <= lim;
    ok = ok && pass;
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}: ${val.toFixed(3)}${unit} (limit ${lim}${unit})`);
  };

  for (let i = 0; i < true_cams.length; i++) {
    if (!est[i].solved) { console.log(`  FAIL cam${i} not solved`); ok = false; continue; }
    check(`cam${i} focal error`, Math.abs(est[i].f / true_cams[i].f - 1) * 100, 6, '%');
    // camera height above the floor
    check(`cam${i} height error`, Math.abs(est[i].center[1] - G.camera_center(true_cams[i])[1]), 0.08, ' m');
  }
  for (let i = 0; i < true_cams.length; i++) for (let j = i+1; j < true_cams.length; j++) {
    const dt = G.v_len(G.v_sub(G.camera_center(true_cams[i]), G.camera_center(true_cams[j])));
    const de = G.v_len(G.v_sub(est[i].center, est[j].center));
    check(`cam${i}-cam${j} distance error`, Math.abs(de / dt - 1) * 100, 7, '%');
    const rt = G.m3_mul(true_cams[j].R, G.m3_T(true_cams[i].R));
    const re = G.m3_mul(est[j].R, G.m3_T(est[i].R));
    check(`cam${i}-cam${j} relative rotation error`, rot_angle_deg(rt, re), 1.5, ' deg');
  }

  // runtime fusion on fresh frames: bone length stability + up-axis alignment
  const fuser = FUSE.create(cal);
  const errs = [], tilt = [];
  for (let i = 0; i < 100; i++) {
    const t = 1000 + i / 7;
    const { J, Ry } = make_frame(t, 0.3);
    const views = true_cams.map(c => observe(c, J, Ry, opts));
    const res = fuser.fuse(views.map(v => v && { lm: v.lm, wl: v.wl }));
    if (!res) continue;
    for (const [a, b] of [[11, 13], [13, 15], [23, 25], [25, 27], [11, 12]]) {
      if (!res.points[a] || !res.points[b]) continue;
      const Le = G.v_len(G.v_sub(res.points[a], res.points[b]));
      const Lt = G.v_len(G.v_sub(J[a], J[b]));
      errs.push(Math.abs(Le - Lt));
    }
    // spine vs world up
    const P = res.points;
    const sp = G.v_norm(G.v_sub(G.v_scale(G.v_add(P[11], P[12]), 0.5), G.v_scale(G.v_add(P[23], P[24]), 0.5)));
    const st = G.v_norm(G.v_sub(G.v_scale(G.v_add(J[11], J[12]), 0.5), G.v_scale(G.v_add(J[23], J[24]), 0.5)));
    tilt.push(Math.abs(Math.acos(Math.min(1, sp[1])) - Math.acos(Math.min(1, st[1]))) * 180 / Math.PI);
  }
  errs.sort((a, b) => a - b);
  check('fused bone length median error', errs[errs.length >> 1] * 100, 2.5, ' cm');
  check('fused bone length 90th pct error', errs[Math.floor(errs.length * 0.9)] * 100, 6, ' cm');
  tilt.sort((a, b) => a - b);
  check('spine tilt vs truth (median)', tilt[tilt.length >> 1], 3, ' deg');

  console.log(`  rms ${cal.rms_px.toFixed(2)} px -> ${ok ? 'ALL PASS' : 'SOME FAILED'}`);
  return ok;
}

const W = 1280, H = 720;
let all = true;

all = run('2 cams, front + 70 deg side, 2 px noise', [
  look_at([0, 1.3, 2.6], [0, 1.0, 0], 62, W, H),
  look_at([2.4, 1.8, 1.0], [0, 1.0, 0], 75, W, H),
], { frames: 300, noise: 2, outliers: 0.03 }) && all;

all = run('3 cams, front / side / back, 3 px noise, 5% outliers', [
  look_at([0.2, 1.2, 2.8], [0, 1.0, 0], 58, W, H),
  look_at([-2.5, 2.0, 0.3], [0, 0.9, 0], 70, W, H),
  look_at([1.5, 1.6, -2.3], [0, 1.0, 0], 80, W, H),
], { frames: 300, noise: 3, outliers: 0.05 }) && all;

all = run('2 cams close together (stereo-ish, 0.6 m apart)', [
  look_at([-0.3, 1.25, 2.5], [0, 1.0, 0], 65, W, H),
  look_at([0.3, 1.25, 2.5], [0, 1.0, 0], 65, W, H),
], { frames: 300, noise: 1.5, outliers: 0.02 }) && all;

all = run('2 cams, front + 70 deg side, with a rough layout hint', [
  look_at([0, 1.3, 2.6], [0, 1.0, 0], 62, W, H),
  look_at([2.4, 1.8, 1.0], [0, 1.0, 0], 75, W, H),
], { frames: 300, noise: 2, outliers: 0.03, layout: true }) && all;

all = run('2 cams, front + back-side (150 deg apart), with a rough layout hint', [
  look_at([0, 1.4, 2.6], [0, 1.0, 0], 65, W, H),
  look_at([1.3, 1.6, -2.3], [0, 1.0, 0], 70, W, H),
], { frames: 300, noise: 2, outliers: 0.03, layout: true }) && all;


// ---------- hands ----------
function hand_test() {
  console.log('\n=== hands: 2 cameras, triangulated and one-camera fallback ===');
  const cams = [look_at([0, 1.3, 2.6], [0, 1.0, 0], 62, W, H), look_at([2.4, 1.8, 1.0], [0, 1.0, 0], 75, W, H)];
  const cal = { cameras: cams.map(c => Object.assign({ solved: true }, c)) };
  const HF = FUSE.create_hands(cal);
  // a hand: wrist + 5 fingers x 4 joints, palm facing the camera-ish, ~18 cm long
  function hand(wrist, yaw) {
    const pts = [[0, 0, 0]];
    const base = [[0.03, 0.02], [0.025, 0.08], [0.005, 0.085], [-0.015, 0.08], [-0.033, 0.07]];
    base.forEach(([x, y], f) => {
      for (let k = 0; k < 4; k++) {
        const len = f == 0 ? 0.03 * k : 0.025 * k;
        pts.push([x + (f == 0 ? 0.02 * k : 0), y + len, 0.01 * k]);
      }
    });
    const c = Math.cos(yaw), s2 = Math.sin(yaw);
    return pts.map(p => G.v_add(wrist, [c * p[0] + s2 * p[2], p[1], -s2 * p[0] + c * p[2]]));
  }
  let ok = true;
  const errs_tri = [], errs_mono = [];
  for (let i = 0; i < 60; i++) {
    const wrist = [0.3 + 0.2 * Math.sin(i / 7), 1.1 + 0.2 * Math.cos(i / 5), 0.2];
    const P = hand(wrist, i / 10);
    const view = (cam, with_world) => ({
      score: 0.9,
      lm: P.map(X => { const q = G.project(cam, X); return { u: q[0] + gauss() * 1.5, v: q[1] + gauss() * 1.5, vis: 0.9 }; }),
      wl: with_world ? P.map(X => { const d = G.m3_v(cam.R, G.v_sub(X, P[9])); return { x: d[0] + gauss() * 0.004, y: d[1] + gauss() * 0.004, z: d[2] + gauss() * 0.006 }; }) : null,
    });
    const body = { points: Object.assign(new Array(33).fill(null), { 15: G.v_add(wrist, [gauss() * 0.01, gauss() * 0.01, gauss() * 0.01]) }) };
    // both cameras see the left hand; only camera 2 (with world shape) sees the right hand
    const r = HF.fuse([{ L: view(cams[0], false) }, { L: view(cams[1], true), R: view(cams[1], true) }],
      { points: Object.assign(body.points.slice(), { 16: body.points[15] }) });
    if (!r.L || r.L.source != 'tri') { ok = false; continue; }
    r.L.points.forEach((X, j) => errs_tri.push(G.v_len(G.v_sub(X, P[j]))));
    if (!r.R || r.R.source != 'mono') { ok = false; continue; }
    // mono: shape relative to the wrist should match
    r.R.points.forEach((X, j) => errs_mono.push(G.v_len(G.v_sub(G.v_sub(X, r.R.points[0]), G.v_sub(P[j], P[0])))));
  }
  const med = (a) => { const t = a.slice().sort((x, y) => x - y); return t[t.length >> 1]; };
  const check = (label, val, lim) => { const pass = val <= lim; ok = ok && pass; console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}: ${(val * 100).toFixed(2)} cm (limit ${lim * 100} cm)`); };
  check('triangulated hand point error (median)', errs_tri.length ? med(errs_tri) : 1, 0.01);
  check('one-camera hand shape error (median)', errs_mono.length ? med(errs_mono) : 1, 0.012);
  console.log('  ' + (ok ? 'ALL PASS' : 'SOME FAILED'));
  return ok;
}
all = hand_test() && all;

console.log('\n' + (all ? 'SELFTEST OK' : 'SELFTEST FAILED'));
process.exit(all ? 0 : 1);
