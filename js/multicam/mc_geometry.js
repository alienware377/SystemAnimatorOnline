// Multi-camera geometry for XR Animator
// Calibration (self-calibration from body keypoints) and triangulation.
//
// Conventions
// - Camera frame: x right, y down, z forward (OpenCV style).
// - World -> camera: Xc = R * Xw + t. R is a row-major 3x3 array of 9 numbers.
// - Image points are in "centered pixels": u = (x_norm - 0.5) * width, v = (y_norm - 0.5) * height.
//   Principal point is assumed at the image center, square pixels, no lens distortion.
// - Camera model: u = f * Xc.x / Xc.z, v = f * Xc.y / Xc.z

(function (root) {

'use strict';

// ---------- small linear algebra ----------

function m3_mul(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i*3+j] = A[i*3]*B[j] + A[i*3+1]*B[3+j] + A[i*3+2]*B[6+j];
    }
  }
  return C;
}

function m3_T(A) {
  return [A[0],A[3],A[6], A[1],A[4],A[7], A[2],A[5],A[8]];
}

function m3_v(A, v) {
  return [
    A[0]*v[0] + A[1]*v[1] + A[2]*v[2],
    A[3]*v[0] + A[4]*v[1] + A[5]*v[2],
    A[6]*v[0] + A[7]*v[1] + A[8]*v[2],
  ];
}

function m3_det(A) {
  return A[0]*(A[4]*A[8]-A[5]*A[7]) - A[1]*(A[3]*A[8]-A[5]*A[6]) + A[2]*(A[3]*A[7]-A[4]*A[6]);
}

function v_add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function v_sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function v_scale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function v_dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function v_cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function v_len(a) { return Math.sqrt(v_dot(a, a)); }
function v_norm(a) { const l = v_len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

// Symmetric eigen decomposition (cyclic Jacobi). A is n x n, flat row-major.
// Returns { values, vectors } with vectors[k] = k-th eigenvector, sorted by ascending value.
function eig_sym(A_in, n) {
  const A = A_in.slice();
  const V = new Array(n*n).fill(0);
  for (let i = 0; i < n; i++) V[i*n+i] = 1;

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p+1; q < n; q++) off += A[p*n+q]*A[p*n+q];
    if (off < 1e-30) break;

    for (let p = 0; p < n; p++) {
      for (let q = p+1; q < n; q++) {
        const apq = A[p*n+q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = A[p*n+p], aqq = A[q*n+q];
        const theta = (aqq - app) / (2*apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
        const c = 1 / Math.sqrt(t*t + 1), s = t*c;

        for (let k = 0; k < n; k++) {
          const akp = A[k*n+p], akq = A[k*n+q];
          A[k*n+p] = c*akp - s*akq;
          A[k*n+q] = s*akp + c*akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p*n+k], aqk = A[q*n+k];
          A[p*n+k] = c*apk - s*aqk;
          A[q*n+k] = s*apk + c*aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k*n+p], vkq = V[k*n+q];
          V[k*n+p] = c*vkp - s*vkq;
          V[k*n+q] = s*vkp + c*vkq;
        }
      }
    }
  }

  const idx = [...Array(n).keys()].sort((a, b) => A[a*n+a] - A[b*n+b]);
  return {
    values: idx.map(i => A[i*n+i]),
    vectors: idx.map(i => { const v = new Array(n); for (let k = 0; k < n; k++) v[k] = V[k*n+i]; return v; }),
  };
}

// Solve A x = b (n x n dense), Gaussian elimination with partial pivoting.
function solve(A_in, b_in, n) {
  const A = A_in.slice(), b = b_in.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c+1; r < n; r++) if (Math.abs(A[r*n+c]) > Math.abs(A[piv*n+c])) piv = r;
    if (Math.abs(A[piv*n+c]) < 1e-300) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c*n+k]; A[c*n+k] = A[piv*n+k]; A[piv*n+k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    for (let r = c+1; r < n; r++) {
      const f = A[r*n+c] / A[c*n+c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r*n+k] -= f*A[c*n+k];
      b[r] -= f*b[c];
    }
  }
  const x = new Array(n);
  for (let r = n-1; r >= 0; r--) {
    let s = b[r];
    for (let k = r+1; k < n; k++) s -= A[r*n+k]*x[k];
    x[r] = s / A[r*n+r];
  }
  return x;
}

