// Multi-camera self-calibration from body keypoints (no checkerboard needed).
//
// The user walks around the space for ~20-30 s while every camera tracks the
// body. Matching joints across cameras give the camera poses (essential matrix
// + PnP), then bundle adjustment refines poses and focal lengths together.
// Metric scale comes from bone lengths, and the world frame is levelled using
// the spine direction and the feet.
//
// Sample format (one per synced frame):
//   { views: [ view_or_null for each camera ] }
//   view = { lm: [{ u, v, vis } x33]  (centered pixels), wl: [{ x, y, z } x33] | null (MediaPipe world landmarks, metres) }

(function (root) {

'use strict';

const G = (typeof module === 'object' && module.exports) ? require('./mc_geometry.js') : root.MC_geometry;

// BlazePose joints that are well defined from any side
const CALIB_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

// bones used for metric scale: [a, b]
const SCALE_BONES = [
  [11, 12], [23, 24],           // shoulders, hips
  [11, 13], [12, 14],           // upper arms
  [13, 15], [14, 16],           // forearms
  [23, 25], [24, 26],           // thighs
  [25, 27], [26, 28],           // shins
  [11, 23], [12, 24],           // torso sides
];

// Bones whose length is kept constant across frames during bundle adjustment.
// This is what pins down the focal lengths: with cameras aimed at the same spot,
// two-view geometry alone can't tell zoom from distance, but a wrong zoom makes
// limbs stretch and shrink as the user moves.
const RIGID_BONES = SCALE_BONES.concat([[27, 29], [28, 30], [27, 31], [28, 32], [11, 0], [12, 0]]);

// rough adult proportions as a fraction of height (used only when the caller gives a height)
const BONE_FRACTION = {
  '11-12': 0.205, '23-24': 0.12,
  '11-13': 0.17, '12-14': 0.17,
  '13-15': 0.145, '14-16': 0.145,
  '23-25': 0.245, '24-26': 0.245,
  '25-27': 0.245, '26-28': 0.245,
  '11-23': 0.29, '12-24': 0.29,
};

function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return (s.length & 1) ? s[m] : (s[m-1] + s[m]) / 2;
}

function percentile(a, q) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// cams_info: [{ width, height, hfov_deg?, hfov_known? }]
// options: { min_vis, user_height_m, log, search_fov }
function calibrate(samples, cams_info, options = {}) {
  const log = options.log || (() => {});
  const min_vis = options.min_vis || 0.7;
  const N = cams_info.length;
  if (N < 2) throw new Error('Need at least 2 cameras');

  // matches against camera 0, in centered pixels
  const matches = [];
  for (let i = 1; i < N; i++) {
    const m1 = [], m2 = [];
    samples.forEach((s) => {
      const a = s.views[0], b = s.views[i];
      if (!a || !b) return;
      for (const j of CALIB_JOINTS) {
        if (a.lm[j].vis < min_vis || b.lm[j].vis < min_vis) continue;
        m1.push([a.lm[j].u, a.lm[j].v]);
        m2.push([b.lm[j].u, b.lm[j].v]);
      }
    });
    matches[i] = { m1, m2 };
  }

  // Focal lengths are unknown, and the solver can settle in a wrong valley when
  // the first guess is far off. So try several field-of-view guesses and keep
  // the rig that explains the data best.
  const all_known = cams_info.every(c => c.hfov_known && c.hfov_deg);
  const hyps = [];
  const add_hyp = (fovs, why) => {
    const f = fovs.map((fov, i) => (cams_info[i].hfov_known && cams_info[i].hfov_deg) ? cams_info[i].hfov_deg : fov);
    if (!hyps.some(h => h.fovs.every((x, i) => Math.abs(x - f[i]) < 1))) hyps.push({ fovs: f, why });
  };
  add_hyp(cams_info.map(c => c.hfov_deg || 60), 'given');
  if (!all_known) {
    if (options.search_fov !== false) {
      const g = fov_grid_guess(matches, cams_info, N);
      if (g) add_hyp(g, 'grid');
    }
    for (const fov of [50, 65, 80]) add_hyp(cams_info.map(() => fov), 'uniform ' + fov);
  }

  let best = null;
  for (const h of hyps) {
    let r;
    try { r = solve_rig(samples, cams_info, matches, h.fovs, min_vis, () => {}); }
    catch (e) { log(`fov guess ${h.fovs.join('/')}: failed (${e.message})`); continue; }
    log(`fov guess ${h.fovs.map(x => x.toFixed(0)).join('/')} (${h.why}): rms ${r.ba.rms.toFixed(2)} px, score ${r.score.toFixed(3)}`);
    if (!best || r.score < best.score) best = r;
  }
  if (!best) throw new Error('Calibration failed: no camera overlaps enough with camera 1 (keep your whole body visible to at least 2 cameras)');

  // rerun the winner with logging so the user sees the details
  const { cams, ba } = solve_rig(samples, cams_info, matches, best.fovs, min_vis, log);
  log('fields of view: ' + cams.map((c, i) => `cam${i} ${(2 * Math.atan(c.width / 2 / c.f) * 180 / Math.PI).toFixed(1)} deg`).join(', '));

  // 5. metric scale
  const frames3d = rebuild_frames(samples, cams, Math.min(min_vis, 0.5));
  const scale = metric_scale(frames3d, samples, options.user_height_m);
  G.transform_rig(cams, scale.s, [1,0,0, 0,1,0, 0,0,1], [0,0,0]);
  frames3d.forEach(f => f && f.forEach((X, j) => { if (X) f[j] = G.v_scale(X, scale.s); }));
  log(`metric scale from ${scale.source} (${scale.n} bone samples)`);

  // 6. level the world: Y up, floor at Y = 0, Z towards camera 1, origin under the user
  const world = level_world(cams, frames3d);
  G.transform_rig(cams, 1, world.Q, world.d);
  log(`world levelled (up from ${world.up_source}), camera 1 is ${world.cam0_dist.toFixed(2)} m from the play area`);

  return {
    version: 1,
    created: new Date().toISOString(),
    rms_px: ba.rms,
    cameras: cams.map((c, i) => ({
      index: i,
      solved: c.solved,
      width: c.width, height: c.height,
      f: c.f,
      hfov_deg: 2 * Math.atan(c.width / 2 / c.f) * 180 / Math.PI,
      R: c.R, t: c.t,
      center: G.camera_center(c),
    })),
  };
}

// Inlier-count grid over fields of view (a cheap first guess).
function fov_grid_guess(matches, cams_info, N) {
  const fovs = [];
  for (let fov = 40; fov <= 100; fov += 5) fovs.push(fov);
  const score = [];
  for (let i = 1; i < N; i++) {
    const { m1, m2 } = matches[i];
    score[i] = null;
    if (m1.length < 30) continue;
    const step = Math.max(1, Math.floor(m1.length / 500));
    const s1 = m1.filter((_, k) => k % step === 0), s2 = m2.filter((_, k) => k % step === 0);
    score[i] = fovs.map(fa => {
      const f0 = G.default_focal(cams_info[0].width, fa);
      return fovs.map(fb => {
        const fi = G.default_focal(cams_info[i].width, fb);
        const rp = G.estimate_relative_pose(
          s1.map(p => [p[0] / f0, p[1] / f0]), s2.map(p => [p[0] / fi, p[1] / fi]),
          { threshold: 4 / Math.sqrt(f0 * fi), iterations: 120, seed: 99 }
        );
        return rp ? rp.inliers.length : 0;
      });
    });
  }
  let best_a = -1, best_total = 0;
  fovs.forEach((_, a) => {
    let tot = 0;
    for (let i = 1; i < N; i++) if (score[i]) tot += Math.max(...score[i][a]);
    if (tot > best_total) { best_total = tot; best_a = a; }
  });
  if (best_a < 0) return null;
  return cams_info.map((_, i) => {
    if (i === 0) return fovs[best_a];
    if (!score[i]) return 60;
    const row = score[i][best_a];
    return fovs[row.indexOf(Math.max(...row))];
  });
}

// Steps 1-4 for one field-of-view guess: relative poses, PnP, bundle adjustment.
function solve_rig(samples, cams_info, matches, fovs, min_vis, log) {
  const N = cams_info.length;
  const cams = cams_info.map((ci, i) => ({
    R: [1,0,0, 0,1,0, 0,0,1], t: [0,0,0],
    f: G.default_focal(ci.width, fovs[i]),
    fixed_f: !!(ci.hfov_known && ci.hfov_deg),
    width: ci.width, height: ci.height,
    solved: i === 0,
  }));

  // 1. relative pose of every camera against camera 0
  const pair = [];
  for (let i = 1; i < N; i++) {
    const { m1, m2 } = matches[i];
    const x1 = m1.map(p => [p[0] / cams[0].f, p[1] / cams[0].f]);
    const x2 = m2.map(p => [p[0] / cams[i].f, p[1] / cams[i].f]);
    const rp = (x1.length >= 30) ? G.estimate_relative_pose(x1, x2, { threshold: 6 / Math.sqrt(cams[0].f * cams[i].f), iterations: 600 }) : null;
    pair[i] = rp ? { ...rp, n: x1.length } : null;
    log(`cam0-cam${i}: ${x1.length} matches, ` + (rp ? `${(rp.inlier_ratio*100).toFixed(0)}% inliers` : 'not enough overlap'));
  }

  // base pair: most inliers with camera 0
  let base = -1;
  for (let i = 1; i < N; i++) {
    if (pair[i] && (base < 0 || pair[i].inliers.length > pair[base].inliers.length)) base = i;
  }
  if (base < 0) throw new Error('no overlap with camera 1');

  cams[base].R = pair[base].R;
  cams[base].t = pair[base].t;
  cams[base].solved = true;

  // 2. triangulate (frame, joint) points from solved cameras
  const pts = new Map(); // key -> [X,Y,Z]
  function triangulate_all() {
    pts.clear();
    samples.forEach((s, si) => {
      for (const j of CALIB_JOINTS) {
        const views = [];
        s.views.forEach((v, ci) => {
          if (!v || !cams[ci].solved || v.lm[j].vis < min_vis) return;
          views.push({ cam: cams[ci], u: v.lm[j].u, v: v.lm[j].v, w: v.lm[j].vis });
        });
        if (views.length < 2) continue;
        const X = G.triangulate(views);
        if (!X) continue;
        // in front of every camera that saw it, reasonable reprojection
        if (views.some(vw => G.cam_to_local(vw.cam, X)[2] <= 0)) continue;
        if (G.reproj_error(views, X) > 25) continue;
        pts.set(si * 33 + j, X);
      }
    });
  }
  triangulate_all();

  // 3. remaining cameras by PnP against the triangulated points
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 1; i < N; i++) {
      if (cams[i].solved) continue;
      const p3 = [], p2 = [];
      samples.forEach((s, si) => {
        const v = s.views[i];
        if (!v) return;
        for (const j of CALIB_JOINTS) {
          const X = pts.get(si * 33 + j);
          if (!X || v.lm[j].vis < min_vis) continue;
          p3.push(X);
          p2.push([v.lm[j].u / cams[i].f, v.lm[j].v / cams[i].f]);
        }
      });
      if (p3.length < 30) continue;
      const pose = pnp_ransac(p3, p2, 8 / cams[i].f);
      if (!pose) continue;
      cams[i].R = pose.R;
      cams[i].t = pose.t;
      cams[i].solved = true;
      progress = true;
      log(`cam${i}: placed by PnP (${pose.inliers}/${p3.length} inliers)`);
      triangulate_all();
    }
  }

  // 4. bundle adjustment on everything
  const unsolved = cams.map((c, i) => c.solved ? -1 : i).filter(i => i >= 0);
  if (unsolved.length) log(`cameras not placed: ${unsolved.map(i => 'cam' + i).join(', ')}`);

  let ba = run_ba(samples, cams, pts, min_vis, base, null);
  log(`bundle adjustment: rms ${ba.rms.toFixed(2)} px`);
  triangulate_all();
  // drop outliers and refine once more
  ba = run_ba(samples, cams, pts, min_vis, base, Math.max(3 * ba.rms, 6));
  log(`bundle adjustment (outliers removed): rms ${ba.rms.toFixed(2)} px, ${ba.n_obs} observations`);

  return { cams, ba, fovs, score: evaluate_rig(samples, cams, min_vis) };
}

