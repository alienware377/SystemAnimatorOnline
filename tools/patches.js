// The hook points the multi-camera add-on needs in XR Animator's own files.
// One list, used by tools/apply_patches.js (this repo) and by the installer
// (via dist/.../patches.json), so both always patch the same way.
//
// anchor: exact text that must appear exactly once ("\n" = the file's own line ending)
// where:  'after' or 'before' the anchor
// insert: text to add

const SCRIPTS = ['mc_geometry.js', 'mc_fuse.js', 'mc_face.js', 'mc_tongue.js', 'mc_qr.js', 'mc_remote_server.js', 'mc_main.js', 'mc_view.js']
  .map(f => `<script src="js/multicam/${f}"></script>`).join('\n');

module.exports = [
  {
    file: 'js/SA_system_emulation.min.js',
    what: 'pose result hook',
    anchor: 'return function(e){var ye=typeof e.data=="string"&&e.data.charAt(0)==="{"?JSON.parse(e.data):e.data;',
    where: 'after',
    insert: 'if(window.MC_multicam&&ye&&typeof ye==="object")ye=MC_multicam.process(ye)||ye;',
  },
  {
    file: 'js/SA_system_emulation.min.js',
    what: 'avatar position hook',
    // XR Animator's hip position: a ray through the hips in camera 1's picture times a guessed distance
    anchor: 'C.lerp(u.multiplyScalar(-h/u.z).add(z),1-m)}',
    where: 'after',
    insert: 'if(window.MC_multicam){const _mc=MC_multicam.hip_depth_scale(C);if(_mc)C.multiplyScalar(_mc)}',
  },
  {
    file: 'js/SA_system_emulation.min.js',
    what: 'face (ARKit) hook',
    anchor: 'V[Ge["mouthPucker"]].score=Math.pow(Math.max(V[Ge["mouthPucker"]].score-G,0)/(1-G),2);',
    where: 'after',
    insert: 'window.MC_face&&MC_face.on_arkit(V);',
  },
  {
    file: 'MMD.js/MMD_SA.js',
    what: 'avatar expression hook',
    anchor: 'for (const name in blendshape_weight) {\n//if (name == name_blink) {DEBUG_show(Date.now())} else\n  expressionManager.setValue(name, blendshape_weight[name])\n}',
    where: 'before',
    insert: 'if (window.MC_face) MC_face.local_weights(blendshape_weight, expressionManager);\n',
  },
  {
    file: 'MMD.js/MMD_SA.js',
    what: 'VMC blendshape hook',
    anchor: '  let tracker_msgs = [];\n  let tracker_index = 0;',
    where: 'before',
    insert: '  if (window.MC_face) MC_face.vmc_morphs(morph_msgs);\n',
  },
  ...['SystemAnimator_webkit.html', 'XR_Animator.html'].map(file => ({
    file,
    what: 'script tags',
    anchor: '<script type="text/javascript" language="javascript" src="js/core_extra.js"></script>',
    where: 'after',
    insert: '\n' + SCRIPTS,
    optional: file == 'XR_Animator.html',
  })),
];