function inv3(A) {
  const d = m3_det(A);
  if (Math.abs(d) < 1e-300) return null;
  const id = 1/d;
  return [
    (A[4]*A[8]-A[5]*A[7])*id, (A[2]*A[7]-A[1]*A[8])*id, (A[1]*A[5]-A[2]*A[4])*id,
    (A[5]*A[6]-A[3]*A[8])*id, (A[0]*A[8]-A[2]*A[6])*id, (A[2]*A[3]-A[0]*A[5])*id,
    (A[3]*A[7]-A[4]*A[6])*id, (A[1]*A[6]-A[0]*A[7])*id, (A[0]*A[4]-A[1]*A[3])*id,
  ];
}

// 3x3 SVD via eigen decomposition of M^T M. Returns U, S (desc), V with det(U) = det(V) = +1.
function svd3(M) {
  const MtM = m3_mul(m3_T(M), M);
  const e = eig_sym(MtM, 3);
  const vs = [e.vectors[2], e.vectors[1], e.vectors[0]];
  const S = [e.values[2], e.values[1], e.values[0]].map(x => Math.sqrt(Math.max(x, 0)));

  let v3 = v_cross(vs[0], vs[1]);
  const V = [vs[0][0],vs[1][0],v3[0], vs[0][1],vs[1][1],v3[1], vs[0][2],vs[1][2],v3[2]];

  const u1 = v_norm(m3_v(M, vs[0]));
  let u2 = m3_v(M, vs[1]);
  u2 = v_norm(v_sub(u2, v_scale(u1, v_dot(u1, u2))));
  if (!(v_len(u2) > 0.5)) {
    // degenerate second singular value: pick any orthogonal direction
    u2 = v_norm(v_cross(u1, Math.abs(u1[0]) < 0.9 ? [1,0,0] : [0,1,0]));
  }
  const u3 = v_cross(u1, u2);
  const U = [u1[0],u2[0],u3[0], u1[1],u2[1],u3[1], u1[2],u2[2],u3[2]];

  // M v3 has the sign of S[2] folded in; fix the third singular value's sign.
  const mv3 = m3_v(M, v3);
  if (v_dot(mv3, u3) < 0) S[2] = -S[2];

  return { U, S, V };
}

// Closest rotation to M.
function orthonormalize(M) {
  const { U, V } = svd3(M);
  let R = m3_mul(U, m3_T(V));
  if (m3_det(R) < 0) {
    const U2 = U.slice(); U2[2] = -U2[2]; U2[5] = -U2[5]; U2[8] = -U2[8];
    R = m3_mul(U2, m3_T(V));
  }
  return R;
}

// Rodrigues vector <-> rotation matrix
function rodrigues(r) {
  const th = Math.sqrt(r[0]*r[0] + r[1]*r[1] + r[2]*r[2]);
  if (th < 1e-12) {
    return [1,-r[2],r[1], r[2],1,-r[0], -r[1],r[0],1];
  }
  const k = [r[0]/th, r[1]/th, r[2]/th];
  const c = Math.cos(th), s = Math.sin(th), C = 1-c;
  return [
    c + k[0]*k[0]*C,      k[0]*k[1]*C - k[2]*s, k[0]*k[2]*C + k[1]*s,
    k[1]*k[0]*C + k[2]*s, c + k[1]*k[1]*C,      k[1]*k[2]*C - k[0]*s,
    k[2]*k[0]*C - k[1]*s, k[2]*k[1]*C + k[0]*s, c + k[2]*k[2]*C,
  ];
}

