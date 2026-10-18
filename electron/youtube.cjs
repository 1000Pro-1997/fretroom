// Downloads the audio track of a YouTube video with yt-dlp (fetched on first
// use) and stores transcribed scores. Audio is cached per video id.
const { app, net } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const maxSeconds = 15 * 60;

const binFolder = () => path.join(app.getPath('userData'), 'bin');
const audioFolder = () => path.join(app.getPath('userData'), 'youtube-audio');
const transcriptionFolder = () => path.join(app.getPath('userData'), 'transcriptions');

function videoId(url) {
  let parsed;
  try { parsed = new URL(String(url).trim()); } catch { throw new Error('유튜브 영상 링크를 확인해 주세요.'); }
  const host = parsed.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = parsed.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = parsed.searchParams.get('v') || /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(parsed.pathname)?.[1] || null;
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('유튜브 영상 링크를 확인해 주세요.');
  return id;
}

async function ensureYtDlp(progress) {
  const executable = path.join(binFolder(), 'yt-dlp.exe');
  try {
    if ((await fs.stat(executable)).size > 1e6) return executable;
  } catch {}
  progress('tool', 0);
  await fs.mkdir(binFolder(), { recursive: true });
  const response = await net.fetch(ytDlpUrl);
  if (!response.ok || !response.body) throw new Error(`유튜브 다운로드 도구(yt-dlp)를 받지 못했습니다 (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) progress('tool', received / total);
  }
  const partial = `${executable}.download`;
  await fs.writeFile(partial, Buffer.concat(chunks));
  await fs.rename(partial, executable);
  return executable;
}

function run(executable, args, onLine) {
  return new Promise((resolve, reject) => {
    // yt-dlp needs a JavaScript runtime for YouTube; Electron itself serves as Node.
    const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const lines = [];
    let pending = '';
    const consume = (chunk) => {
      pending += chunk.toString('utf8');
      const parts = pending.split(/\r?\n/);
      pending = parts.pop();
      for (const line of parts) { lines.push(line); onLine?.(line); }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending) lines.push(pending);
      resolve({ code, lines });
    });
  });
}

async function cached(id) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(audioFolder(), `${id}.json`), 'utf8'));
    return { id, title: meta.title, bytes: await fs.readFile(path.join(audioFolder(), meta.file)) };
  } catch {
    return null;
  }
}

async function download(executable, id, work, progress) {
  const args = [
    // --encoding: otherwise yt-dlp prints titles in the Windows console code page and Korean breaks.
    '--encoding', 'utf-8', '--no-playlist', '--newline', '--no-warnings', '--js-runtimes', `node:${process.execPath}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--match-filter', `duration <= ${maxSeconds}`,
    '-o', path.join(work, `${id}.%(ext)s`),
    '--print', '%(title)s', '--print', 'after_move:filepath', '--no-simulate',
    '--', `https://www.youtube.com/watch?v=${id}`,
  ];
  const { code, lines } = await run(executable, args, (line) => {
    const percent = /^\[download\]\s+([\d.]+)%/.exec(line);
    if (percent) progress('download', Number(percent[1]) / 100);
  });
  const printed = lines.filter((line) => line && !line.startsWith('['));
  const file = printed.at(-1);
  if (code === 0 && file && path.dirname(path.resolve(file)) === path.resolve(work)) {
    return { title: printed.length > 1 ? printed[0] : id, file };
  }
  if (lines.some((line) => /does not pass filter/.test(line))) throw new Error('15분 이하의 영상만 변환할 수 있습니다.');
  const error = lines.filter((line) => line.startsWith('ERROR')).at(-1);
  return { error: error ? error.replace(/^ERROR:\s*/, '') : `yt-dlp 종료 코드 ${code}` };
}

async function downloadAudio(url, progress) {
  const id = videoId(url);
  const hit = await cached(id);
  if (hit) return hit;
  const executable = await ensureYtDlp(progress);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fretroom-yt-'));
  try {
    progress('download', 0);
    let result = await download(executable, id, work, progress);
    if (result.error) {
      // YouTube changes often break old yt-dlp builds; update once and retry.
      progress('tool', 0);
      await run(executable, ['-U']);
      result = await download(executable, id, work, progress);
      if (result.error) throw new Error(`유튜브 소리를 받지 못했습니다: ${result.error}`);
    }
    await fs.mkdir(audioFolder(), { recursive: true });
    const name = `${id}${path.extname(result.file)}`;
    await fs.copyFile(result.file, path.join(audioFolder(), name));
    await fs.writeFile(path.join(audioFolder(), `${id}.json`), JSON.stringify({ title: result.title, file: name }), 'utf8');
    return { id, title: result.title, bytes: await fs.readFile(path.join(audioFolder(), name)) };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function saveTranscription(id, title, xml) {
  videoId(`https://youtu.be/${id}`);
  if (typeof xml !== 'string' || !xml.startsWith('<?xml')) throw new Error('Invalid transcription');
  const base = String(title || id).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || id;
  await fs.mkdir(transcriptionFolder(), { recursive: true });
  const filename = path.join(transcriptionFolder(), `${base} [${id}].musicxml`);
  await fs.writeFile(filename, xml, 'utf8');
  return filename;
}

module.exports = { downloadAudio, saveTranscription };
