// FluidR3 GM (148 MB) exceeds GitHub's file limit, so it lives on the
// repository's GitHub Release and is fetched by `npm install`.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const url = 'https://github.com/1000Pro-1997/fretroom/releases/download/soundfont-v1/FluidR3_GM.sf2';
const sha256 = '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0';
const target = path.join(__dirname, '..', 'public', 'soundfont', 'FluidR3_GM.sf2');

function hashOf(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  if (fs.existsSync(target) && await hashOf(target) === sha256) return;
  console.log(`Downloading FluidR3_GM.sf2 from ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const partial = `${target}.download`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  if (await hashOf(partial) !== sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error('FluidR3_GM.sf2 checksum mismatch');
  }
  fs.renameSync(partial, target);
}

main().catch((error) => {
  console.error(`Could not fetch the SoundFont: ${error.message}`);
  process.exit(1);
});
