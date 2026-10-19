// Tiny QR code encoder (byte mode, error correction level M, versions 1-10),
// enough for a "scan this with your phone" address. Follows ISO/IEC 18004.
// MC_qr.encode(text) -> { size, get(x, y) } ; MC_qr.draw(canvas, text, scale)

(function (root) {

'use strict';

// version -> [ec codewords per block, [[block count, data codewords per block], ...]] at level M
const EC_M = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// ---------- GF(256) / Reed-Solomon ----------
const EXP = new Array(512), LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

function rs_generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function rs_ec(data, n) {
  const g = rs_generator(n);
  const r = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = r[i];
    if (!c) continue;
    for (let j = 0; j < g.length; j++) r[i + j] ^= gmul(g[j], c);
  }
  return r.slice(data.length);
}

// ---------- data codewords ----------
function data_capacity(v) { return EC_M[v][1].reduce((s, [n, k]) => s + n * k, 0); }

function make_codewords(bytes) {
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= data_capacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error('text too long for a QR code here');
  const cap = data_capacity(version);
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  for (let i = 0; i < 4 && bits.length < cap * 8; i++) bits.push(0);   // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xEC; data.length < cap; pad ^= 0xEC ^ 0x11) data.push(pad);

  // split into blocks, add error correction, interleave
  const [ecn, groups] = EC_M[version];
  const blocks = [];
  let off = 0;
  for (const [count, k] of groups) {
    for (let i = 0; i < count; i++) { const d = data.slice(off, off + k); off += k; blocks.push({ d, e: rs_ec(d, ecn) }); }
  }
  const out = [];
  const maxk = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxk; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecn; i++) for (const b of blocks) out.push(b.e[i]);
  return { version, codewords: out };
}

// ---------- matrix ----------
function build(version, codewords, mask) {
  const n = 17 + 4 * version;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (x, y, v) => { m[y][x] = v ? 1 : 0; fn[y][x] = true; };

  // finder patterns + separators
  for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const x = fx + dx, y = fy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const on = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
        (dx == 0 || dx == 6 || dy == 0 || dy == 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(x, y, on);
    }
  }
  // timing
  for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 == 0); set(6, i, i % 2 == 0); }
  // alignment
  const al = ALIGN[version];
  al.forEach((ay, i) => al.forEach((ax, j) => {
    // skip only the three that would sit on a finder pattern (ones on the timing lines stay)
    const last = al.length - 1;
    if ((i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
  }));
  // dark module + reserve format areas
  set(8, n - 8, 1);
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(i, 8, 0); if (!fn[i][8]) set(8, i, 0); }
  for (let i = 0; i < 8; i++) { if (!fn[8][n - 1 - i]) set(n - 1 - i, 8, 0); if (!fn[n - 1 - i][8]) set(8, n - 1 - i, 0); }
  // version info (v7+)
  if (version >= 7) {
    let vr = version;
    for (let i = 0; i < 12; i++) vr = (vr << 1) ^ ((vr >>> 11) * 0x1f25);
    const vb = (version << 12) | vr;
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1, a = Math.floor(i / 3), b = i % 3 + n - 11;
      set(a, b, bit); set(b, a, bit);
    }
  }

  // data, zigzag from the bottom right
  let bit_i = 0;
  const total_bits = codewords.length * 8;
  const mask_fn = [
    (x, y) => (x + y) % 2 == 0, (x, y) => y % 2 == 0, (x, y) => x % 3 == 0, (x, y) => (x + y) % 3 == 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 == 0, (x, y) => (x * y) % 2 + (x * y) % 3 == 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 == 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 == 0,
  ][mask];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col == 6) col--;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (const x of [col, col - 1]) {
        if (fn[y][x]) continue;
        let v = 0;
        if (bit_i < total_bits) v = (codewords[bit_i >> 3] >> (7 - (bit_i & 7))) & 1;
        bit_i++;
        if (mask_fn(x, y)) v ^= 1;
        m[y][x] = v;
      }
    }
    up = !up;
  }

  // format info: level M = 0b00, two copies
  const data5 = (0b00 << 3) | mask;
  let rem = data5;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fmt = ((data5 << 10) | rem) ^ 0x5412;
  const fb = (i) => (fmt >>> i) & 1;
  for (let i = 0; i <= 5; i++) m[i][8] = fb(i);
  m[7][8] = fb(6);
  m[8][8] = fb(7);
  m[8][7] = fb(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = fb(i);
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = fb(i);
  for (let i = 8; i < 15; i++) m[n - 15 + i][8] = fb(i);
  m[n - 8][8] = 1;   // dark module
  return m;
}

// standard mask penalty (N1..N4)
function penalty(m) {
  const n = m.length;
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass ? m[b][a] : m[a][b], prev = pass ? m[b - 1][a] : m[a][b - 1];
        if (cur == prev) { run++; if (b == n - 1 && run >= 5) p += run - 2; }
        else { if (run >= 5) p += run - 2; run = 1; }
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c == m[y][x + 1] && c == m[y + 1][x] && c == m[y + 1][x + 1]) p += 3;
  }
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let a = 0; a < n; a++) for (let b = 0; b <= n - 11; b++) {
    for (const pt of [pat, pat2]) {
      let h = true, v = true;
      for (let k = 0; k < 11; k++) { if (m[a][b + k] != pt[k]) h = false; if (m[b + k][a] != pt[k]) v = false; }
      if (h) p += 40;
      if (v) p += 40;
    }
  }
  let dark = 0;
  for (const row of m) for (const c of row) dark += c;
  p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  return p;
}

function encode(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const { version, codewords } = make_codewords(bytes);
  let best = null, best_p = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, codewords, mask);
    const p = penalty(m);
    if (p < best_p) { best_p = p; best = m; }
  }
  return { size: best.length, version, get: (x, y) => best[y][x], matrix: best };
}

function draw(canvas, text, scale = 6, quiet = 4) {
  const q = encode(text);
  const px = (q.size + quiet * 2) * scale;
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return q;
}

const API = { encode, draw };
if (typeof module === 'object' && module.exports) module.exports = API;
if (typeof self !== 'undefined') self.MC_qr = API;

})(typeof self !== 'undefined' ? self : this);