// How well a rig explains ALL the data (same robust cost as the bundle adjustment,
// per term), so rigs from different guesses can be compared fairly.
function evaluate_rig(samples, cams, min_vis) {
  const huber = 4, bone_k = 40;
  let cost = 0, n = 0;
  const lengths = RIGID_BONES.map(() => []);
  const per_frame = [];
  samples.forEach((s) => {
    const X = {};
    for (const j of CALIB_JOINTS) {
      const views = [];
      s.views.forEach((v, ci) => {
        if (!v || !cams[ci].solved || v.lm[j].vis < min_vis) return;
        views.push({ cam: cams[ci], u: v.lm[j].u, v: v.lm[j].v, w: v.lm[j].vis });
      });
      if (views.length < 2) continue;
      const P = G.triangulate(views);
      if (!P) continue;
      for (const vw of views) {
        const pr = G.project(vw.cam, P);
        const e = (pr[2] <= 0) ? 100 : Math.hypot(pr[0] - vw.u, pr[1] - vw.v);
        cost += vw.w * ((e <= huber) ? e*e : 2*huber*e - huber*huber);
        n++;
      }
      X[j] = P;
    }
    const L = RIGID_BONES.map(([a, b], bi) => {
      if (!X[a] || !X[b]) return null;
      const l = G.v_len(G.v_sub(X[a], X[b]));
      lengths[bi].push(l);
      return l;
    });
    per_frame.push(L);
  });
  const med = lengths.map(a => median(a));
  for (const L of per_frame) {
    L.forEach((l, bi) => {
      if (l == null || !(med[bi] > 0)) return;
      const r = bone_k * (l / med[bi] - 1);
      cost += r*r;
      n++;
    });
  }
  return n ? cost / n : Infinity;
}

