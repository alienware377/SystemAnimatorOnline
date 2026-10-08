// Face blendshape mapping for XR Animator
//
// Takes XR Animator's ARKit-style face values (MediaPipe gives 51 of Apple's 52;
// tongueOut can't be tracked) and lets you drive ANY blendshape names with them:
// ARKit / Perfect Sync, VRM 0 + VRM 1 presets, MMD morphs, or your own names.
// Names are matched automatically; every match can be changed by hand, and each
// blendshape has VNyan-style tuning (strength, input range, curve, smoothing).
//
// The results go out over VMC (that's what VNyan uses) and, for names the
// avatar loaded in XR Animator has, onto that avatar too.
//
// Hooks (added by the installer):
// - SA_system_emulation.min.js, face handler:  MC_face.on_arkit(categories)
// - MMD_SA.js, before expressions are applied: MC_face.local_weights(blendshape_weight, expressionManager)
// - MMD_SA.js, VMC sender:                     MC_face.vmc_morphs(morph_msgs)

(function () {

'use strict';

const STORE_KEY = 'XRA_multicam_face_v1';

// MediaPipe's 51 + Apple's tongueOut
const ARKIT = ['browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight','cheekPuff','cheekSquintLeft','cheekSquintRight',
  'eyeBlinkLeft','eyeBlinkRight','eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight','eyeLookUpLeft','eyeLookUpRight',
  'eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight','jawForward','jawLeft','jawOpen','jawRight','mouthClose','mouthDimpleLeft','mouthDimpleRight',
  'mouthFrownLeft','mouthFrownRight','mouthFunnel','mouthLeft','mouthLowerDownLeft','mouthLowerDownRight','mouthPressLeft','mouthPressRight','mouthPucker','mouthRight',
  'mouthRollLower','mouthRollUpper','mouthShrugLower','mouthShrugUpper','mouthSmileLeft','mouthSmileRight','mouthStretchLeft','mouthStretchRight',
  'mouthUpperUpLeft','mouthUpperUpRight','noseSneerLeft','noseSneerRight','tongueOut'];
const UNTRACKED = new Set(['tongueOut']);

// combined sources, built from the ARKit values (names start with ~)
const avg = (...a) => a.reduce((s, x) => s + x, 0) / a.length;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const DERIVED = {
  '~aa': (k) => clamp01(k.jawOpen * (1 - 0.6 * Math.max(k.mouthPucker, k.mouthFunnel))),
  '~ih': (k) => clamp01((avg(k.mouthStretchLeft, k.mouthStretchRight) * 1.2 + avg(k.mouthSmileLeft, k.mouthSmileRight) * 0.4) * (1 - 0.6 * k.jawOpen)),
  '~ou': (k) => clamp01(k.mouthPucker),
  '~ee': (k) => clamp01((avg(k.mouthStretchLeft, k.mouthStretchRight) + 0.4 * k.jawOpen) * (1 - k.mouthPucker)),
  '~oh': (k) => clamp01(k.mouthFunnel),
  '~blink': (k) => Math.min(k.eyeBlinkLeft, k.eyeBlinkRight),
  '~blinkLeft': (k) => k.eyeBlinkLeft,
  '~blinkRight': (k) => k.eyeBlinkRight,
  '~happy': (k) => avg(k.mouthSmileLeft, k.mouthSmileRight),
  '~angry': (k) => avg(k.browDownLeft, k.browDownRight),
  '~sad': (k) => clamp01(avg(k.browInnerUp, avg(k.mouthFrownLeft, k.mouthFrownRight)) * 1.3),
  '~relaxed': (k) => clamp01(avg(k.mouthSmileLeft, k.mouthSmileRight) * avg(k.eyeSquintLeft, k.eyeSquintRight) * 2),
  '~surprised': (k) => clamp01(avg(avg(k.browOuterUpLeft, k.browOuterUpRight), avg(k.eyeWideLeft, k.eyeWideRight)) * 1.3),
  '~squint': (k) => avg(k.eyeSquintLeft, k.eyeSquintRight),
  '~browUp': (k) => avg(k.browInnerUp, k.browOuterUpLeft, k.browOuterUpRight),
  '~browDown': (k) => avg(k.browDownLeft, k.browDownRight),
  '~lookUp': (k) => avg(k.eyeLookUpLeft, k.eyeLookUpRight),
  '~lookDown': (k) => avg(k.eyeLookDownLeft, k.eyeLookDownRight),
  '~lookLeft': (k) => avg(k.eyeLookOutLeft, k.eyeLookInRight),
  '~lookRight': (k) => avg(k.eyeLookInLeft, k.eyeLookOutRight),
  '~neutral': () => 0,
};
const DERIVED_LABEL = {
  '~aa': 'vowel A', '~ih': 'vowel I', '~ou': 'vowel U', '~ee': 'vowel E', '~oh': 'vowel O',
  '~blink': 'blink (both)', '~blinkLeft': 'blink left', '~blinkRight': 'blink right',
  '~happy': 'happy / smile', '~angry': 'angry', '~sad': 'sad', '~relaxed': 'relaxed', '~surprised': 'surprised',
  '~squint': 'squint', '~browUp': 'brows up', '~browDown': 'brows down',
  '~lookUp': 'look up', '~lookDown': 'look down', '~lookLeft': 'look left', '~lookRight': 'look right', '~neutral': 'nothing (0)',
};

// name synonyms -> source, compared after normalize()
const SYNONYMS = {
  '~aa': ['a', 'aa', 'あ', 'vrcvaa', 'moutha', 'vowela', 'mtha'],
  '~ih': ['i', 'ih', 'い', 'vrcvih', 'mouthi', 'voweli', 'mthi'],
  '~ou': ['u', 'ou', 'う', 'vrcvou', 'mouthu', 'vowelu', 'mthu', 'ω'],
  '~ee': ['e', 'ee', 'え', 'vrcvee', 'mouthe', 'vowele', 'mthe'],
  '~oh': ['o', 'oh', 'お', 'vrcvoh', 'moutho', 'vowelo', 'mtho'],
  '~blink': ['blink', 'まばたき', 'eyeclose', 'eyesclosed', 'blinkboth', 'eyeblink', 'eyeclosed', 'close'],
  '~blinkLeft': ['blinkl', 'blinkleft', 'ウィンク', 'ウィンク2', 'ウィンク２', 'eyeclosel', 'eyeblinkl', 'winkl', 'winkleft'],
  '~blinkRight': ['blinkr', 'blinkright', 'ウィンク右', 'ウィンク2右', 'ウィンク２右', 'eyecloser', 'eyeblinkr', 'winkr', 'winkright'],
  '~happy': ['joy', 'happy', '笑い', 'にこり', 'smile', 'にやり', 'ハート'],
  '~angry': ['angry', '怒り', 'anger', 'mad'],
  '~sad': ['sorrow', 'sad', '困る', '悲しい', 'sadness'],
  '~relaxed': ['fun', 'relaxed', 'なごみ', 'relax'],
  '~surprised': ['surprised', 'surprise', 'びっくり', 'shock'],
  '~squint': ['じと目', 'squint', 'jitome'],
  '~browUp': ['上', '眉上', 'browup', 'browsup'],
  '~browDown': ['下', '眉下', '真面目', 'browdown', 'browsdown', 'serious'],
  '~lookUp': ['lookup'], '~lookDown': ['lookdown'], '~lookLeft': ['lookleft'], '~lookRight': ['lookright'],
  '~neutral': ['neutral'],
  'tongueOut': ['tongueout', 'ぺろっ', 'tongue'],
};

const PACKS = {
  arkit: { label: 'ARKit / Perfect Sync (52)', names: (style) => ARKIT.map(n => style == 'lower' ? n : n.charAt(0).toUpperCase() + n.slice(1)) },
  vrm0: { label: 'VRM 0 presets', names: () => ['A', 'I', 'U', 'E', 'O', 'Blink', 'Blink_L', 'Blink_R', 'Joy', 'Angry', 'Sorrow', 'Fun', 'LookUp', 'LookDown', 'LookLeft', 'LookRight', 'Neutral'] },
  vrm1: { label: 'VRM 1 presets', names: () => ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral'] },
  mmd: { label: 'MMD morphs', names: () => ['あ', 'い', 'う', 'え', 'お', 'まばたき', 'ウィンク', 'ウィンク右', '笑い', 'にこり', '怒り', '困る', '真面目', 'びっくり', 'じと目', 'にやり', '上', '下', 'ω', 'ぺろっ'] },
};

function normalize(name) {
  return String(name).toLowerCase()
    .replace(/^(blendshape\d*|blendshapes|bs|vrc)[._]/, '')
    .replace(/[\s_.\-:]/g, '');
}

const ARKIT_BY_NORM = {};
ARKIT.forEach(n => { ARKIT_BY_NORM[normalize(n)] = n; });
const SYN_BY_NORM = {};
for (const src in SYNONYMS) for (const s of SYNONYMS[src]) SYN_BY_NORM[normalize(s)] = src;

function auto_source(name) {
  const n = normalize(name);
  if (ARKIT_BY_NORM[n]) return ARKIT_BY_NORM[n];
  if (SYN_BY_NORM[n]) return SYN_BY_NORM[n];
  // "vrc.v_aa", "Mouth_A", "eye_blink_L" style leftovers
  const m = n.replace(/^(mouth|mth|vrcv|v)/, '');
  if (SYN_BY_NORM[m]) return SYN_BY_NORM[m];
  return null;
}

function source_label(src) {
  if (!src) return '(not matched)';
  if (src.startsWith('~')) return DERIVED_LABEL[src] || src;
  if (src.startsWith('xra:')) return 'XR Animator: ' + src.slice(4);
  return src + (UNTRACKED.has(src) ? ' (not tracked)' : '');
}

// ---------- settings ----------

function default_target(name, source) {
  return { name, source: source === undefined ? auto_source(name) : source, auto: source === undefined,
    enabled: true, strength: 1, in_min: 0, in_max: 1, curve: 1, smooth: 0 };
}

const settings = Object.assign({
  targets: [],
  mode: 'add',          // 'add': change / add to what XR Animator sends; 'only': send just these
  local: true,          // also show them on XR Animator's own avatar
  swap_lr: false,       // swap left/right on top of XR Animator's own convention
  arkit_style: 'upper', // 'upper' EyeBlinkLeft (most Perfect Sync avatars) or 'lower' eyeBlinkLeft
}, load());

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch (e) { return {}; }
}
let save_timer = 0;
function save() {
  clearTimeout(save_timer);
  save_timer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); }
    catch (e) {}
  }, 300);
}