function rodrigues_inv(R) {
  const tr = R[0] + R[4] + R[8];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [ (R[7]-R[5])/2, (R[2]-R[6])/2, (R[3]-R[1])/2 ];
  if (Math.PI - th < 1e-6) {
    // near 180 degrees: axis from the largest diagonal of (R + I)/2
    const xx = (R[0]+1)/2, yy = (R[4]+1)/2, zz = (R[8]+1)/2;
    let k;
    if (xx >= yy && xx >= zz) { const x = Math.sqrt(xx); k = [x, (R[1]+R[3])/(4*x), (R[2]+R[6])/(4*x)]; }
    else if (yy >= zz) { const y = Math.sqrt(yy); k = [(R[1]+R[3])/(4*y), y, (R[5]+R[7])/(4*y)]; }
    else { const z = Math.sqrt(zz); k = [(R[2]+R[6])/(4*z), (R[5]+R[7])/(4*z), z]; }
    k = v_norm(k);
    return v_scale(k, th);
  }
  const s = th / (2*Math.sin(th));
  return [ (R[7]-R[5])*s, (R[2]-R[6])*s, (R[3]-R[1])*s ];
}

// ---------- camera helpers ----------

function cam_to_local(cam, X) {
  return v_add(m3_v(cam.R, X), cam.t);
}

function project(cam, X) {
  const p = cam_to_local(cam, X);
  return [cam.f * p[0] / p[2], cam.f * p[1] / p[2], p[2]];
}

function camera_center(cam) {
  return v_scale(m3_v(m3_T(cam.R), cam.t), -1);
}

function default_focal(width, hfov_deg) {
  return (width / 2) / Math.tan((hfov_deg || 60) * Math.PI / 360);
}

// ---------- triangulation ----------

// views: [{ cam, u, v, w }]. Linear least squares with X4 = 1, then a few Gauss-Newton steps.
function triangulate(views, refine_steps) {
  if (views.length < 2) return null;

  const N = new Array(9).fill(0), b = [0,0,0];
  for (const { cam, u, v, w } of views) {
    const R = cam.R, t = cam.t;
    const x = u / cam.f, y = v / cam.f;
    // rows: x*(R3.X + t3) - (R1.X + t1) = 0, y*(R3.X + t3) - (R2.X + t2) = 0
    const rows = [
      [x*R[6]-R[0], x*R[7]-R[1], x*R[8]-R[2], t[0]-x*t[2]],
      [y*R[6]-R[3], y*R[7]-R[4], y*R[8]-R[5], t[1]-y*t[2]],
    ];
    const ww = (w == null) ? 1 : w;
    for (const r of rows) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) N[i*3+j] += ww*r[i]*r[j];
        b[i] += ww*r[i]*r[3];
      }
    }
  }
  const Ni = inv3(N);
  if (!Ni) return null;
  let X = m3_v(Ni, b);

  for (let it = 0; it < (refine_steps == null ? 3 : refine_steps); it++) {
    const H = new Array(9).fill(0), g = [0,0,0];
    for (const { cam, u, v, w } of views) {
      const p = cam_to_local(cam, X);
      if (p[2] <= 1e-9) continue;
      const iz = 1/p[2];
      const ru = cam.f*p[0]*iz - u, rv = cam.f*p[1]*iz - v;
      // d(proj)/d(p) * R
      const R = cam.R, f = cam.f;
      const ju = [0,1,2].map(k => f*iz*(R[k] - p[0]*iz*R[6+k]));
      const jv = [0,1,2].map(k => f*iz*(R[3+k] - p[1]*iz*R[6+k]));
      const ww = (w == null) ? 1 : w;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) H[i*3+j] += ww*(ju[i]*ju[j] + jv[i]*jv[j]);
        g[i] += ww*(ju[i]*ru + jv[i]*rv);
      }
    }
    const Hi = inv3(H);
    if (!Hi) break;
    const dx = m3_v(Hi, g);
    X = v_sub(X, dx);
    if (v_len(dx) < 1e-9) break;
  }
  return X;
}

// Mean reprojection error (pixels) of X over views.
function reproj_error(views, X) {
  let s = 0, n = 0;
  for (const { cam, u, v } of views) {
    const p = project(cam, X);
    if (p[2] <= 0) return Infinity;
    s += Math.hypot(p[0]-u, p[1]-v);
    n++;
  }
  return n ? s/n : Infinity;
}

