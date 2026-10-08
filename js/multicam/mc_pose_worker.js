// Multi-camera: pose tracking worker for one extra camera.
// Runs MediaPipe PoseLandmarker (same model files XR Animator ships) on frames
// posted from the main thread and sends back landmarks + world landmarks.

let landmarker = null;
let last_ts = 0;
let busy = false;

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
  try {
    landmarker = await m.PoseLandmarker.createFromOptions(vision, options('GPU'));
  }
  catch (err) {
    // some tablets have no usable WebGL in workers
    landmarker = await m.PoseLandmarker.createFromOptions(vision, options('CPU'));
  }
  postMessage({ type: 'ready' });
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
    bitmap.close();
    busy = false;

    const lm = result?.landmarks?.[0];
    const wl = result?.worldLandmarks?.[0];
    postMessage({
      type: 'result',
      id: d.id,
      ts: d.ts,
      w, h,
      dt: performance.now() - t0,
      landmarks: lm ? lm.map(l => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility })) : null,
      worldLandmarks: wl ? wl.map(l => ({ x: l.x, y: l.y, z: l.z })) : null,
    });
  }
};
