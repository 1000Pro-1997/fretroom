const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
  console.error('macOS packaging needs sips and iconutil, so it only runs on a Mac.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const arch = process.argv[2] || process.arch;
if (arch !== 'arm64' && arch !== 'x64') {
  console.error(`Unsupported architecture "${arch}". Use arm64 or x64.`);
  process.exit(1);
}

function run(command, args, stdio = 'inherit') {
  const result = spawnSync(command, args, { cwd: root, stdio });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${command} failed with exit code ${result.status}`);
  }
}

// The .icns is generated from build/icon.png instead of being committed.
const png = path.join(root, 'build', 'icon.png');
const icns = path.join(root, 'build', 'icon.icns');
if (!fs.existsSync(icns) || fs.statSync(icns).mtimeMs < fs.statSync(png).mtimeMs) {
  const iconset = path.join(root, 'build', 'fretroom.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
        const pixels = String(size * scale);
        run('sips', ['-z', pixels, pixels, png, '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`)], ['ignore', 'ignore', 'inherit']);
      }
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}

run(process.execPath, [
  path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--mac', 'dmg', 'zip', `--${arch}`, '--publish', 'never',
]);