// ---------- essential matrix ----------

function seeded_random(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// x1, x2: arrays of [x, y] normalized (u/f, v/f). Returns E (row-major 9).
function essential_8pt(x1, x2, idx) {
  const A = new Array(81).fill(0);
  for (const i of idx) {
    const [a, b] = x1[i], [c, d] = x2[i];
    const r = [c*a, c*b, c, d*a, d*b, d, a, b, 1];
    for (let p = 0; p < 9; p++) for (let q = 0; q < 9; q++) A[p*9+q] += r[p]*r[q];
  }
  const e = eig_sym(A, 9).vectors[0];
  const { U, V } = svd3(e);
  // enforce singular values (1, 1, 0)
  const D = [1,0,0, 0,1,0, 0,0,0];
  return m3_mul(m3_mul(U, D), m3_T(V));
}

function sampson(E, a, b) {
  const x1 = [a[0], a[1], 1], x2 = [b[0], b[1], 1];
  const Ex1 = m3_v(E, x1), Etx2 = m3_v(m3_T(E), x2);
  const num = v_dot(x2, Ex1);
  const den = Ex1[0]*Ex1[0] + Ex1[1]*Ex1[1] + Etx2[0]*Etx2[0] + Etx2[1]*Etx2[1];
  return num*num / (den || 1e-30);
}

// Four (R, t) candidates from E, picks the one with most points in front of both cameras.
function decompose_essential(E, x1, x2, inliers) {
  const { U, V } = svd3(E);
  const W = [0,-1,0, 1,0,0, 0,0,1];
  const Vt = m3_T(V);
  const Ra = m3_mul(m3_mul(U, W), Vt);
  const Rb = m3_mul(m3_mul(U, m3_T(W)), Vt);
  const u3 = [U[2], U[5], U[8]];
  const cands = [];
  for (let R of [Ra, Rb]) {
    if (m3_det(R) < 0) R = R.map(x => -x);
    cands.push({ R, t: u3 }, { R, t: v_scale(u3, -1) });
  }

  const cam0 = { R: [1,0,0, 0,1,0, 0,0,1], t: [0,0,0], f: 1 };
  let best = null, best_n = -1;
  for (const c of cands) {
    const cam1 = { R: c.R, t: c.t, f: 1 };
    let n = 0;
    for (const i of inliers) {
      const X = triangulate([
        { cam: cam0, u: x1[i][0], v: x1[i][1] },
        { cam: cam1, u: x2[i][0], v: x2[i][1] },
      ], 0);
      if (!X) continue;
      if (X[2] > 0 && cam_to_local(cam1, X)[2] > 0) n++;
    }
    if (n > best_n) { best_n = n; best = c; }
  }
  return { R: best.R, t: best.t, n_front: best_n };
}

// RANSAC essential matrix. threshold is in normalized units (pixels / f).
function estimate_relative_pose(x1, x2, options = {}) {
  const n = x1.length;
  if (n < 8) return null;
  const iters = options.iterations || 400;
  const th2 = Math.pow(options.threshold || 0.005, 2);
  const rand = seeded_random(options.seed || 12345);

  let best_inl = [];
  for (let it = 0; it < iters; it++) {
    const s = new Set();
    while (s.size < 8) s.add(Math.floor(rand() * n));
    const E = essential_8pt(x1, x2, [...s]);
    const inl = [];
    for (let i = 0; i < n; i++) if (sampson(E, x1[i], x2[i]) < th2) inl.push(i);
    if (inl.length > best_inl.length) best_inl = inl;
  }
  if (best_inl.length < 8) return null;

  // refit on all inliers, then re-collect inliers
  let E = essential_8pt(x1, x2, best_inl);
  const inl = [];
  for (let i = 0; i < n; i++) if (sampson(E, x1[i], x2[i]) < th2) inl.push(i);
  if (inl.length >= 8) E = essential_8pt(x1, x2, inl);

  const pose = decompose_essential(E, x1, x2, inl);
  return { E, R: pose.R, t: pose.t, inliers: inl, inlier_ratio: inl.length / n };
}

// ---------- PnP (linear, then refined by bundle adjustment later) ----------

// pts3: [[X,Y,Z]], pts2: [[x,y]] normalized (u/f, v/f). Returns { R, t }.
function pnp_dlt(pts3, pts2) {
  const n = pts3.length;
  if (n < 6) return null;

  // condition the 3D points
  let c = [0,0,0];
  for (const p of pts3) c = v_add(c, p);
  c = v_scale(c, 1/n);
  let sc = 0;
  for (const p of pts3) sc += v_len(v_sub(p, c));
  sc = (sc / n) || 1;
  const P = pts3.map(p => v_scale(v_sub(p, c), 1/sc));

  const A = new Array(144).fill(0);
  const add = (r) => { for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) A[i*12+j] += r[i]*r[j]; };
  for (let i = 0; i < n; i++) {
    const [X, Y, Z] = P[i], [x, y] = pts2[i];
    add([X,Y,Z,1, 0,0,0,0, -x*X,-x*Y,-x*Z,-x]);
    add([0,0,0,0, X,Y,Z,1, -y*X,-y*Y,-y*Z,-y]);
  }
  const p = eig_sym(A, 12).vectors[0];
  let M = [p[0],p[1],p[2], p[4],p[5],p[6], p[8],p[9],p[10]];
  let tt = [p[3], p[7], p[11]];

  const { S } = svd3(M);
  let s = (Math.abs(S[0]) + Math.abs(S[1]) + Math.abs(S[2])) / 3;
  if (m3_det(M) < 0) s = -s;
  M = M.map(x => x/s);
  tt = v_scale(tt, 1/s);
  const R = orthonormalize(M);

  // undo conditioning: Xc = R*(X - c)/sc + tt  ->  t = tt*sc - R*c (after scaling by sc)
  const t = v_sub(v_scale(tt, sc), m3_v(R, c));
  return { R, t };
}