// ---------- live data ----------

const arkit = {};         // latest ARKit values (lowerCamel names)
ARKIT.forEach(n => { arkit[n] = 0; });
let arkit_t = 0, arkit_fps = 0, arkit_n = 0, arkit_fps_t = 0;
let xra_weights = {};     // XR Animator's own values this frame
let local_names = [];     // expressions on XR Animator's avatar
const out = {};           // final values by target name
const smooth_state = {};

// XR Animator's face result: [{ categoryName, score }] (already calibrated by XR Animator)
function on_arkit(categories) {
  try {
    for (const c of categories) {
      let n = c.categoryName;
      if (!(n in arkit)) continue;
      // same left/right convention XR Animator uses for Perfect Sync avatars
      n = (n.indexOf('Left') != -1) ? n.replace('Left', 'Right') : n.replace('Right', 'Left');
      if (settings.swap_lr) n = (n.indexOf('Left') != -1) ? n.replace('Left', 'Right') : n.replace('Right', 'Left');
      arkit[n] = c.score;
    }
    const now = performance.now();
    arkit_t = now;
    arkit_n++;
    if (now - arkit_fps_t > 1000) { arkit_fps = arkit_n * 1000 / (now - arkit_fps_t); arkit_n = 0; arkit_fps_t = now; }
  }
  catch (e) {}
}