function pnp_ransac(p3, p2, th) {
  const n = p3.length;
  const rand = G.seeded_random(777);
  let best = null, best_n = 0;
  for (let it = 0; it < 300; it++) {
    const s = new Set();
    while (s.size < 6) s.add(Math.floor(rand() * n));
    const idx = [...s];
    const pose = G.pnp_dlt(idx.map(i => p3[i]), idx.map(i => p2[i]));
    if (!pose) continue;
    const cam = { R: pose.R, t: pose.t, f: 1 };
    let k = 0;
    for (let i = 0; i < n; i++) {
      const pr = G.project(cam, p3[i]);
      if (pr[2] > 0 && Math.hypot(pr[0] - p2[i][0], pr[1] - p2[i][1]) < th) k++;
    }
    if (k > best_n) { best_n = k; best = pose; }
  }
  if (!best || best_n < 12) return null;
  // refit on inliers
  const cam = { R: best.R, t: best.t, f: 1 };
  const a3 = [], a2 = [];
  for (let i = 0; i < n; i++) {
    const pr = G.project(cam, p3[i]);
    if (pr[2] > 0 && Math.hypot(pr[0] - p2[i][0], pr[1] - p2[i][1]) < th) { a3.push(p3[i]); a2.push(p2[i]); }
  }
  const pose = G.pnp_dlt(a3, a2) || best;
  return { ...pose, inliers: best_n };
}


