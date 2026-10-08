// Live view window for the multi-camera add-on (Ctrl+Shift+L, or "Live view" in the 3D panel)
//
// Tabs:
//  Cameras  every camera's picture with its tracked skeleton. Green = measured in 3D,
//           yellow = seen by one camera only, white crosses = where the 3D result
//           lands back in that camera (if they sit on the joints, calibration is good).
//  3D       the room: floor, cameras where calibration put them, live 3D skeleton.
//  Layout   top-down sketch of your room: drag the cameras to roughly where they are.
//           Used as a starting guess for Calibrate, or as a rough calibration by itself.
//  Face     live ARKit values, and blendshape matching with per-blendshape tuning.

(function () {

'use strict';

const MC = () => window.MC_multicam;
const FACE = () => window.MC_face;
const G = () => window.MC_geometry;

const EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],
  [28,30],[30,32],[28,32],[15,17],[15,19],[15,21],[16,18],[16,20],[16,22],[0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10]];
const COLOR = { tri: '#4ade80', mono: '#facc15', hold: '#fb923c', none: '#9ca3af', raw: '#38bdf8', proj: '#ffffff' };

let win = null, body = null, tabs = {}, active = 'cameras', visible = false;
let last_draw = 0;

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k == 'style') e.style.cssText = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (k in e) e[k] = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

// ---------- window ----------

function build() {
  document.head.appendChild(el('style', { textContent: `
#mcv{position:fixed;left:60px;top:40px;width:560px;height:480px;min-width:320px;min-height:260px;z-index:2147483001;resize:both;overflow:hidden;
 background:rgba(18,18,26,.96);color:#eee;font:12px/1.4 system-ui,sans-serif;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.55);display:none;flex-direction:column}
#mcv .mcv_head{display:flex;align-items:center;gap:4px;padding:6px 8px;cursor:move;background:#232336;border-radius:10px 10px 0 0;user-select:none}
#mcv .mcv_head b{flex:1;font-size:13px}
#mcv .mcv_tab{background:#33354d;color:#ccd;border:0;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
#mcv .mcv_tab.on{background:#5b5fc7;color:#fff}
#mcv .mcv_x{background:none;border:0;color:#aab;font-size:16px;cursor:pointer;padding:0 4px}
#mcv .mcv_body{flex:1;position:relative;overflow:auto}
#mcv .mcv_page{position:absolute;inset:0;overflow:auto;padding:8px;box-sizing:border-box}
#mcv canvas{display:block;touch-action:none}
#mcv button.b{background:#3a3f5c;color:#fff;border:0;border-radius:6px;padding:4px 8px;margin:2px 3px 2px 0;cursor:pointer;font:inherit}
#mcv button.b:hover{background:#4c5378}
#mcv input[type=number],#mcv input[type=text],#mcv select{background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:1px 4px;font:inherit}
#mcv input[type=number]{width:54px}
#mcv .small{color:#99a;font-size:11px}
#mcv .grid2{display:grid;grid-template-columns:1fr 1fr;gap:1px 12px}
#mcv .bar{position:relative;height:12px;background:#2a2a3a;border-radius:3px;overflow:hidden}
#mcv .bar i{position:absolute;left:0;top:0;bottom:0;background:#5b5fc7}
#mcv .bar s{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.18)}
#mcv .bar span{position:absolute;right:4px;top:-1px;font-size:10px;color:#fff;text-shadow:0 0 2px #000}
#mcv .ark{display:grid;grid-template-columns:118px 1fr;gap:4px;align-items:center;font-size:11px}
#mcv .row{display:grid;grid-template-columns:18px 1fr 1.2fr 1fr 22px;gap:5px;align-items:center;padding:2px 0;border-bottom:1px solid #26263a}
#mcv .row.unmatched .nm{color:#fca5a5}
#mcv .row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mcv .row select{width:100%}
#mcv .tune{grid-column:1/-1;display:grid;grid-template-columns:auto 1fr 40px;gap:2px 6px;align-items:center;padding:4px 0 6px 22px;font-size:11px}
#mcv .tune input[type=range]{width:100%}
#mcv details summary{cursor:pointer;margin:6px 0 4px;color:#ccd}
` }));

  win = el('div', { id: 'mcv' });
  const head = el('div', { className: 'mcv_head' }, [el('b', { textContent: 'Live view' })]);
  for (const [id, label] of [['cameras', 'Cameras'], ['3d', '3D'], ['layout', 'Layout'], ['face', 'Face']]) {
    const b = el('button', { className: 'mcv_tab', textContent: label, onclick: () => show_tab(id) });
    b.dataset.id = id;
    head.append(b);
  }
  head.append(el('button', { className: 'mcv_x', textContent: '×', title: 'Close (Ctrl+Shift+L)', onclick: toggle }));
  body = el('div', { className: 'mcv_body' });
  win.append(head, body);
  document.body.appendChild(win);

  // drag by the header
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.tagName == 'BUTTON') return;
    drag = { x: e.clientX - win.offsetLeft, y: e.clientY - win.offsetTop };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    win.style.left = Math.max(0, Math.min(innerWidth - 60, e.clientX - drag.x)) + 'px';
    win.style.top = Math.max(0, Math.min(innerHeight - 30, e.clientY - drag.y)) + 'px';
  });
  head.addEventListener('pointerup', () => { drag = null; });

  // keep XR Animator's own handlers out
  for (const ev of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend', 'touchmove', 'contextmenu']) {
    win.addEventListener(ev, (e) => e.stopPropagation());
  }

  tabs.cameras = build_cameras();
  tabs['3d'] = build_3d();
  tabs.layout = build_layout();
  tabs.face = build_face();
  for (const id in tabs) body.append(tabs[id].page);
  show_tab(active);
}

