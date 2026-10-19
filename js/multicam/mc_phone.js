// Phone side of the phone cameras (runs in the phone's browser, served by XR Animator).
// Tracks body, hands and face on the phone itself with the same worker the desktop
// uses for extra cameras, and sends only the results (small) to XR Animator.

(function () {

'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('k') || '';

// a stable id, so XR Animator recognises this phone again after a reconnect
let phone_id = '';
try { phone_id = localStorage.getItem('xra_phone_id') || ''; } catch (e) {}
if (!phone_id) {
  phone_id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem('xra_phone_id', phone_id); } catch (e) {}
}
const default_name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
try { $('name').value = localStorage.getItem('xra_phone_name') || default_name; } catch (e) { $('name').value = default_name; }
try { const f = localStorage.getItem('xra_phone_facing'); if (f) $('facing').value = f; } catch (e) {}

let ws = null, connected = false, config = { hands: true, face: true, model_quality: '' };
let offset = null, best_rtt = Infinity;                 // tablet clock = phone clock + offset
let stream = null, worker = null, ready = false, busy = false, running = false, frame_id = 0;
let fps = 0, n = 0, t_fps = performance.now(), last_preview = 0, wake = null;
const thumb = document.createElement('canvas');

function status(text, cls, detail) {
  $('status').textContent = text;
  $('status').className = cls || '';
  if (detail != null) $('detail').textContent = detail;
}

// ---------- connection ----------

function connect() {
  if (!token) { status('This page needs the link from XR Animator (scan the QR code there).', 'bad'); return; }
  ws = new WebSocket(`wss://${location.host}/ws?k=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    connected = true;
    send({ type: 'hello', id: phone_id, name: $('name').value.trim() || default_name, ua: navigator.userAgent });
    ping_loop();
    status(running ? 'Sending to XR Animator' : 'Connected. Press "Start camera".', 'ok');
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.type == 'welcome' || m.type == 'config') Object.assign(config, m.settings || {});
    if (m.type == 'pong') {
      const now = performance.now(), rtt = now - m.t0;
      // keep the measurement with the shortest round trip: least affected by network delay
      if (rtt <= best_rtt * 1.5 || offset == null) {
        const o = m.t1 - (m.t0 + rtt / 2);
        offset = (offset == null || rtt < best_rtt) ? o : offset * 0.8 + o * 0.2;
        best_rtt = Math.min(best_rtt * 1.02, rtt);
      }
    }
    if (m.type == 'bye') { status('XR Animator removed this camera.', 'warn'); stop(); }
  };
  ws.onclose = () => {
    connected = false;
    status('Lost the connection to XR Animator. Retrying...', 'warn');
    setTimeout(connect, 2000);
  };
}

function send(obj) { if (ws && ws.readyState == 1) ws.send(JSON.stringify(obj)); }

let ping_timer = 0;
function ping_loop() {
  clearInterval(ping_timer);
  const ping = () => send({ type: 'ping', t0: performance.now() });
  for (let i = 0; i < 5; i++) setTimeout(ping, i * 120);
  ping_timer = setInterval(ping, 2000);
}

// ---------- camera + tracking ----------

async function start() {
  try { localStorage.setItem('xra_phone_name', $('name').value.trim()); localStorage.setItem('xra_phone_facing', $('facing').value); } catch (e) {}
  if (connected) send({ type: 'hello', id: phone_id, name: $('name').value.trim() || default_name, ua: navigator.userAgent });
  const [w, h] = $('res').value.split('x').map(Number);
  status('Starting the camera...', '');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: $('facing').value, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } } });
  }
  catch (e) {
    status('Could not open the camera: ' + (e.message || e.name), 'bad', 'Allow camera access for this page, then try again.');
    return;
  }
  const video = $('video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('setup').hidden = true; $('view').hidden = false; $('stop').hidden = false;
  status('Loading the trackers (first time can take a minute)...', '');
  worker = new Worker('mc_pose_worker.js');
  worker.onmessage = (e) => on_worker(e.data);
  worker.postMessage({ type: 'init', param: { model_quality: config.model_quality, hands: config.hands !== false, face: config.face !== false } });
  running = true;
  try { wake = await navigator.wakeLock?.request('screen'); } catch (e) {}
  pump();
}

function stop() {
  running = false;
  worker?.terminate(); worker = null; ready = false; busy = false;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  try { wake?.release(); } catch (e) {}
  $('setup').hidden = false; $('view').hidden = true; $('stop').hidden = true;
  send({ type: 'stopped' });
  status(connected ? 'Stopped. Press "Start camera" to send again.' : 'Stopped.', '');
}

function pump() {
  if (!running) return;
  const video = $('video');
  // next video frame, or after 50 ms if the browser stops reporting frames (some
  // phones do when the screen dims), whichever comes first
  let done = false;
  const go = async () => {
    if (done) return;
    done = true;
    if (ready && !busy && video.readyState >= 2) {
      busy = true;
      try {
        const bitmap = await createImageBitmap(video);
        worker.postMessage({ type: 'frame', bitmap, ts: performance.now(), id: ++frame_id, hands: config.hands !== false, face: config.face !== false }, [bitmap]);
      }
      catch (e) { busy = false; }
    }
    pump();
  };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(go);
  else requestAnimationFrame(go);
  setTimeout(go, 50);
}

function on_worker(d) {
  if (d.type == 'ready') { ready = true; status('Sending to XR Animator', 'ok'); return; }
  if (d.type == 'error') { $('detail').textContent = d.message; busy = false; return; }
  if (d.type != 'result') return;
  busy = false;
  n++;
  const now = performance.now();
  if (now - t_fps > 1000) { fps = n * 1000 / (now - t_fps); n = 0; t_fps = now; }
  if (offset != null) {
    send({ type: 'result', ts: d.ts + offset, w: d.w, h: d.h, landmarks: d.landmarks, worldLandmarks: d.worldLandmarks, hands: d.hands, face: d.face, fps });
  }
  draw(d);
  // a small picture for XR Animator's live view, twice a second
  if (now - last_preview > 500 && connected) {
    last_preview = now;
    const v = $('video'), s = 240 / Math.max(v.videoWidth, v.videoHeight);
    thumb.width = Math.round(v.videoWidth * s); thumb.height = Math.round(v.videoHeight * s);
    thumb.getContext('2d').drawImage(v, 0, 0, thumb.width, thumb.height);
    send({ type: 'preview', jpeg: thumb.toDataURL('image/jpeg', 0.6) });
  }
  $('detail').textContent = `${fps.toFixed(0)} fps` + (d.landmarks ? ', body found' : ', no body in view') +
    (d.hands?.length ? `, ${d.hands.length} hand${d.hands.length > 1 ? 's' : ''}` : '') + (d.face ? ', face' : '') +
    (offset == null ? ', syncing clocks...' : `, ${Math.round(best_rtt)} ms round trip`);
}

const EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,31],[28,32]];
function draw(d) {
  const cv = $('overlay'), v = $('video');
  if (cv.width != v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const L = d.landmarks;
  if (!L) return;
  ctx.strokeStyle = '#4ade80'; ctx.lineWidth = Math.max(3, cv.width / 200);
  ctx.beginPath();
  for (const [a, b] of EDGES) { if (L[a].visibility < 0.4 || L[b].visibility < 0.4) continue; ctx.moveTo(L[a].x * cv.width, L[a].y * cv.height); ctx.lineTo(L[b].x * cv.width, L[b].y * cv.height); }
  ctx.stroke();
  ctx.strokeStyle = '#f472b6';
  for (const hd of d.hands || []) {
    ctx.beginPath();
    for (const p of hd.landmarks) { ctx.moveTo(p.x * cv.width + 2, p.y * cv.height); ctx.arc(p.x * cv.width, p.y * cv.height, 2, 0, 6.3); }
    ctx.stroke();
  }
}

$('start').onclick = start;
$('stop').onclick = stop;
document.addEventListener('visibilitychange', async () => {
  // the wake lock is dropped when the page is hidden; take it again when it's back
  if (document.visibilityState == 'visible' && running) { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) {} }
});
if (!window.isSecureContext) status('This page must be opened with https (use the link from XR Animator).', 'bad');
else connect();

})();