function run_ba(samples, cams, pts, min_vis, base, max_err) {
  // one group per frame, subsampled to keep BA quick
  let frames = [...new Set([...pts.keys()].map(k => Math.floor(k / 33)))].sort((a, b) => a - b);
  const max_frames = 250;
  if (frames.length > max_frames) {
    const step = frames.length / max_frames;
    frames = Array.from({ length: max_frames }, (_, i) => frames[Math.floor(i * step)]);
  }

  const points = [], groups = [], links = [], obs = [];
  for (const si of frames) {
    const g = [], idx = {};
    for (const j of CALIB_JOINTS) {
      const X = pts.get(si * 33 + j);
      if (!X) continue;
      const p = points.length;
      points.push(X.slice());
      g.push(p);
      idx[j] = p;
      samples[si].views.forEach((v, ci) => {
        if (!v || !cams[ci].solved || v.lm[j].vis < min_vis) return;
        if (max_err != null) {
          const pr = G.project(cams[ci], X);
          if (pr[2] <= 0 || Math.hypot(pr[0] - v.lm[j].u, pr[1] - v.lm[j].v) > max_err) return;
        }
        obs.push({ c: ci, p, u: v.lm[j].u, v: v.lm[j].v, w: v.lm[j].vis });
      });
    }
    RIGID_BONES.forEach(([a, b], bi) => {
      if (idx[a] != null && idx[b] != null) links.push({ p: idx[a], q: idx[b], b: bi });
    });
    if (g.length) groups.push(g);
  }

  const ba_cams = cams.map((c, i) => ({ R: c.R, t: c.t, f: c.f, fixed_pose: (i === 0) || !c.solved, fixed_f: !c.solved }));
  const r = G.bundle_adjust(ba_cams, points, obs, {
    iterations: 60, fix_scale_cam: base,
    groups, links, n_bones: RIGID_BONES.length, bone_k: 40,
  });
  ba_cams.forEach((c, i) => { if (cams[i].solved) { cams[i].R = c.R; cams[i].t = c.t; cams[i].f = c.f; } });
  return { ...r, n_obs: obs.length };
}

