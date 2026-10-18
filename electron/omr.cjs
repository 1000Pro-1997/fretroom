// Optical music recognition of PDF/image scores through Audiveris.
// Windows extracts its installer on first use; macOS uses a separately installed Audiveris.app.
const { app, net } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const recognizedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp']);
const downloadUrl = 'https://github.com/Audiveris/audiveris/releases/latest';
const missingCode = 'AUDIVERIS_MISSING';
const maxInputBytes = 200 * 1024 * 1024;
const recognitionTimeout = 30 * 60 * 1000;
const version = '5.11.0';
const installerUrl = `https://github.com/Audiveris/audiveris/releases/download/${version}/Audiveris-${version}-windows-x86_64.msi`;
const installerHash = 'ac221b0d39a90e32b7f43dbf9f5d5a45ff8b5424076af21b65278955688dac71';
const installerSizeLimit = 100 * 1024 * 1024;
const installedFolder = () => path.join(app.getPath('userData'), 'tools', `Audiveris-${version}`);
const installedExecutable = () => path.join(installedFolder(), 'Audiveris', 'Audiveris.exe');
let installation;
const listeners = new Set();

const preferenceFile = () => path.join(app.getPath('userData'), 'audiveris.json');
const cacheFolder = () => path.join(app.getPath('userData'), 'omr-cache');

function isRecognizedName(name) {
  return recognizedExtensions.has(path.extname(name).toLowerCase());
}

async function isFile(filename) {
  try {
    const file = await fs.stat(filename);
    if (!file.isFile()) return false;
    if (process.platform === 'darwin') await fs.access(filename, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executablePath(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
    throw new Error('Audiveris 실행 파일을 선택해 주세요.');
  }
  if (process.platform === 'darwin') {
    const executable = filename.endsWith('.app') ? path.join(filename, 'Contents', 'MacOS', 'Audiveris') : filename;
    if (!/^audiveris$/i.test(path.basename(executable))) throw new Error('Audiveris.app을 선택해 주세요.');
    return executable;
  }
  if (path.extname(filename).toLowerCase() !== '.exe' || !/audiveris/i.test(path.basename(filename))) {
    throw new Error('Audiveris.exe 파일을 선택해 주세요.');
  }
  return filename;
}

async function savedExecutable() {
  try {
    const saved = JSON.parse(await fs.readFile(preferenceFile(), 'utf8')).path;
    const executable = executablePath(saved);
    return (await isFile(executable)) ? executable : null;
  } catch {
    return null;
  }
}

async function findAudiveris() {
  const saved = await savedExecutable();
  if (saved) return saved;
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Audiveris.app/Contents/MacOS/Audiveris',
      path.join(os.homedir(), 'Applications', 'Audiveris.app', 'Contents', 'MacOS', 'Audiveris'),
      '/opt/homebrew/bin/audiveris',
      '/usr/local/bin/audiveris',
      ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, 'audiveris')),
    ];
    for (const candidate of candidates) if (await isFile(candidate)) return candidate;
    return null;
  }
  if (await isFile(installedExecutable())) return installedExecutable();
  const env = process.env;
  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Audiveris', 'Audiveris.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Audiveris', 'Audiveris.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Audiveris', 'Audiveris.exe'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'apps', 'audiveris', 'current', 'Audiveris.exe'),
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, 'Audiveris.exe')),
  ].filter(Boolean);
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

async function rememberExecutable(filename) {
  const executable = executablePath(filename);
  if (!(await isFile(executable))) throw new Error('선택한 Audiveris 실행 파일을 찾을 수 없습니다.');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(preferenceFile(), JSON.stringify({ path: executable }), 'utf8');
  return executable;
}
async function downloadInstaller(destination, progress) {
  const response = await net.fetch(installerUrl);
  if (!response.ok || !response.body) throw new Error(`Audiveris 다운로드 실패 (HTTP ${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > installerSizeLimit) throw new Error('Audiveris 설치 파일 크기가 예상보다 큽니다.');
  const reader = response.body.getReader();
  const file = await fs.open(destination, 'w');
  const hash = createHash('sha256');
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > installerSizeLimit) throw new Error('Audiveris 설치 파일 크기가 예상보다 큽니다.');
      hash.update(value);
      await file.writeFile(value);
      if (total) progress('download', received / total);
    }
  } finally {
    await file.close();
    await reader.cancel().catch(() => {});
  }
  if (hash.digest('hex') !== installerHash) throw new Error('Audiveris 설치 파일 검증에 실패했습니다.');
}

function extractInstaller(installer, folder) {
  return new Promise((resolve, reject) => {
    // Administrative extraction copies the bundled Java runtime and executable
    // without installing system-wide or requesting administrator privileges.
    const child = spawn('msiexec.exe', ['/a', installer, '/qn', `TARGETDIR=${folder}`], { windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Audiveris 압축 해제 실패 (종료 코드 ${code})`)));
  });
}

