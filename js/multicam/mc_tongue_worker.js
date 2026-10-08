// Tongue detector worker (experimental).
// Finds the mouth with MediaPipe FaceLandmarker, then measures the colours in two
// patches lined up with the mouth: the mouth opening, and the area from the lower
// lip down towards the chin. A sticking-out tongue changes both. The main thread
// learns what "tongue in" and "tongue out" look like for this person and light.

let landmarker = null, busy = false, last_ts = 0;
let canvas = null, ctx = null;

// FaceLandmarker mesh points
const CORNER_A = 61, CORNER_B = 291, UPPER_IN = 13, LOWER_IN = 14, CHIN = 152;
const GX = 6, GY = 4;     // sample grid per sub-block
const BX = 3, BY = 2;     // sub-blocks per region

async function init() {
  const m = await import('../@mediapipe/tasks/tasks-vision/vision_bundle.mjs');
  const vision = await m.FilesetResolver.forVisionTasks('../@mediapipe/tasks/tasks-vision/wasm');
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: '../@mediapipe/tasks/face_landmarker.task', delegate },
    runningMode: 'VIDEO', numFaces: 1,
  });
  try { landmarker = await m.FaceLandmarker.createFromOptions(vision, options('GPU')); }
  catch (e) { landmarker = await m.FaceLandmarker.createFromOptions(vision, options('CPU')); }
  postMessage({ type: 'ready' });
}

// bilinear-free nearest sampling is plenty here: we average many samples per block
function features(img, x0, y0, w, h, lm) {
  const P = (i) => [lm[i].x * w, lm[i].y * h];
  const A = P(CORNER_A), B = P(CORNER_B);
  const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  let ux = B[0] - A[0], uy = B[1] - A[1];
  const W = Math.hypot(ux, uy);
  if (W < 8) return null;
  ux /= W; uy /= W;
  // "down" = perpendicular, pointing towards the chin
  let vx = -uy, vy = ux;
  const C = P(CHIN);
  if ((C[0] - M[0]) * vx + (C[1] - M[1]) * vy < 0) { vx = -vx; vy = -vy; }
  const along = (p) => (p[0] - M[0]) * vx + (p[1] - M[1]) * vy;
  const y_up = along(P(UPPER_IN)), y_low = along(P(LOWER_IN)), y_chin = along(C);

  const regions = [
    [y_up, Math.max(y_low, y_up + 0.06 * W)],                       // mouth opening
    [y_low, Math.min(y_low + 0.6 * W, Math.max(y_chin - 0.05 * W, y_low + 0.2 * W))], // lower lip to chin
  ];
  const data = img.data, iw = img.width, ih = img.height;
  const f = [];
  for (const [ya, yb] of regions) {
    for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) {
      let sr = 0, sg = 0, sy = 0, n = 0;
      for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
        const a = -0.36 * W + ((bx + (gx + 0.5) / GX) / BX) * 0.72 * W;
        const b = ya + ((by + (gy + 0.5) / GY) / BY) * (yb - ya);
        const px = Math.round(M[0] + a * ux + b * vx - x0), py = Math.round(M[1] + a * uy + b * vy - y0);
        if (px < 0 || py < 0 || px >= iw || py >= ih) continue;
        const k = (py * iw + px) * 4;
        const R = data[k], Gc = data[k + 1], Bc = data[k + 2], S = R + Gc + Bc + 1;
        sr += R / S; sg += Gc / S; sy += S / 765; n++;
      }
      if (!n) return null;
      f.push(sr / n, sg / n, sy / n);
    }
  }
  return { f, mouth: { M, ux, uy, vx, vy, W, y_up, y_low, y_chin } };
}

onmessage = async (e) => {
  const d = e.data;
  if (d.type == 'init') {
    try { await init(); } catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); }
    return;
  }
  if (d.type != 'frame') return;
  const bitmap = d.bitmap;
  if (!landmarker || busy) { bitmap.close(); return; }
  busy = true;
  let ts = Math.round(d.ts);
  if (ts <= last_ts) ts = last_ts + 1;
  last_ts = ts;
  const w = bitmap.width, h = bitmap.height;
  let out = { type: 'result', id: d.id, found: false };
  try {
    const r = landmarker.detectForVideo(bitmap, ts);
    const lm = r?.faceLandmarks?.[0];
    if (lm) {
      // only read the pixels around the mouth
      const xs = [CORNER_A, CORNER_B, UPPER_IN, LOWER_IN, CHIN].map(i => lm[i].x * w), ys = [CORNER_A, CORNER_B, UPPER_IN, LOWER_IN, CHIN].map(i => lm[i].y * h);
      const pad = 0.6 * Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
      const x1 = Math.min(w, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(h, Math.ceil(Math.max(...ys) + pad));
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        if (!canvas || canvas.width < x1 - x0 || canvas.height < y1 - y0) {
          canvas = new OffscreenCanvas(Math.max(64, x1 - x0), Math.max(64, y1 - y0));
          ctx = canvas.getContext('2d', { willReadFrequently: true });
        }
        ctx.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
        const img = ctx.getImageData(0, 0, x1 - x0, y1 - y0);
        const ft = features(img, x0, y0, w, h, lm);
        if (ft) {
          out.found = true;
          out.f = ft.f;
          out.mouth = ft.mouth;
          out.w = w; out.h = h;
          if (d.want_preview) out.preview = await createImageBitmap(canvas, 0, 0, x1 - x0, y1 - y0);
        }
      }
    }
  }
  catch (err) { out.error = String(err && err.message || err); }
  bitmap.close();
  busy = false;
  postMessage(out, out.preview ? [out.preview] : []);
};
