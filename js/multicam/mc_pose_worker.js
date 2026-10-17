// Multi-camera: pose (and hand) tracking worker for one extra camera.
// Runs MediaPipe PoseLandmarker (same model files XR Animator ships) on frames
// posted from the main thread and sends back landmarks + world landmarks.
// With hands on, it also crops around each wrist the body tracker found and runs
// HandLandmarker on the close-up (like XR Animator does), so each hand already
// knows which side it is.
// With face on, it crops around the head and runs FaceLandmarker for the ARKit
// face values. The crop is MIRRORED first, so the values come out exactly like
// XR Animator's own (it tracks a mirrored picture), and can be mixed with them.

let landmarker = null, hand_landmarker = null, face_landmarker = null;
let face_canvas = null, face_ctx = null;
const FACE_CROP = 256;
let last_ts = 0;
let busy = false;

const HAND_CROP = 256;
// BlazePose: wrist, pinky, index, thumb, elbow per side
const SIDES = { L: { wrist: 15, pinky: 17, index: 19, thumb: 21, elbow: 13 }, R: { wrist: 16, pinky: 18, index: 20, thumb: 22, elbow: 14 } };

async function init(param) {
  const m = await import('../@mediapipe/tasks/tasks-vision/vision_bundle.mjs');
  const vision = await m.FilesetResolver.forVisionTasks('../@mediapipe/tasks/tasks-vision/wasm');
  const options = (delegate) => ({
    baseOptions: {
      modelAssetPath: '../@mediapipe/tasks/pose_landmarker_' + ((param.model_quality == 'Best') ? 'heavy' : 'full') + '.task',
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  let delegate = 'GPU';
  try {
    landmarker = await m.PoseLandmarker.createFromOptions(vision, options('GPU'));
  }
  catch (err) {
    // some tablets have no usable WebGL in workers
    delegate = 'CPU';
    landmarker = await m.PoseLandmarker.createFromOptions(vision, options('CPU'));
  }
  if (param.hands) {
    try {
      hand_landmarker = await m.HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '../@mediapipe/tasks/hand_landmarker.task', delegate },
        runningMode: 'IMAGE', numHands: 1,
        minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4,
      });
    }
    catch (err) { postMessage({ type: 'error', message: 'hand tracker: ' + (err && err.message || err) }); }
  }
  if (param.face) {
    try {
      face_landmarker = await m.FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '../@mediapipe/tasks/face_landmarker.task', delegate },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      });
    }
    catch (err) { postMessage({ type: 'error', message: 'face tracker: ' + (err && err.message || err) }); }
  }
  postMessage({ type: 'ready', hands: !!hand_landmarker, face: !!face_landmarker });
}

async function track_hands(bitmap, lm) {
  const w = bitmap.width, h = bitmap.height;
  const out = [];
  for (const side of ['L', 'R']) {
    const S = SIDES[side];
    const wr = lm[S.wrist], ix = lm[S.index], pk = lm[S.pinky], el = lm[S.elbow];
    if (!wr || wr.visibility < 0.3) continue;
    const W = [wr.x * w, wr.y * h];
    const K = [((ix.x + pk.x) / 2) * w, ((ix.y + pk.y) / 2) * h];
    const forearm = Math.hypot(W[0] - el.x * w, W[1] - el.y * h);
    const knuckle = Math.hypot(K[0] - W[0], K[1] - W[1]);
    const size = Math.round(Math.min(Math.max(3.2 * knuckle, 0.55 * forearm, 64), Math.min(w, h)));
    const cx = W[0] + (K[0] - W[0]) * 1.0, cy = W[1] + (K[1] - W[1]) * 1.0;
    const sx = Math.round(Math.max(0, Math.min(w - size, cx - size / 2))), sy = Math.round(Math.max(0, Math.min(h - size, cy - size / 2)));
    let crop;
    try { crop = await createImageBitmap(bitmap, sx, sy, size, size, { resizeWidth: HAND_CROP, resizeHeight: HAND_CROP }); }
    catch (e) { continue; }
    let r = null;
    try { r = hand_landmarker.detect(crop); } catch (e) {}
    crop.close();
    const hl = r?.landmarks?.[0], hw = r?.worldLandmarks?.[0];
    if (!hl || !hw) continue;
    // the hand we found must start near the wrist the body tracker gave us
    const hx = sx + hl[0].x * size, hy = sy + hl[0].y * size;
    if (Math.hypot(hx - W[0], hy - W[1]) > 0.45 * size) continue;
    out.push({
      side,
      score: r.handedness?.[0]?.[0]?.score ?? 0.8,
      landmarks: hl.map(l => ({ x: (sx + l.x * size) / w, y: (sy + l.y * size) / h, z: l.z })),
      world: hw.map(l => ({ x: l.x, y: l.y, z: l.z })),
    });
  }
  return out;
}

