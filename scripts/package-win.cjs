const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
// Building inside Desktop can prevent Electron's temporary directory rename on Windows.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fretroom-build-'));
const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [
  builder, '--win', 'portable', '--publish', 'never',
  `--config.directories.output=${staging}`,
], { cwd: root, stdio: 'inherit' });

try {
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`Packaging failed with exit code ${result.status}`);
  }
  const output = path.join(root, 'release');
  fs.mkdirSync(output, { recursive: true });
  const executable = path.join(output, 'fretroom.exe');
  fs.copyFileSync(path.join(staging, `fretroom ${version}.exe`), executable);
  console.log(`Created ${executable}`);
} finally {
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove temporary package files: ${error.message}`);
  }
}