async function ensureAudiveris(progress = () => {}) {
  const existing = await findAudiveris();
  if (process.platform === 'darwin' && !existing) {
    throw new Error('macOS에서는 Audiveris 자동 설치를 지원하지 않습니다. Audiveris.app을 설치하거나 설치 위치를 선택해 주세요.');
  }
  if (existing) return existing;
  listeners.add(progress);
  if (!installation) {
    installation = (async () => {
      if (process.platform !== 'win32') throw new Error('자동 설치는 Windows에서만 지원합니다.');
      const notify = (phase, fraction) => {
        for (const listener of listeners) listener(phase, fraction);
      };
      const tools = path.dirname(installedFolder());
      await fs.mkdir(tools, { recursive: true });
      const staging = path.join(tools, `audiveris-${randomUUID()}.tmp`);
      await fs.mkdir(staging);
      const installer = path.join(tools, `audiveris-${randomUUID()}.msi`);
      try {
        notify('download', 0);
        await downloadInstaller(installer, notify);
        notify('install', 0);
        await extractInstaller(installer, staging);
        const executable = path.join(staging, 'Audiveris', 'Audiveris.exe');
        if (!(await isFile(executable))) throw new Error('Audiveris 실행 파일을 설치 파일에서 찾지 못했습니다.');
        await fs.rename(staging, installedFolder());
        return installedExecutable();
      } finally {
        await fs.rm(installer, { force: true });
        await fs.rm(staging, { recursive: true, force: true });
      }
    })().finally(() => { installation = null; listeners.clear(); });
  }
  try { return await installation; }
  finally { listeners.delete(progress); }
}


function run(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout: recognitionTimeout, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error?.killed) reject(new Error('악보 인식 시간이 너무 오래 걸려 중단했습니다.'));
        else resolve({ code: error ? error.code : 0, output: `${stdout}\n${stderr}` });
      });
  });
}

async function listMusicXml(folder) {
  const found = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.mxl') {
      found.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  // score.mxl, or score.mvt1.mxl, score.mvt2.mxl … for multi-movement books.
  const movement = (filename) => Number(/\.mvt(\d+)\.mxl$/i.exec(filename)?.[1] ?? 0);
  return found.sort((a, b) => movement(a) - movement(b));
}

async function readCache(hash) {
  const folder = path.join(cacheFolder(), hash);
  try {
    const files = (await fs.readdir(folder)).filter((name) => name.endsWith('.mxl')).sort();
    if (!files.length) return null;
    return Promise.all(files.map((name) => fs.readFile(path.join(folder, name))));
  } catch {
    return null;
  }
}

async function writeCache(hash, movements) {
  const staging = path.join(cacheFolder(), `${hash}.${randomUUID()}.tmp`);
  await fs.mkdir(staging, { recursive: true });
  try {
    await Promise.all(movements.map((bytes, i) => fs.writeFile(path.join(staging, `${String(i + 1).padStart(3, '0')}.mxl`), bytes)));
    await fs.rename(staging, path.join(cacheFolder(), hash));
  } catch {
    // Another recognition of the same file finished first; its cache is equivalent.
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// Returns the recognized MusicXML movements (one Uint8Array per movement).
async function recognize(bytes, name, progress = () => {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('인식할 악보 데이터가 없습니다.');
  if (bytes.length > maxInputBytes) throw new Error('파일이 너무 큽니다 (최대 200MB).');
  if (!isRecognizedName(name)) throw new Error('PDF 또는 이미지 악보만 인식할 수 있습니다.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const cached = await readCache(hash);
  if (cached) return cached;
  let executable;
  try { executable = await ensureAudiveris(progress); }
  catch (error) {
    const reason = process.platform === 'darwin' ? 'Audiveris를 찾지 못했습니다' : '자동 설치 실패';
    throw new Error(`${missingCode}: ${reason}: ${error.message}`);
  }
  progress('recognize', 0);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fretroom-omr-'));
  try {
    // An ASCII file name avoids code page problems inside the Java runtime.
    const input = path.join(work, `score${path.extname(name).toLowerCase()}`);
    const output = path.join(work, 'out');
    await fs.writeFile(input, bytes);
    await fs.mkdir(output);
    const { code, output: log } = await run(executable, ['-batch', '-export', '-output', output, '--', input]);
    const files = await listMusicXml(output);
    if (!files.length) {
      const detail = log.split(/\r?\n/).filter((line) => /error|exception|warn/i.test(line)).slice(-3).join(' ').trim();
      throw new Error(`악보를 인식하지 못했습니다${code ? ` (종료 코드 ${code})` : ''}. 선명한 인쇄 악보인지 확인해 주세요.${detail ? ` ${detail}` : ''}`);
    }
    const movements = await Promise.all(files.map((file) => fs.readFile(file)));
    await writeCache(hash, movements);
    return movements;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

module.exports = { downloadUrl, ensureAudiveris, findAudiveris, isRecognizedName, recognize, recognizedExtensions, rememberExecutable };
