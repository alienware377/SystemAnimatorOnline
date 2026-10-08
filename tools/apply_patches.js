// Applies tools/patches.js to an XR Animator folder (default: this repo).
// Files are first restored from git's original (or a .multicam-backup), so
// running it again always gives the same result.
// Run: node tools/apply_patches.js [folder]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PATCHES = require('./patches.js');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const ORIGINAL_COMMIT = '53c20eb';   // upstream v0.35.0

function original(file) {
  const bak = path.join(root, file + '.multicam-backup');
  if (fs.existsSync(bak)) return fs.readFileSync(bak, 'utf8');
  // check the original out so it gets the working copy's own line endings
  try {
    execFileSync('git', ['-C', root, 'checkout', ORIGINAL_COMMIT, '--', file], { stdio: 'ignore' });
    // checkout also stages the original; put the index back so commits aren't silently reverted
    execFileSync('git', ['-C', root, 'reset', '-q', '--', file], { stdio: 'ignore' });
  }
  catch (e) {}
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const by_file = {};
for (const p of PATCHES) (by_file[p.file] = by_file[p.file] || []).push(p);

for (const file in by_file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.log('skip (missing)', file); continue; }
  let s = original(file);
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  for (const p of by_file[file]) {
    const anchor = p.anchor.replace(/\n/g, eol), insert = p.insert.replace(/\n/g, eol);
    const n = s.split(anchor).length - 1;
    if (n != 1) {
      if (p.optional) { console.log(`skip ${p.what} in ${file}`); continue; }
      throw new Error(`${file}: anchor for "${p.what}" found ${n} times`);
    }
    s = s.replace(anchor, (p.where == 'after') ? anchor + insert : insert + anchor);
    console.log(`patched ${p.what} in ${file}`);
  }
  fs.writeFileSync(full, s, 'utf8');
}