// ---------- bundle adjustment (sparse LM with Schur complement) ----------

// Solve A X = B for an n x n A and n x m B (both flat row-major). Returns X or null.
function solve_multi(A_in, B_in, n, m) {
  const A = A_in.slice(), B = B_in.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c+1; r < n; r++) if (Math.abs(A[r*n+c]) > Math.abs(A[piv*n+c])) piv = r;
    if (Math.abs(A[piv*n+c]) < 1e-300) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c*n+k]; A[c*n+k] = A[piv*n+k]; A[piv*n+k] = t; }
      for (let k = 0; k < m; k++) { const t = B[c*m+k]; B[c*m+k] = B[piv*m+k]; B[piv*m+k] = t; }
    }
    const d = A[c*n+c];
    for (let r = c+1; r < n; r++) {
      const f = A[r*n+c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r*n+k] -= f*A[c*n+k];
      for (let k = 0; k < m; k++) B[r*m+k] -= f*B[c*m+k];
    }
  }
  const X = new Array(n*m);
  for (let r = n-1; r >= 0; r--) {
    for (let k = 0; k < m; k++) {
      let s = B[r*m+k];
      for (let j = r+1; j < n; j++) s -= A[r*n+j]*X[j*m+k];
      X[r*m+k] = s / A[r*n+r];
    }
  }
  return X;
}

