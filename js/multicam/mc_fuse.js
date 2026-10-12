// Multi-camera runtime fusion: per-frame 3D body from N calibrated cameras.
//
// Each joint seen well by 2+ cameras is triangulated. Joints seen by only one
// camera fall back to that camera's MediaPipe world landmarks (hip-relative,
// metric), rotated into the shared world and attached to the triangulated hips.
// Joints nobody sees keep their last hip-relative position for a short time.
//
// view (per camera, or null): { lm: [{ u, v, vis } x33] centered pixels, wl: [{ x, y, z } x33] | null }

(function (root) {

'use strict';

const G = (typeof self !== 'undefined' && self.MC_geometry) || require('./mc_geometry.js');

function create(calibration, options = {}) {
  const cams = calibration.cameras.map(c => ({ R: c.R, t: c.t, f: c.f, width: c.width, height: c.height, solved: c.solved }));
  const n_joints = options.n_joints || 33;
  const min_vis = options.min_vis ?? 0.5;
  const mono_vis = options.mono_vis ?? 0.3;
  const hold_frames = options.hold_frames ?? 15;

  let last_hip = null;
  const last_rel = new Array(n_joints).fill(null);
  const last_age = new Array(n_joints).fill(Infinity);

  function gate_px(cam) { return Math.max(20, 0.03 * cam.width); }

  function tri_joint(views, j) {
    let vs = [];
    views.forEach((v, ci) => {
      if (!v || !cams[ci].solved) return;
      const l = v.lm[j];
      if (!l || l.vis < min_vis) return;
      vs.push({ cam: cams[ci], ci, u: l.u, v: l.v, w: l.vis });
    });
    while (vs.length >= 2) {
      const X = G.triangulate(vs);
      if (!X) return null;
      let worst = -1, worst_e = 0, bad = false;
      vs.forEach((vw, k) => {
        const p = G.project(vw.cam, X);
        const e = (p[2] <= 0) ? Infinity : Math.hypot(p[0] - vw.u, p[1] - vw.v) / gate_px(vw.cam);
        if (e > 1) bad = true;
        if (e > worst_e) { worst_e = e; worst = k; }
      });
      if (!bad) return { X, n: vs.length, score: vs.reduce((s, x) => s + x.w, 0) / vs.length };
      if (vs.length === 2) return null; // two views that disagree: can't tell which is right
      vs.splice(worst, 1);
    }
    return null;
  }

  function fuse(views) {
    const points = new Array(n_joints).fill(null);
    const score = new Array(n_joints).fill(0);
    const source = new Array(n_joints).fill('none');
    const n_views = new Array(n_joints).fill(0);

    for (let j = 0; j < n_joints; j++) {
      const r = tri_joint(views, j);
      if (r) { points[j] = r.X; score[j] = r.score; source[j] = 'tri'; n_views[j] = r.n; }
    }

    let hip = (points[23] && points[24]) ? G.v_scale(G.v_add(points[23], points[24]), 0.5) : null;

    // single-camera fallback, anchored at the hips
    const mono = new Array(n_joints).fill(null);
    let mono_hip = null;
    {
      // hip estimate from mono data if triangulation lost the hips: needs a previous hip
      for (let j = 0; j < n_joints; j++) {
        if (points[j]) continue;
        let acc = [0,0,0], wsum = 0;
        views.forEach((v, ci) => {
          if (!v || !v.wl || !cams[ci].solved) return;
          const l = v.lm[j];
          if (!l || l.vis < mono_vis) return;
          const h = G.v_scale(G.v_add([v.wl[23].x, v.wl[23].y, v.wl[23].z], [v.wl[24].x, v.wl[24].y, v.wl[24].z]), 0.5);
          const rel_cam = G.v_sub([v.wl[j].x, v.wl[j].y, v.wl[j].z], h);
          const rel_w = G.m3_v(G.m3_T(cams[ci].R), rel_cam);
          acc = G.v_add(acc, G.v_scale(rel_w, l.vis));
          wsum += l.vis;
        });
        if (wsum > 0) mono[j] = { rel: G.v_scale(acc, 1 / wsum), score: Math.min(0.6, wsum) };
      }
    }

    if (!hip) {
      hip = last_hip;
      if (!hip) return null;
      mono_hip = true;
    }

    for (let j = 0; j < n_joints; j++) {
      if (points[j]) {
        last_rel[j] = G.v_sub(points[j], hip);
        last_age[j] = 0;
        continue;
      }
      if (mono[j]) {
        points[j] = G.v_add(hip, mono[j].rel);
        score[j] = mono[j].score;
        source[j] = 'mono';
        last_rel[j] = mono[j].rel;
        last_age[j] = 0;
        continue;
      }
      if (last_rel[j] && last_age[j] < hold_frames) {
        points[j] = G.v_add(hip, last_rel[j]);
        score[j] = 0.1;
        source[j] = 'hold';
        last_age[j]++;
      }
    }

    last_hip = hip;
    return { points, score, source, n_views, hip, hip_held: !!mono_hip };
  }

  function reset() {
    last_hip = null;
    last_rel.fill(null);
    last_age.fill(Infinity);
  }

  return { fuse, reset, cams };
}

// MediaPipe normalized landmarks -> centered-pixel view for a camera
function to_view(landmarks, world_landmarks, cam) {
  if (!landmarks) return null;
  return {
    lm: landmarks.map(l => ({ u: (l.x - 0.5) * cam.width, v: (l.y - 0.5) * cam.height, vis: l.visibility ?? l.score ?? 1 })),
    wl: world_landmarks || null,
  };
}

// ---------- hands ----------
//
// hand view (per camera, per side 'L'/'R' = the person's own left/right):
//   { lm: [{ u, v, vis } x21] centered pixels, wl: [{ x, y, z } x21] | null (MediaPipe hand world landmarks, metres) }
// Points seen by 2+ cameras are triangulated. A hand seen well by only one camera
// uses that camera's hand world landmarks, rotated into the room and attached to
// the 3D wrist (from the body, or from the triangulated hand points).

const BODY_WRIST = { L: 15, R: 16 };

function create_hands(calibration, options = {}) {
  const cams = calibration.cameras.map(c => ({ R: c.R, t: c.t, f: c.f, width: c.width, height: c.height, solved: c.solved }));
  const min_vis = options.min_vis ?? 0.3;
  const min_tri = options.min_tri ?? 10;   // triangulated points needed to call a hand "3D"

  const gate_px = (cam) => Math.max(12, 0.015 * cam.width);

  function tri_point(views, j) {
    let vs = views.map(v => ({ cam: cams[v.ci], u: v.h.lm[j].u, v: v.h.lm[j].v, w: v.h.lm[j].vis }));
    while (vs.length >= 2) {
      const X = G.triangulate(vs);
      if (!X) return null;
      let worst = -1, worst_e = 0, bad = false;
      vs.forEach((vw, k) => {
        const p = G.project(vw.cam, X);
        const e = (p[2] <= 0) ? Infinity : Math.hypot(p[0] - vw.u, p[1] - vw.v) / gate_px(vw.cam);
        if (e > 1) bad = true;
        if (e > worst_e) { worst_e = e; worst = k; }
      });
      if (!bad) return X;
      if (vs.length == 2) return null;
      vs.splice(worst, 1);
    }
    return null;
  }

  // one camera's hand shape in room axes, relative to its own wrist (point 0)
  function mono_shape(v) {
    const R = cams[v.ci].R, wl = v.h.wl;
    const Rt = G.m3_T(R);
    const o = [wl[0].x, wl[0].y, wl[0].z];
    return wl.map(p => G.m3_v(Rt, G.v_sub([p.x, p.y, p.z], o)));
  }

  function fuse_side(views, side, body) {
    if (!views.length) return null;
    const points = new Array(21).fill(null);
    let n_tri = 0;
    if (views.length >= 2) {
      for (let j = 0; j < 21; j++) {
        const X = tri_point(views, j);
        if (X) { points[j] = X; n_tri++; }
      }
    }
    // best single view with a 3D shape, for gaps or a hand only one camera sees well
    const mono = views.filter(v => v.h.wl).sort((a, b) => b.score - a.score)[0];
    if (n_tri >= min_tri) {
      if (n_tri < 21 && mono) {
        const shape = mono_shape(mono);
        let off = [0, 0, 0], n = 0;
        points.forEach((X, j) => { if (X) { off = G.v_add(off, G.v_sub(X, shape[j])); n++; } });
        off = G.v_scale(off, 1 / n);
        points.forEach((X, j) => { if (!X) points[j] = G.v_add(shape[j], off); });
      }
      else if (n_tri < 21) return null;
      return { points, source: 'tri', n_tri, n_views: views.length };
    }
    if (!mono) return null;
    const wrist = body?.points?.[BODY_WRIST[side]];
    if (!wrist) return null;
    const shape = mono_shape(mono);
    return { points: shape.map(p => G.v_add(p, wrist)), source: 'mono', n_tri: 0, n_views: 1 };
  }

  // hand_views[ci] = { L, R } (either may be missing), body = MC_fuse result for the same frame
  function fuse(hand_views, body) {
    const out = {};
    for (const side of ['L', 'R']) {
      const views = [];
      hand_views.forEach((hv, ci) => {
        const h = hv?.[side];
        if (!h || !cams[ci]?.solved || !(h.score >= min_vis)) return;
        views.push({ ci, h, score: h.score });
      });
      out[side] = fuse_side(views, side, body);
    }
    return out;
  }

  return { fuse, cams };
}

const API = { create, create_hands, to_view };

// Electron pages with nodeIntegration have `module` too, so always set the global as well
if (typeof module === 'object' && module.exports) module.exports = API;
if (typeof self !== 'undefined') self.MC_fuse = API;

})(typeof self !== 'undefined' ? self : this);