function show_tab(id) {
  active = id;
  for (const k in tabs) tabs[k].page.style.display = (k == id) ? '' : 'none';
  win.querySelectorAll('.mcv_tab').forEach(b => b.classList.toggle('on', b.dataset.id == id));
  tabs[id].on_show?.();
}

function toggle() {
  if (!win) build();
  visible = !visible;
  win.style.display = visible ? 'flex' : 'none';
  if (visible) { show_tab(active); requestAnimationFrame(loop); }
}

function loop(t) {
  if (!visible) return;
  if (t - last_draw > 50) {
    last_draw = t;
    try { tabs[active].draw?.(); }
    catch (e) { console.warn('[multicam view]', e); }
  }
  requestAnimationFrame(loop);
}

function fit_canvas(cv) {
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(50, Math.floor(r.width)), h = Math.max(50, Math.floor(cv.dataset.h ? +cv.dataset.h : r.height));
  if (cv.width != w * dpr || cv.height != h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function source_of(j) {
  const f = MC()?.live?.fused;
  return f ? f.source[j] : null;
}

// ---------- Cameras ----------

function build_cameras() {
  const cv = el('canvas');
  const wrap = el('div', { style: 'position:absolute;inset:8px 8px 26px 8px' }, [cv]);
  const legend = el('div', { className: 'small', style: 'position:absolute;left:8px;bottom:6px', innerHTML:
    `<span style="color:${COLOR.tri}">●</span> measured in 3D &nbsp; <span style="color:${COLOR.mono}">●</span> one camera only &nbsp; ` +
    `<span style="color:${COLOR.raw}">●</span> tracked (3D off) &nbsp; <span style="color:#fff">×</span> 3D result seen from this camera` });
  const page = el('div', { className: 'mcv_page' }, [wrap, legend]);

  function draw_skeleton(ctx, pts, color_of, ox, oy, s) {
    ctx.lineWidth = 2;
    for (const [a, b] of EDGES) {
      const p = pts[a], q = pts[b];
      if (!p || !q || p.score < 0.3 || q.score < 0.3) continue;
      ctx.strokeStyle = color_of(a);
      ctx.beginPath(); ctx.moveTo(ox + p.x * s, oy + p.y * s); ctx.lineTo(ox + q.x * s, oy + q.y * s); ctx.stroke();
    }
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j];
      if (!p || p.score < 0.3) continue;
      ctx.fillStyle = color_of(j);
      ctx.beginPath(); ctx.arc(ox + p.x * s, oy + p.y * s, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  function draw() {
    const mc = MC();
    if (!mc) return;
    const { ctx, w, h } = fit_canvas(cv);
    ctx.clearRect(0, 0, w, h);
    const C = mc.camera();
    const tiles = [{ label: 'Camera 1 (XR Animator)', src: C?.video_canvas, kind: 0 }]
      .concat(mc.extra.map((c, i) => ({ label: `Camera ${i + 2}: ${c.label || ''}`, src: c.video, cam: c, kind: i + 1 })));
    const cols = tiles.length <= 1 ? 1 : (w / h > 1.2 ? Math.min(tiles.length, 3) : Math.ceil(tiles.length / 2));
    const rows = Math.ceil(tiles.length / cols);
    const tw = w / cols, th = h / rows;
    const live = mc.live, cal = mc.calibration, fused = live.fused;

    tiles.forEach((tile, k) => {
      const x0 = (k % cols) * tw, y0 = Math.floor(k / cols) * th;
      const sw = tile.src?.videoWidth || tile.src?.width || 0, sh = tile.src?.videoHeight || tile.src?.height || 0;
      ctx.fillStyle = '#000'; ctx.fillRect(x0 + 1, y0 + 1, tw - 2, th - 2);
      if (!sw || !sh) {
        ctx.fillStyle = '#889'; ctx.fillText(tile.label + ': no picture yet', x0 + 8, y0 + 18);
        return;
      }
      const s = Math.min((tw - 4) / sw, (th - 20) / sh);
      const ox = x0 + (tw - sw * s) / 2, oy = y0 + 16 + (th - 18 - sh * s) / 2;
      try { ctx.drawImage(tile.src, ox, oy, sw * s, sh * s); } catch (e) {}

      let pts = null, color_of;
      if (tile.kind == 0) {
        pts = live.cam0_kp;
        color_of = (j) => fused ? (COLOR[source_of(live.cam0_flip ? mc.MIRROR[j] : j)] || COLOR.none) : COLOR.raw;
      }
      else {
        const last = tile.cam.history?.[tile.cam.history.length - 1];
        if (last?.landmarks) pts = last.landmarks.map(l => ({ x: l.x * sw, y: l.y * sh, score: l.visibility }));
        color_of = (j) => fused ? (COLOR[source_of(j)] || COLOR.none) : COLOR.raw;
      }
      if (pts) draw_skeleton(ctx, pts, color_of, ox, oy, s);

      // 3D result projected back into this camera
      const cc = cal?.cameras?.[tile.kind];
      if (fused && cc && cc.solved) {
        ctx.strokeStyle = COLOR.proj; ctx.lineWidth = 1;
        const sx = sw / cc.width;
        for (const X of fused.points) {
          if (!X) continue;
          const p = G().project(cc, X);
          if (p[2] <= 0) continue;
          let u = (p[0] + cc.width / 2) * sx, v = (p[1] + cc.height / 2) * sx;
          if (tile.kind == 0 && live.cam0_flip) u = sw - u;
          const px = ox + u * s, py = oy + v * s;
          ctx.beginPath(); ctx.moveTo(px - 3, py - 3); ctx.lineTo(px + 3, py + 3); ctx.moveTo(px + 3, py - 3); ctx.lineTo(px - 3, py + 3); ctx.stroke();
        }
      }
      const fps = tile.kind == 0 ? mc.stats.cam0_fps : (tile.cam.fps || 0);
      ctx.fillStyle = '#dde';
      ctx.fillText(`${tile.label}  ${fps.toFixed(0)} fps${tile.kind == 0 && live.cam0_flip ? '  (mirrored)' : ''}`, x0 + 6, y0 + 12);
    });
  }
  return { page, draw };
}

// ---------- 3D ----------

const orbit = { yaw: 0.7, pitch: 0.38, dist: 6.5, target: [0, 1, 0] };

function make_view(w, h) {
  const g = G();
  const eye = g.v_add(orbit.target, [orbit.dist * Math.cos(orbit.pitch) * Math.sin(orbit.yaw), orbit.dist * Math.sin(orbit.pitch), orbit.dist * Math.cos(orbit.pitch) * Math.cos(orbit.yaw)]);
  const f = g.v_norm(g.v_sub(orbit.target, eye));
  const r = g.v_norm(g.v_cross(f, [0, 1, 0]));
  const u = g.v_cross(r, f);
  const F = h * 1.1;
  return (p) => {
    const d = g.v_sub(p, eye);
    const z = g.v_dot(d, f);
    if (z < 0.05) return null;
    return [w / 2 + F * g.v_dot(d, r) / z, h / 2 - F * g.v_dot(d, u) / z];
  };
}

function build_3d() {
  const cv = el('canvas');
  const wrap = el('div', { style: 'position:absolute;inset:8px 8px 40px 8px' }, [cv]);
  const show_layout = el('input', { type: 'checkbox', checked: true });
  const info = el('span', { className: 'small' });
  const bar = el('div', { style: 'position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:10px;align-items:center' }, [
    el('label', {}, [show_layout, ' show rough layout']),
    el('button', { className: 'b', textContent: 'Reset view', onclick: () => Object.assign(orbit, { yaw: 0.7, pitch: 0.38, dist: 6.5 }) }),
    info,
  ]);
  const page = el('div', { className: 'mcv_page' }, [wrap, bar]);

  // drag to turn, wheel / pinch to zoom
  const ptrs = new Map();
  let pinch = 0;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const [px, py] = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size == 1) {
      orbit.yaw -= (e.clientX - px) * 0.01;
      orbit.pitch = Math.max(-0.2, Math.min(1.5, orbit.pitch + (e.clientY - py) * 0.01));
    }
    else if (ptrs.size == 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) orbit.dist = Math.max(1.5, Math.min(20, orbit.dist * pinch / d));
      pinch = d;
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(1.5, Math.min(20, orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });

  function draw_camera(ctx, P, cam, label, color, dashed) {
    const g = G();
    const C = cam.center || g.camera_center(cam);
    const R = cam.R, d = 0.35;
    const right = [R[0], R[1], R[2]], down = [R[3], R[4], R[5]], fwd = [R[6], R[7], R[8]];
    const hx = d * cam.width / 2 / cam.f, hy = d * cam.height / 2 / cam.f;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => g.v_add(g.v_add(g.v_add(C, g.v_scale(fwd, d)), g.v_scale(right, a * hx)), g.v_scale(down, b * hy)));
    const pc = P(C), pcs = corners.map(P);
    if (!pc || pcs.some(p => !p)) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    for (const p of pcs) { ctx.moveTo(pc[0], pc[1]); ctx.lineTo(p[0], p[1]); }
    pcs.forEach((p, i) => { if (i == 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    // "up" tick so you can see if a camera is upside down
    const top = P(g.v_add(g.v_add(C, g.v_scale(fwd, d)), g.v_scale(down, -hy * 1.4)));
    if (top) { ctx.beginPath(); ctx.moveTo((pcs[0][0] + pcs[1][0]) / 2, (pcs[0][1] + pcs[1][1]) / 2); ctx.lineTo(top[0], top[1]); ctx.stroke(); }
    ctx.fillStyle = color;
    ctx.font = 'bold 12px system-ui,sans-serif';
    ctx.fillText(label, pc[0] + 5, pc[1] - 5);
    ctx.font = '12px system-ui,sans-serif';
  }

  function draw() {
    const mc = MC(), g = G();
    if (!mc || !g) return;
    const { ctx, w, h } = fit_canvas(cv);
    ctx.fillStyle = '#0d0d14'; ctx.fillRect(0, 0, w, h);
    const P = make_view(w, h);

    // floor grid, 0.5 m
    ctx.lineWidth = 1;
    for (let i = -6; i <= 6; i++) {
      ctx.strokeStyle = i == 0 ? '#3b3b5a' : '#22223a';
      for (const [a, b] of [[[i * 0.5, 0, -3], [i * 0.5, 0, 3]], [[-3, 0, i * 0.5], [3, 0, i * 0.5]]]) {
        const p = P(a), q = P(b);
        if (p && q) { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
      }
    }
    // "front" arrow on the floor, towards camera 1
    const fa = P([0, 0, 0.3]), fb = P([0, 0, 0.8]);
    if (fa && fb) { ctx.strokeStyle = '#5b5fc7'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(fa[0], fa[1]); ctx.lineTo(fb[0], fb[1]); ctx.stroke(); }

    const cal = mc.calibration;
    if (show_layout.checked || !cal) {
      mc.layout_cams().forEach((c, i) => draw_camera(ctx, P, c, `${i + 1}?`, '#777a99', true));
    }
    if (cal) cal.cameras.forEach((c, i) => { if (c.solved) draw_camera(ctx, P, c, `${i + 1}`, i == 0 ? '#a5b4fc' : '#f0abfc', false); });

    const fused = mc.live.fused;
    if (fused) {
      ctx.lineWidth = 2.5;
      for (const [a, b] of EDGES) {
        const A = fused.points[a], B = fused.points[b];
        if (!A || !B) continue;
        const p = P(A), q = P(B);
        if (!p || !q) continue;
        ctx.strokeStyle = (fused.source[a] == 'tri' && fused.source[b] == 'tri') ? COLOR.tri : COLOR.mono;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      }
      // shadow on the floor
      ctx.fillStyle = 'rgba(91,95,199,.35)';
      for (const j of [27, 28]) {
        const X = fused.points[j];
        const p = X && P([X[0], 0, X[2]]);
        if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    info.textContent = !cal ? 'Not calibrated: showing your rough layout. Drag to turn, scroll to zoom.'
      : cal.from_layout ? 'Using your rough layout (not calibrated).'
      : `Calibrated, average error ${cal.rms_px.toFixed(1)} px. ${fused ? '' : '3D not active right now.'}`;
  }
  return { page, draw };
}

// ---------- Layout ----------

function build_layout() {
  const cv = el('canvas');
  cv.dataset.h = 260;
  const list = el('div');
  const hint = el('input', { type: 'checkbox', onchange: (e) => { MC().settings.layout_hint = e.target.checked; MC().save_settings(); } });
  const page = el('div', { className: 'mcv_page' }, [
    el('div', { className: 'small', textContent: 'Seen from above. You stand in the middle, facing camera 1. Drag each camera to roughly where it really is (the grid is 50 cm), then set its height and field of view.' }),
    el('div', { style: 'position:relative;margin:6px 0' }, [cv]),
    list,
    el('div', { style: 'margin-top:6px' }, [
      el('label', {}, [hint, ' Use this layout as a starting guess when I click Calibrate']),
    ]),
    el('div', {}, [
      el('button', { className: 'b', textContent: 'Track with this layout now (no calibration)', onclick: () => { MC().use_layout_as_calibration(); } }),
      el('button', { className: 'b', textContent: 'Reset layout', onclick: () => { MC().settings.layout = []; MC().save_settings(); rows_key = ''; } }),
    ]),
    el('div', { className: 'small', textContent: 'Tip: webcam field of view is usually on the box or spec sheet (often 60-80 degrees wide). A real calibration is still more accurate; the layout just helps it start in the right place.' }),
  ]);

  let rows_key = '';
  let ppm = 40, cx = 0, cy = 0, drag = -1;
  const n_cams = () => 1 + (MC()?.extra.length || 0);

  function to_screen(x, z) { return [cx + x * ppm, cy + z * ppm]; }
  function hit(e) {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    for (let i = 0; i < n_cams(); i++) {
      const L = MC().layout_entry(i);
      const [sx, sy] = to_screen(+L.x, +L.z);
      if (Math.hypot(mx - sx, my - sy) < 16) return i;
    }
    return -1;
  }
  cv.addEventListener('pointerdown', (e) => { drag = hit(e); if (drag >= 0) cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (drag < 0) { cv.style.cursor = hit(e) >= 0 ? 'grab' : 'default'; return; }
    const r = cv.getBoundingClientRect();
    const L = MC().layout_entry(drag);
    L.x = Math.round(((e.clientX - r.left - cx) / ppm) * 20) / 20;
    L.z = Math.round(((e.clientY - r.top - cy) / ppm) * 20) / 20;
    update_row_text();
  });
  cv.addEventListener('pointerup', () => { if (drag >= 0) MC().save_settings(); drag = -1; });

  const row_text = [];
  function update_row_text() {
    row_text.forEach((t, i) => {
      const L = MC().layout_entry(i);
      const dist = Math.hypot(+L.x, +L.z);
      const ang = Math.atan2(+L.x, +L.z) * 180 / Math.PI;
      t.textContent = `${dist.toFixed(2)} m away, ${Math.abs(ang).toFixed(0)}° ${ang > 1 ? 'to your left' : ang < -1 ? 'to your right' : 'in front'}`;
    });
  }

  function rebuild_rows() {
    list.textContent = '';
    row_text.length = 0;
    for (let i = 0; i < n_cams(); i++) {
      const L = MC().layout_entry(i);
      const t = el('span', { className: 'small' });
      row_text.push(t);
      const num = (key, step, min, max) => el('input', { type: 'number', step, min, max, value: L[key], oninput: (e) => { L[key] = parseFloat(e.target.value) || 0; MC().save_settings(); } });
      list.append(el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0' }, [
        el('b', { textContent: `Camera ${i + 1}`, style: 'width:64px' }),
        el('label', {}, ['height ', num('h', 0.05, 0, 3), ' m']),
        el('label', {}, ['field of view ', num('fov', 1, 20, 140), '°']),
        t,
      ]));
    }
    update_row_text();
  }

  function draw() {
    const mc = MC();
    if (!mc) return;
    const key = n_cams() + '|' + JSON.stringify(mc.settings.layout.length);
    if (key != rows_key) { rows_key = key; rebuild_rows(); }
    hint.checked = !!mc.settings.layout_hint;
    const { ctx, w, h } = fit_canvas(cv);
    ppm = Math.min(w, h) / 8.5; cx = w / 2; cy = h / 2;
    ctx.fillStyle = '#0d0d14'; ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i++) {
      ctx.strokeStyle = i % 2 ? '#1c1c2e' : '#2a2a44';
      const a = to_screen(i * 0.5, -4), b = to_screen(i * 0.5, 4), c = to_screen(-4, i * 0.5), d = to_screen(4, i * 0.5);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
    }
    // you
    ctx.fillStyle = '#5b5fc7';
    ctx.beginPath(); ctx.arc(cx, cy, 0.22 * ppm, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - 0.12 * ppm, cy + 0.15 * ppm); ctx.lineTo(cx + 0.12 * ppm, cy + 0.15 * ppm); ctx.lineTo(cx, cy + 0.45 * ppm); ctx.fill();
    ctx.fillStyle = '#ccd'; ctx.fillText('you', cx + 0.3 * ppm, cy - 0.2 * ppm);

    for (let i = 0; i < n_cams(); i++) {
      const L = mc.layout_entry(i);
      const [sx, sy] = to_screen(+L.x, +L.z);
      const aim = Math.atan2(cy - sy, cx - sx);
      const half = (+L.fov || 65) * Math.PI / 360;
      ctx.fillStyle = i == 0 ? 'rgba(165,180,252,.18)' : 'rgba(240,171,252,.18)';
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, 1.2 * ppm, aim - half, aim + half); ctx.closePath(); ctx.fill();
      ctx.fillStyle = i == 0 ? '#a5b4fc' : '#f0abfc';
      ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 11px system-ui,sans-serif';
      ctx.fillText(String(i + 1), sx - 3, sy + 4);
      ctx.font = '12px system-ui,sans-serif';
    }
  }
  return { page, draw, on_show: () => { rows_key = ''; } };
}

// ---------- Face ----------

function build_face() {
  const status = el('div', { className: 'small' });
  const ark_grid = el('div', { className: 'grid2' });
  const rows = el('div');
  const custom = el('input', { type: 'text', placeholder: 'blendshape name', style: 'width:130px' });
  const file_in = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    f.text().then(t => { try { FACE().import_json(t); dirty = true; } catch (err) { alert('Could not load: ' + err.message); } });
  } });

  const opt = (label, key, values) => {
    const s = el('select', { onchange: (e) => { FACE().settings[key] = values ? e.target.value : e.target.checked; FACE().save(); } });
    for (const [v, t] of values) s.append(el('option', { value: v, textContent: t }));
    return el('label', {}, [label, ' ', s]);
  };
  const chk = (label, key) => el('label', {}, [el('input', { type: 'checkbox', dataset_key: key, onchange: (e) => { FACE().settings[key] = e.target.checked; FACE().save(); } }), ' ', label]);

  const mode_sel = opt('Send over VMC:', 'mode', [['add', 'XR Animator\'s blendshapes + these (these win)'], ['only', 'only the blendshapes listed here']]);
  const style_sel = opt('ARKit names:', 'arkit_style', [['upper', 'EyeBlinkLeft'], ['lower', 'eyeBlinkLeft']]);
  const local_chk = chk('also show on XR Animator\'s avatar', 'local');
  const swap_chk = chk('swap left / right', 'swap_lr');

  const page = el('div', { className: 'mcv_page' }, [
    status,
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 14px;margin:4px 0' }, [mode_sel, style_sel, local_chk, swap_chk]),
    el('div', {}, [
      el('span', { className: 'small' }, 'Add: '),
      ...['arkit', 'vrm0', 'vrm1', 'mmd'].map(k => el('button', { className: 'b', textContent: FACE()?.PACKS[k].label || k, onclick: () => { FACE().add_pack(k); dirty = true; } })),
      el('button', { className: 'b', textContent: 'From my avatar', title: 'Every blendshape on the avatar loaded in XR Animator', onclick: () => {
        const n = FACE().add_pack('avatar'); dirty = true;
        if (!n && !FACE().local_names.length) alert('No avatar blendshapes found yet. Load a VRM avatar in XR Animator and start face tracking first.');
      } }),
    ]),
    el('div', {}, [custom,
      el('button', { className: 'b', textContent: 'Add name', onclick: () => { const v = custom.value.trim(); if (v) { FACE().add_targets([v]); custom.value = ''; dirty = true; } } }),
      el('button', { className: 'b', textContent: 'Auto-match unmatched', onclick: () => { FACE().auto_match_all(true); dirty = true; } }),
      el('button', { className: 'b', textContent: 'Export', onclick: export_json }),
      el('button', { className: 'b', textContent: 'Import', onclick: () => file_in.click() }),
      el('button', { className: 'b', textContent: 'Remove all', onclick: () => { if (confirm('Remove every blendshape from the list?')) { FACE().settings.targets = []; FACE().save(); dirty = true; } } }),
      file_in,
    ]),
    el('details', {}, [el('summary', { textContent: 'Live ARKit values from the camera' }), ark_grid]),
    el('div', { className: 'small', style: 'margin:6px 0 2px' }, 'Blendshapes sent to VNyan (VMC). Red names have no match yet: pick a source. ⚙ = fine-tune. The bar shows the result, the faint bar shows the raw input.'),
    rows,
  ]);

  let dirty = true;
  const ark_refs = {};
  const row_refs = [];

  function export_json() {
    const blob = new Blob([FACE().export_json()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'xra_face_mapping.json' });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function bar() {
    const i = el('i'), s = el('s'), span = el('span');
    return { root: el('div', { className: 'bar' }, [s, i, span]), i, s, span };
  }

  function fill_select(sel, current) {
    const face = FACE();
    sel.textContent = '';
    sel.append(el('option', { value: '', textContent: '(none)' }));
    for (const grp of face.all_sources()) {
      if (!grp.items.length) continue;
      const og = el('optgroup', { label: grp.group });
      for (const it of grp.items) og.append(el('option', { value: it.id, textContent: it.label }));
      sel.append(og);
    }
    if (current && ![...sel.options].some(o => o.value == current)) sel.append(el('option', { value: current, textContent: face.source_label(current) }));
    sel.value = current || '';
  }

  function rebuild() {
    const face = FACE();
    // ARKit grid
    if (!ark_grid.childElementCount) {
      for (const n of face.ARKIT) {
        const b = bar();
        ark_refs[n] = b;
        ark_grid.append(el('div', { className: 'ark' }, [el('span', { textContent: n + (face.UNTRACKED.has(n) ? ' *' : ''), title: face.UNTRACKED.has(n) ? 'Not tracked by the camera' : '' }), b.root]));
      }
    }
    rows.textContent = '';
    row_refs.length = 0;
    if (!face.settings.targets.length) {
      rows.append(el('div', { className: 'small', style: 'padding:8px 0' }, 'Nothing here yet. Add a set above (for VNyan, usually "From my avatar" or ARKit / Perfect Sync).'));
    }
    face.settings.targets.forEach((t) => {
      const b = bar();
      const sel = el('select', { onchange: (e) => { t.source = e.target.value || null; t.auto = false; face.save(); row.classList.toggle('unmatched', !t.source); } });
      fill_select(sel, t.source);
      sel.addEventListener('focus', () => fill_select(sel, t.source));
      const tune = el('div', { className: 'tune', style: 'display:none' });
      const slider = (label, key, min, max, step, fmt) => {
        const val = el('span');
        const r = el('input', { type: 'range', min, max, step, value: t[key] ?? (key == 'in_max' || key == 'strength' || key == 'curve' ? 1 : 0),
          oninput: (e) => { t[key] = parseFloat(e.target.value); val.textContent = fmt(t[key]); face.save(); } });
        val.textContent = fmt(+r.value);
        tune.append(el('span', { textContent: label }), r, val);
      };
      const pct = (x) => Math.round(x * 100) + '%';
      slider('Strength', 'strength', 0, 3, 0.05, (x) => x.toFixed(2) + 'x');
      slider('Starts at (input)', 'in_min', 0, 1, 0.01, pct);
      slider('Full at (input)', 'in_max', 0, 1, 0.01, pct);
      slider('Curve', 'curve', 0.2, 3, 0.05, (x) => x.toFixed(2));
      slider('Smoothing', 'smooth', 0, 0.95, 0.01, pct);
      tune.append(el('span'), el('div', {}, [
        el('button', { className: 'b', textContent: 'Reset tuning', onclick: () => { Object.assign(t, { strength: 1, in_min: 0, in_max: 1, curve: 1, smooth: 0 }); face.save(); dirty = true; } }),
        el('button', { className: 'b', textContent: 'Remove', onclick: () => { face.remove_target(t.name); dirty = true; } }),
      ]), el('span'));
      const row = el('div', { className: 'row' + (t.source ? '' : ' unmatched') }, [
        el('input', { type: 'checkbox', checked: t.enabled !== false, title: 'On / off', onchange: (e) => { t.enabled = e.target.checked; face.save(); } }),
        el('span', { className: 'nm', textContent: t.name, title: t.name }),
        sel,
        b.root,
        el('button', { className: 'mcv_x', textContent: '⚙', title: 'Fine-tune', onclick: () => { tune.style.display = tune.style.display == 'none' ? '' : 'none'; } }),
        tune,
      ]);
      rows.append(row);
      row_refs.push({ t, b });
    });
    // option controls
    page.querySelectorAll('select').forEach(s => {
      if (s.closest('.row')) return;
      if ([...s.options].some(o => o.value == 'add')) s.value = face.settings.mode;
      if ([...s.options].some(o => o.value == 'upper')) s.value = face.settings.arkit_style;
    });
    local_chk.querySelector('input').checked = !!face.settings.local;
    swap_chk.querySelector('input').checked = !!face.settings.swap_lr;
  }

  function draw() {
    const face = FACE();
    if (!face) { status.textContent = 'Face module not loaded.'; return; }
    if (dirty) { dirty = false; rebuild(); }
    const n = face.settings.targets.length, unmatched = face.settings.targets.filter(t => !t.source).length;
    status.textContent = (face.face_alive ? `Face tracking: ${face.arkit_fps.toFixed(0)} fps.` : 'Face tracking is not running (use a face mode in XR Animator).') +
      ` ${n} blendshape${n == 1 ? '' : 's'} listed` + (unmatched ? `, ${unmatched} without a match.` : '.') + ' * = not trackable with a webcam.';
    const set = (b, x, raw) => {
      const v = Math.max(0, Math.min(1, x || 0));
      b.i.style.width = (v * 100) + '%';
      if (raw != null) b.s.style.width = (Math.max(0, Math.min(1, raw)) * 100) + '%';
      b.span.textContent = Math.round(v * 100) + '%';
    };
    if (ark_grid.closest('details').open) for (const k in ark_refs) set(ark_refs[k], face.arkit[k]);
    for (const r of row_refs) set(r.b, face.out[r.t.name], face.source_value(r.t.source));
  }

  return { page, draw, on_show: () => { dirty = true; } };
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key == 'L' || e.key == 'l')) { e.preventDefault(); e.stopPropagation(); toggle(); }
}, true);

window.MC_view = { toggle, show_tab };

})();
