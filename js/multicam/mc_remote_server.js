// Phone cameras: a small HTTPS + WebSocket server inside XR Animator's desktop app.
//
// Phones (iPhone, Android, tablets) open https://<this PC>:<port>/ in their browser,
// track themselves with the same MediaPipe models, and send their results here over
// the WebSocket. Phones only allow the camera on secure (https) pages, so the server
// makes its own certificate the first time; the phone shows a one-time "not private"
// warning for it that you accept.
//
// Needs the desktop app (Node.js inside Electron); in a normal browser it reports
// itself as unavailable.

(function () {

'use strict';

const node_require = (typeof require === 'function') ? require : null;
if (!node_require) { window.MC_remote_server = { available: false }; return; }

let https, crypto, fs, path, os;
try {
  https = node_require('https'); crypto = node_require('crypto'); fs = node_require('fs');
  path = node_require('path'); os = node_require('os');
}
catch (e) { window.MC_remote_server = { available: false }; return; }

// ---------- a self-signed certificate (ECDSA P-256), built by hand ----------

function der_len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), der_len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const v of parts.slice(2)) {
    const b = [v & 0x7f];
    let x = v >>> 7;
    while (x) { b.unshift((x & 0x7f) | 0x80); x >>>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function der_int(buf) {
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

function local_ips() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family == 'IPv4' || a.family === 4) out.push(a.address);
  }
  return [...new Set(out)];
}

function make_cert(ips) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sig_alg = seq(oid('1.2.840.10045.4.3.2'));            // ecdsa-with-SHA256
  const now = new Date();
  const san = seq(...ips.map(ip => tlv(0x87, Buffer.from(ip.split('.').map(Number)))), tlv(0x82, Buffer.from('localhost')));
  const ext = (id, value, critical) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  const tbs = seq(
    tlv(0xa0, der_int(Buffer.from([2]))),                      // v3
    der_int(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(15)])),
    sig_alg,
    name('XR Animator MultiCam'),
    seq(utc(new Date(now - 86400000)), utc(new Date(+now + 365 * 86400000))),
    name('XR Animator MultiCam'),
    spki,
    tlv(0xa3, seq(
      ext('2.5.29.17', san),                                   // subjectAltName
      ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),         // extendedKeyUsage: serverAuth
      ext('2.5.29.19', seq(), true),                           // basicConstraints: not a CA
    )),
  );
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = seq(tbs, sig_alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), ips, created: now.toISOString() };
}

// ---------- files the phone page needs ----------

function app_root() {
  // the folder XR Animator's page was loaded from
  const p = decodeURIComponent(location.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.dirname(p);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
// only these folders are served, nothing else on the PC
const SERVED = [/^js\/multicam\/[\w.\-]+$/, /^js\/@mediapipe\/tasks\/[\w.\-]+\.task$/, /^js\/@mediapipe\/tasks\/tasks-vision\/[\w.\-]+$/, /^js\/@mediapipe\/tasks\/tasks-vision\/wasm\/[\w.\-]+$/];

// ---------- WebSocket (just what's needed) ----------

function ws_accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = { socket, open: true, onmessage: null, onclose: null, remote: socket.remoteAddress };
  let buf = Buffer.alloc(0), frags = [];
  conn.send = (obj) => {
    if (!conn.open) return;
    const data = Buffer.from(typeof obj == 'string' ? obj : JSON.stringify(obj), 'utf8');
    let head;
    if (data.length < 126) head = Buffer.from([0x81, data.length]);
    else if (data.length < 65536) { head = Buffer.from([0x81, 126, 0, 0]); head.writeUInt16BE(data.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
    socket.write(Buffer.concat([head, data]));
  };
  conn.close = () => { if (!conn.open) return; conn.open = false; try { socket.end(Buffer.from([0x88, 0])); } catch (e) {} };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) != 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) != 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len == 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len == 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 8 << 20) { conn.close(); return; }
      const mo = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[mo + (i & 3)];
      buf = buf.subarray(off + len);
      if (op == 0x8) { conn.close(); return; }
      if (op == 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op == 0xa) continue;
      frags.push(payload);
      if (!fin) continue;
      const msg = Buffer.concat(frags).toString('utf8');
      frags = [];
      try { conn.onmessage && conn.onmessage(JSON.parse(msg)); } catch (e) {}
    }
  });
  const gone = () => { if (conn.closed) return; conn.closed = true; conn.open = false; conn.onclose && conn.onclose(); };
  socket.on('close', gone);
  socket.on('error', gone);
  return conn;
}

// ---------- server ----------

let server = null, state = { running: false, port: 0, host: '', error: '', urls: [] };

function cert_store_path() { return path.join(app_root(), 'TEMP', 'multicam_phone_cert.json'); }

function get_cert(ips) {
  try {
    const c = JSON.parse(fs.readFileSync(cert_store_path(), 'utf8'));
    const age = Date.now() - Date.parse(c.created);
    if (ips.every(ip => c.ips.includes(ip)) && age < 300 * 86400000) return c;
  }
  catch (e) {}
  const c = make_cert(ips);
  try { fs.mkdirSync(path.dirname(cert_store_path()), { recursive: true }); fs.writeFileSync(cert_store_path(), JSON.stringify(c)); }
  catch (e) {}
  return c;
}

// opts: { port, host, token, on_connection(conn, hello) }
function start(opts) {
  if (server) return Promise.resolve(state);
  const ips = local_ips();
  const cert = get_cert(ips.length ? ips : ['127.0.0.1']);
  const root = app_root();
  return new Promise((resolve) => {
    server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      const [raw_path, query] = (req.url || '/').split('?');
      let p = decodeURIComponent(raw_path).replace(/^\/+/, '');
      // the short link in the QR code -> the phone page (so its own files load next to it)
      if (!p || p == 'phone') { res.writeHead(302, { Location: '/js/multicam/phone.html' + (query ? '?' + query : '') }); res.end(); return; }
      if (p.includes('..') || !SERVED.some(re => re.test(p))) { res.writeHead(404); res.end('Not found'); return; }
      fs.readFile(path.join(root, p), (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': p.endsWith('.task') || p.endsWith('.wasm') ? 'max-age=86400' : 'no-cache' });
        res.end(data);
      });
    });
    server.on('upgrade', (req, socket) => {
      const u = new URL(req.url, 'https://x');
      if (u.pathname != '/ws' || u.searchParams.get('k') != opts.token) { socket.destroy(); return; }
      const conn = ws_accept(req, socket);
      // the first message must be the phone's hello
      conn.onmessage = (m) => {
        if (m.type != 'hello' || !m.id) { conn.close(); return; }
        conn.onmessage = null;
        opts.on_connection(conn, m);
      };
    });
    server.on('error', (e) => { state.error = e.message; state.running = false; server = null; resolve(state); });
    server.listen(opts.port, opts.host || '0.0.0.0', () => {
      state = { running: true, port: opts.port, host: opts.host || '0.0.0.0', error: '',
        urls: (opts.host && opts.host != '0.0.0.0' ? [opts.host] : ips.filter(ip => ip != '127.0.0.1')).map(ip => `https://${ip}:${opts.port}/?k=${opts.token}`) };
      resolve(state);
    });
  });
}

function stop() {
  if (!server) return;
  try { server.close(); } catch (e) {}
  server = null;
  state = { running: false, port: 0, host: '', error: '', urls: [] };
}

window.MC_remote_server = { available: true, start, stop, get state() { return state; }, _make_cert: make_cert, _local_ips: local_ips };

})();