// cams:   [{ R, t, f, fixed_pose?: bool, fixed_f?: bool }]
// points: [[X,Y,Z]]
// obs:    [{ c, p, u, v, w }]
// options:
//   groups: [[point indices]] points solved together (e.g. one body frame); default: one point per group
//   links:  [{ p, q, b }] bone links inside a group; bone b's length is a shared unknown
//   n_bones, bone_k (pixels per 100% bone stretch), huber (px), iterations, fix_scale_cam
// Modifies cams and points in place. Returns { cost_initial, cost, iterations, rms, bones }.
function bundle_adjust(cams, points, obs, options = {}) {
  const max_it = options.iterations || 30;
  const huber = options.huber || 4;
  const fix_scale = options.fix_scale_cam;
  const links = options.links || [];
  const NB = options.n_bones || 0;
  const bone_k = options.bone_k || 40;

  const cam_par = cams.map(c => ({ r: rodrigues_inv(c.R), t: c.t.slice(), f: c.f }));
  const free = [];
  cams.forEach((c, ci) => {
    if (!c.fixed_pose) for (let k = 0; k < 6; k++) free.push([ci, k]);
    if (!c.fixed_f) free.push([ci, 6]);
  });
  const CC = free.length;
  const C = CC + NB;
  const cam_free_idx = cams.map(() => new Array(7).fill(-1));
  free.forEach(([ci, k], i) => { cam_free_idx[ci][k] = i; });

  // groups
  const groups = options.groups || points.map((_, i) => [i]);
  const p_group = new Array(points.length).fill(-1), p_off = new Array(points.length).fill(0);
  groups.forEach((g, gi) => g.forEach((p, k) => { p_group[p] = gi; p_off[p] = 3*k; }));
  const links_by_group = groups.map(() => []);
  for (const l of links) {
    if (p_group[l.p] !== p_group[l.q] || p_group[l.p] < 0) throw new Error('bone link across groups');
    links_by_group[p_group[l.p]].push(l);
  }

  // initial bone lengths: median of current lengths
  let bones = options.bones ? options.bones.slice() : new Array(NB).fill(1);
  if (!options.bones && NB) {
    const L = Array.from({ length: NB }, () => []);
    for (const l of links) L[l.b].push(v_len(v_sub(points[l.p], points[l.q])));
    bones = L.map(a => { if (!a.length) return 1; a.sort((x, y) => x - y); return a[a.length >> 1]; });
  }

  const scale_norm = (fix_scale != null) ? v_len(cam_par[fix_scale].t) : null;

  function proj_par(cp, X) {
    const R = rodrigues(cp.r);
    const p = v_add(m3_v(R, X), cp.t);
    return [cp.f*p[0]/p[2], cp.f*p[1]/p[2], p[2]];
  }
  function get_par(cp, k) { return (k < 3) ? cp.r[k] : (k < 6) ? cp.t[k-3] : cp.f; }
  function set_par(cp, k, v) { if (k < 3) cp.r[k] = v; else if (k < 6) cp.t[k-3] = v; else cp.f = v; }

  function cost_of(cps, pts, bns) {
    let s = 0;
    for (const o of obs) {
      const pr = proj_par(cps[o.c], pts[o.p]);
      if (pr[2] <= 1e-6) { s += 1e6; continue; }
      const e = Math.hypot(pr[0]-o.u, pr[1]-o.v);
      const w = (o.w == null) ? 1 : o.w;
      s += w * ((e <= huber) ? e*e : 2*huber*e - huber*huber);
    }
    for (const l of links) {
      const r = bone_k * (v_len(v_sub(pts[l.p], pts[l.q])) / bns[l.b] - 1);
      s += r*r;
    }
    return s;
  }

  let lambda = options.lambda || 1e-3;
  let cost = cost_of(cam_par, points, bones);
  const cost_initial = cost;
  let it;

  const obs_by_group = groups.map(() => []);
  obs.forEach(o => { if (p_group[o.p] >= 0) obs_by_group[p_group[o.p]].push(o); });

  for (it = 0; it < max_it; it++) {
    const U = new Array(C*C).fill(0), gc = new Array(C).fill(0);
    const Vg = groups.map(g => new Array(9*g.length*g.length).fill(0));
    const Wg = groups.map(g => new Array(C*3*g.length).fill(0));
    const gg = groups.map(g => new Array(3*g.length).fill(0));

    for (let gi = 0; gi < groups.length; gi++) {
      const d = 3*groups[gi].length;
      const V = Vg[gi], W = Wg[gi], g = gg[gi];

      for (const o of obs_by_group[gi]) {
        const cp = cam_par[o.c], X = points[o.p];
        const pr = proj_par(cp, X);
        if (pr[2] <= 1e-6) continue;
        const ru = pr[0]-o.u, rv = pr[1]-o.v;
        const e = Math.hypot(ru, rv);
        let w = (o.w == null) ? 1 : o.w;
        if (e > huber) w *= huber / e;

        const jc = [];
        for (let k = 0; k < 7; k++) {
          const fi = cam_free_idx[o.c][k];
          if (fi < 0) continue;
          const v0 = get_par(cp, k);
          const h = (k < 3) ? 1e-6 : (k < 6) ? 1e-6*Math.max(1, v_len(cp.t)) : 1e-4*cp.f;
          set_par(cp, k, v0 + h); const a = proj_par(cp, X);
          set_par(cp, k, v0 - h); const b = proj_par(cp, X);
          set_par(cp, k, v0);
          jc.push([fi, (a[0]-b[0])/(2*h), (a[1]-b[1])/(2*h)]);
        }
        const R = rodrigues(cp.r);
        const pc = v_add(m3_v(R, X), cp.t);
        const iz = 1/pc[2];
        const jpu = [0,1,2].map(k => cp.f*iz*(R[k] - pc[0]*iz*R[6+k]));
        const jpv = [0,1,2].map(k => cp.f*iz*(R[3+k] - pc[1]*iz*R[6+k]));
        const off = p_off[o.p];

        for (const [i, ui, vi] of jc) {
          for (const [j, uj, vj] of jc) U[i*C+j] += w*(ui*uj + vi*vj);
          gc[i] += w*(ui*ru + vi*rv);
          for (let k = 0; k < 3; k++) W[i*d + off+k] += w*(ui*jpu[k] + vi*jpv[k]);
        }
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) V[(off+a)*d + off+b] += w*(jpu[a]*jpu[b] + jpv[a]*jpv[b]);
          g[off+a] += w*(jpu[a]*ru + jpv[a]*rv);
        }
      }

      for (const l of links_by_group[gi]) {
        const D = v_sub(points[l.p], points[l.q]);
        const len = v_len(D) || 1e-12;
        const L = bones[l.b];
        const r = bone_k * (len / L - 1);
        const n = v_scale(D, 1/len);
        const jp = v_scale(n, bone_k / L);         // d r / d Xp ; d r / d Xq = -jp
        const jb = -bone_k * len / (L*L);          // d r / d L
        const bi = CC + l.b;
        const op = p_off[l.p], oq = p_off[l.q];
        U[bi*C+bi] += jb*jb;
        gc[bi] += jb*r;
        for (let a = 0; a < 3; a++) {
          W[bi*d + op+a] += jb*jp[a];
          W[bi*d + oq+a] -= jb*jp[a];
          g[op+a] += jp[a]*r;
          g[oq+a] -= jp[a]*r;
          for (let b = 0; b < 3; b++) {
            const v = jp[a]*jp[b];
            V[(op+a)*d + op+b] += v;
            V[(oq+a)*d + oq+b] += v;
            V[(op+a)*d + oq+b] -= v;
            V[(oq+a)*d + op+b] -= v;
          }
        }
      }
    }

    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const S = U.slice(), rhs = gc.map(x => -x);
      for (let i = 0; i < C; i++) S[i*C+i] += lambda * U[i*C+i] + 1e-12;

      const sol = []; // per group: { Y (d x C), y (d) }
      let failed = false;
      for (let gi = 0; gi < groups.length; gi++) {
        const d = 3*groups[gi].length;
        const V = Vg[gi].slice();
        for (let a = 0; a < d; a++) V[a*d+a] += lambda * V[a*d+a] + 1e-9;
        // right-hand sides: W^T (d x C) and g (d)
        const Bm = new Array(d*(C+1));
        const W = Wg[gi];
        for (let a = 0; a < d; a++) {
          for (let i = 0; i < C; i++) Bm[a*(C+1)+i] = W[i*d+a];
          Bm[a*(C+1)+C] = gg[gi][a];
        }
        const Xs = solve_multi(V, Bm, d, C+1);
        if (!Xs) { failed = true; break; }
        sol.push(Xs);
        // S -= W Y ; rhs += W y
        for (let i = 0; i < C; i++) {
          for (let a = 0; a < d; a++) {
            const wia = W[i*d+a];
            if (!wia) continue;
            for (let j = 0; j < C; j++) S[i*C+j] -= wia * Xs[a*(C+1)+j];
            rhs[i] += wia * Xs[a*(C+1)+C];
          }
        }
      }
      const dc = failed ? null : (C ? solve(S, rhs, C) : []);
      if (!dc) { lambda *= 10; continue; }

      const new_cam = cam_par.map(cp => ({ r: cp.r.slice(), t: cp.t.slice(), f: cp.f }));
      free.forEach(([ci, k], i) => set_par(new_cam[ci], k, get_par(new_cam[ci], k) + dc[i]));
      let new_bones = bones.map((L, b) => L + dc[CC + b]);
      const new_pts = points.map(X => X.slice());
      groups.forEach((g, gi) => {
        const Xs = sol[gi];
        g.forEach((p, k) => {
          for (let a = 0; a < 3; a++) {
            const row = (3*k + a) * (C+1);
            let s = -Xs[row + C];
            for (let i = 0; i < C; i++) s -= Xs[row + i] * dc[i];
            new_pts[p][a] += s;
          }
        });
      });

      if (scale_norm) {
        const s = scale_norm / (v_len(new_cam[fix_scale].t) || 1);
        new_cam.forEach(cp => { cp.t = v_scale(cp.t, s); });
        new_pts.forEach((X, i) => { new_pts[i] = v_scale(X, s); });
        new_bones = new_bones.map(L => L * s);
      }
      if (new_bones.some(L => !(L > 0)) || new_cam.some(cp => !(cp.f > 0))) { lambda *= 10; continue; }

      const new_cost = cost_of(new_cam, new_pts, new_bones);
      if (new_cost < cost) {
        const rel = (cost - new_cost) / cost;
        cam_par.forEach((cp, i) => { cp.r = new_cam[i].r; cp.t = new_cam[i].t; cp.f = new_cam[i].f; });
        new_pts.forEach((X, i) => { points[i] = X; });
        bones = new_bones;
        cost = new_cost;
        lambda = Math.max(lambda / 3, 1e-9);
        improved = true;
        if (rel < 1e-7) it = max_it;
        break;
      }
      lambda *= 5;
    }
    if (!improved) break;
  }

  cams.forEach((c, i) => {
    c.R = rodrigues(cam_par[i].r);
    c.t = cam_par[i].t;
    c.f = cam_par[i].f;
  });

  let se = 0;
  for (const o of obs) {
    const pr = project(cams[o.c], points[o.p]);
    se += (pr[0]-o.u)**2 + (pr[1]-o.v)**2;
  }
  return { cost_initial, cost, iterations: it, rms: Math.sqrt(se / Math.max(obs.length, 1)), bones };
}

