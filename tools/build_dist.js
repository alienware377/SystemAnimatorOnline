// Builds dist/XRA-MultiCam (installer + files) and dist/XRA-MultiCam.zip.
// Run: node tools/build_dist.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'XRA-MultiCam');
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'files', 'js', 'multicam'), { recursive: true });

const SHIP = ['mc_geometry.js', 'mc_calibrate.js', 'mc_fuse.js', 'mc_face.js', 'mc_tongue.js', 'mc_main.js', 'mc_view.js', 'mc_pose_worker.js', 'mc_calib_worker.js', 'mc_tongue_worker.js'];
for (const f of SHIP) {
  fs.copyFileSync(path.join(root, 'js', 'multicam', f), path.join(out, 'files', 'js', 'multicam', f));
}

// PowerShell 5.1 reads .ps1 without a BOM as ANSI: save it with one
const ps1 = fs.readFileSync(path.join(root, 'dist_src', 'install.ps1'), 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(out, 'install.ps1'), '\uFEFF' + ps1, 'utf8');
fs.writeFileSync(path.join(out, 'patches.json'), JSON.stringify(require('./patches.js'), null, 1), 'utf8');
for (const f of ['install.bat', 'uninstall.bat', 'README.txt']) {
  const s = fs.readFileSync(path.join(root, 'dist_src', f), 'utf8').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(out, f), s, 'utf8');
}

// no em/en dashes or other surprises in anything we ship
for (const f of ['install.ps1', 'install.bat', 'uninstall.bat', 'README.txt'].map(f => path.join(out, f))
  .concat(SHIP.map(f => path.join(out, 'files', 'js', 'multicam', f)))) {
  const s = fs.readFileSync(f, 'utf8');
  if (/[–—]/.test(s)) throw new Error('dash character in ' + f);
  if (f.endsWith('.ps1') && /[^\x00-\x7F]/.test(s.replace(/^\uFEFF/, ''))) throw new Error('non-ASCII in ' + f);
}

execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${out}' -DestinationPath '${path.join(root, 'dist', 'XRA-MultiCam.zip')}' -Force`]);
console.log('built', path.join(root, 'dist', 'XRA-MultiCam.zip'));