function source_value(src) {
  if (!src) return null;
  if (src.startsWith('~')) return DERIVED[src] ? DERIVED[src](arkit) : null;
  if (src.startsWith('xra:')) return xra_weights[src.slice(4)] ?? 0;
  if (src in arkit) return arkit[src];
  return null;
}

function adjust(t, x) {
  const lo = +t.in_min || 0, hi = (t.in_max == null) ? 1 : +t.in_max;
  x = (hi > lo) ? clamp01((x - lo) / (hi - lo)) : (x >= lo ? 1 : 0);
  if (t.curve && t.curve != 1) x = Math.pow(x, t.curve);
  x = clamp01(x * (t.strength == null ? 1 : +t.strength));
  const s = Math.min(0.98, Math.max(0, +t.smooth || 0));
  if (s > 0) {
    const prev = smooth_state[t.name] ?? x;
    x = prev + (x - prev) * (1 - s);
  }
  smooth_state[t.name] = x;
  return x;
}

let last_compute = 0;
function compute() {
  for (const k in out) delete out[k];
  const face_alive = performance.now() - arkit_t < 1000;
  for (const t of settings.targets) {
    if (!t.enabled || !t.source) continue;
    if (!face_alive && !t.source.startsWith('xra:')) continue;
    const v = source_value(t.source);
    if (v == null) continue;
    out[t.name] = adjust(t, v);
  }
  last_compute = performance.now();
}