// ---------- rigid / similarity transforms on a whole rig ----------

// Apply world transform Xw' = s * Q * Xw + d to every camera (Q rotation, row-major).
// Camera: Xc = R Xw + t = R (Q^T (Xw' - d) / s) + t  ->  R' = R Q^T, t' = t*s ... scaled form below.
function transform_rig(cams, s, Q, d) {
  const Qt = m3_T(Q);
  for (const c of cams) {
    const Rn = m3_mul(c.R, Qt);
    // Xc' = s * Xc (keep camera units consistent with new world scale)
    // s*Xc = s*R*Xw + s*t = R Q^T (Xw' - d) + s*t
    c.R = Rn;
    c.t = v_sub(v_scale(c.t, s), m3_v(Rn, d));
  }
}

const API = {
  m3_mul, m3_T, m3_v, m3_det, v_add, v_sub, v_scale, v_dot, v_cross, v_len, v_norm,
  eig_sym, solve, inv3, svd3, orthonormalize, rodrigues, rodrigues_inv,
  cam_to_local, project, camera_center, default_focal,
  triangulate, reproj_error,
  essential_8pt, sampson, decompose_essential, estimate_relative_pose,
  pnp_dlt, bundle_adjust, solve_multi, transform_rig, seeded_random,
};

if (typeof module === 'object' && module.exports) module.exports = API;
else root.MC_geometry = API;

})(typeof self !== 'undefined' ? self : this);