// ARKit face values from a mirrored close-up of the head (null if no face)
function track_face(bitmap, lm, ts) {
  const w = bitmap.width, h = bitmap.height;
  const pts = [0, 2, 5, 7, 8, 9, 10].map(i => lm[i]).filter(p => p && p.visibility > 0.3);
  if (pts.length < 4) return null;
  const xs = pts.map(p => p.x * w), ys = pts.map(p => p.y * h);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const size = Math.round(Math.min(Math.max(2.6 * span, 96), Math.min(w, h)));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2 + 0.1 * size;
  const sx = Math.round(Math.max(0, Math.min(w - size, cx - size / 2))), sy = Math.round(Math.max(0, Math.min(h - size, cy - size / 2)));
  if (!face_canvas) {
    face_canvas = new OffscreenCanvas(FACE_CROP, FACE_CROP);
    face_ctx = face_canvas.getContext('2d');
  }
  face_ctx.setTransform(-1, 0, 0, 1, FACE_CROP, 0);
  face_ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, FACE_CROP, FACE_CROP);
  face_ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = face_canvas.transferToImageBitmap();
  let r = null;
  try { r = face_landmarker.detectForVideo(img, ts); } catch (e) {}
  img.close();
  const cats = r?.faceBlendshapes?.[0]?.categories;
  if (!cats) return null;
  const values = {};
  for (const c of cats) values[c.categoryName] = c.score;
  return { values };
}

onmessage = async (e) => {
  const d = e.data;
  if (d.type == 'init') {
    try { await init(d.param || {}); }
    catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); }
    return;
  }

  if (d.type == 'frame') {
    const bitmap = d.bitmap;
    if (!landmarker || busy) { bitmap.close(); return; }
    busy = true;
    const t0 = performance.now();
    // MediaPipe needs strictly increasing timestamps
    let ts = Math.round(d.ts);
    if (ts <= last_ts) ts = last_ts + 1;
    last_ts = ts;

    let result = null;
    try { result = landmarker.detectForVideo(bitmap, ts); }
    catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); }
    const w = bitmap.width, h = bitmap.height;

    const lm = result?.landmarks?.[0];
    const wl = result?.worldLandmarks?.[0];
    let hands = null, face = null;
    if (face_landmarker && d.face !== false && lm) {
      try { face = track_face(bitmap, lm, ts); } catch (err) { face = null; }
    }
    if (hand_landmarker && d.hands !== false && lm) {
      try { hands = await track_hands(bitmap, lm); } catch (err) { hands = null; }
    }
    bitmap.close();
    busy = false;

    postMessage({
      type: 'result',
      id: d.id,
      ts: d.ts,
      w, h,
      dt: performance.now() - t0,
      landmarks: lm ? lm.map(l => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility })) : null,
      worldLandmarks: wl ? wl.map(l => ({ x: l.x, y: l.y, z: l.z })) : null,
      hands,
      face,
    });
  }
};