// all 33 joints per sample, triangulated with the calibrated rig
function rebuild_frames(samples, cams, min_vis) {
  return samples.map(s => {
    const out = new Array(33).fill(null);
    for (let j = 0; j < 33; j++) {
      const views = [];
      s.views.forEach((v, ci) => {
        if (!v || !cams[ci].solved || v.lm[j].vis < min_vis) return;
        views.push({ cam: cams[ci], u: v.lm[j].u, v: v.lm[j].v, w: v.lm[j].vis });
      });
      if (views.length < 2) continue;
      const X = G.triangulate(views);
      if (X && G.reproj_error(views, X) < 15) out[j] = X;
    }
    return out;
  });
}

function metric_scale(frames3d, samples, user_height_m) {
  const ratios = [];
  // reference bone lengths: from the user's height, or from MediaPipe's own metric world landmarks
  const ref = {};
  if (user_height_m) {
    for (const k in BONE_FRACTION) ref[k] = BONE_FRACTION[k] * user_height_m;
  }
  else {
    for (const [a, b] of SCALE_BONES) {
      const L = [];
      for (const s of samples) for (const v of s.views) {
        if (!v || !v.wl || v.lm[a].vis < 0.8 || v.lm[b].vis < 0.8) continue;
        const A = v.wl[a], B = v.wl[b];
        L.push(Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z));
      }
      if (L.length) ref[a + '-' + b] = median(L);
    }
  }
  for (const f of frames3d) {
    if (!f) continue;
    for (const [a, b] of SCALE_BONES) {
      const r = ref[a + '-' + b];
      if (!r || !f[a] || !f[b]) continue;
      const L = G.v_len(G.v_sub(f[a], f[b]));
      if (L > 0) ratios.push(r / L);
    }
  }
  if (!ratios.length) return { s: 1, n: 0, source: 'none (no bones seen)' };
  return { s: median(ratios), n: ratios.length, source: user_height_m ? `height ${user_height_m} m` : 'MediaPipe bone lengths' };
}

function level_world(cams, frames3d) {
  // up: median spine direction (mid-hip -> mid-shoulder)
  const spines = [];
  for (const f of frames3d) {
    if (!f || !f[11] || !f[12] || !f[23] || !f[24]) continue;
    const sh = G.v_scale(G.v_add(f[11], f[12]), 0.5);
    const hp = G.v_scale(G.v_add(f[23], f[24]), 0.5);
    spines.push(G.v_norm(G.v_sub(sh, hp)));
  }
  let up, up_source;
  if (spines.length >= 10) {
    up = G.v_norm([median(spines.map(v => v[0])), median(spines.map(v => v[1])), median(spines.map(v => v[2]))]);
    up_source = 'body';
  }
  else {
    // fall back to the cameras' own "up" (-y) direction
    let a = [0,0,0];
    for (const c of cams) if (c.solved) a = G.v_add(a, G.m3_v(G.m3_T(c.R), [0,-1,0]));
    up = G.v_norm(a);
    up_source = 'cameras';
  }

  // floor: low percentile of the foot points along "up"
  const foot = [];
  const hips = [];
  for (const f of frames3d) {
    if (!f) continue;
    for (const j of [29, 30, 31, 32]) if (f[j]) foot.push(G.v_dot(f[j], up));
    if (f[23] && f[24]) hips.push(G.v_scale(G.v_add(f[23], f[24]), 0.5));
  }
  const floor_h = foot.length ? percentile(foot, 0.05) : (hips.length ? median(hips.map(h => G.v_dot(h, up))) - 0.9 : 0);

  // play-area centre: median hip position projected to the floor
  let c = [0,0,0];
  if (hips.length) c = [median(hips.map(h => h[0])), median(hips.map(h => h[1])), median(hips.map(h => h[2]))];
  c = G.v_add(c, G.v_scale(up, floor_h - G.v_dot(c, up)));

  // forward (+Z): from the play area towards camera 1, flattened onto the floor
  const c0 = G.camera_center(cams[0]);
  let fwd = G.v_sub(c0, c);
  fwd = G.v_sub(fwd, G.v_scale(up, G.v_dot(fwd, up)));
  const cam0_dist = G.v_len(fwd);
  fwd = G.v_norm(fwd);
  const right = G.v_norm(G.v_cross(up, fwd)); // X = Y x Z

  // rows of Q are the new axes expressed in old coordinates
  const Q = [right[0], right[1], right[2], up[0], up[1], up[2], fwd[0], fwd[1], fwd[2]];
  const d = G.v_scale(G.m3_v(Q, c), -1);
  return { Q, d, up_source, cam0_dist };
}

const API = { calibrate, CALIB_JOINTS, SCALE_BONES };

if (typeof module === 'object' && module.exports) module.exports = API;
else root.MC_calibrate = API;

})(typeof self !== 'undefined' ? self : this);