// MMD_SA.js: XR Animator's expression values for its own avatar, right before they're applied
function local_weights(blendshape_weight, expressionManager) {
  try {
    xra_weights = Object.assign({}, blendshape_weight);
    if (expressionManager?.expressionMap) local_names = Object.keys(expressionManager.expressionMap);
    if (!settings.targets.length) return;
    compute();
    if (!settings.local) return;
    for (const name in out) {
      if (expressionManager?.expressionMap?.[name]) blendshape_weight[name] = out[name];
    }
  }
  catch (e) {}
}

// MMD_SA.js: the blendshape list about to be sent over VMC, as [name, value] pairs
function vmc_morphs(morph_msgs) {
  try {
    if (!settings.targets.length) { utf8_names(morph_msgs); return; }
    if (performance.now() - last_compute > 200) compute();
    if (settings.mode == 'only') morph_msgs.length = 0;
    const index = {};
    morph_msgs.forEach((m, i) => { index[m[0]] = i; });
    for (const name in out) {
      if (name in index) morph_msgs[index[name]][1] = out[name];
      else morph_msgs.push([name, out[name]]);
    }
    utf8_names(morph_msgs);
  }
  catch (e) {}
}

// osc-js writes strings one byte per character, so names like "ウィンク右" arrive
// as garbage. Hand it the UTF-8 bytes as characters instead, so they arrive intact.
function utf8_names(morph_msgs) {
  for (const m of morph_msgs) {
    const name = m[0];
    if (typeof name != 'string' || !/[^\x00-\x7f]/.test(name)) continue;
    let bin = '';
    for (const b of new TextEncoder().encode(name)) bin += String.fromCharCode(b);
    m[0] = bin;
  }
}

// ---------- editing helpers (used by the live view panel) ----------

function add_targets(names) {
  const have = new Set(settings.targets.map(t => t.name));
  let n = 0;
  for (const name of names) {
    if (!name || have.has(name)) continue;
    settings.targets.push(default_target(name));
    have.add(name);
    n++;
  }
  save();
  return n;
}

function add_pack(pack) {
  if (pack == 'avatar') return add_targets(local_names);
  return add_targets(PACKS[pack].names(settings.arkit_style));
}

function auto_match_all(only_unmatched) {
  let n = 0;
  for (const t of settings.targets) {
    if (only_unmatched && t.source) continue;
    const s = auto_source(t.name);
    if (s && s != t.source) { t.source = s; t.auto = true; n++; }
  }
  save();
  return n;
}

function remove_target(name) {
  settings.targets = settings.targets.filter(t => t.name != name);
  save();
}

function all_sources() {
  return [
    { group: 'ARKit (tracked)', items: ARKIT.map(n => ({ id: n, label: source_label(n) })) },
    { group: 'Combined', items: Object.keys(DERIVED).map(id => ({ id, label: DERIVED_LABEL[id] })) },
    { group: 'XR Animator\'s own values', items: Object.keys(xra_weights).map(n => ({ id: 'xra:' + n, label: n })) },
  ];
}

window.MC_face = {
  on_arkit, local_weights, vmc_morphs,
  settings, save, ARKIT, PACKS, DERIVED_LABEL, UNTRACKED,
  arkit, out, source_value, source_label, auto_source,
  add_targets, add_pack, auto_match_all, remove_target, all_sources, default_target,
  get local_names() { return local_names; },
  get arkit_fps() { return (performance.now() - arkit_t < 1000) ? arkit_fps : 0; },
  get face_alive() { return performance.now() - arkit_t < 1000; },
  export_json() { return JSON.stringify(settings, null, 1); },
  import_json(text) {
    const s = JSON.parse(text);
    if (!Array.isArray(s.targets)) throw new Error('not a face mapping file');
    Object.assign(settings, s);
    save();
  },
};

})();
