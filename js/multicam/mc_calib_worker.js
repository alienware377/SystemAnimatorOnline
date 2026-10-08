// Multi-camera: runs the (slow) calibration off the main thread so XR Animator keeps rendering.

importScripts('mc_geometry.js', 'mc_calibrate.js');

onmessage = (e) => {
  const { samples, cams_info, options } = e.data;
  try {
    const result = MC_calibrate.calibrate(samples, cams_info, Object.assign({}, options, {
      log: (msg) => postMessage({ type: 'log', message: msg }),
    }));
    postMessage({ type: 'done', result });
  }
  catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
