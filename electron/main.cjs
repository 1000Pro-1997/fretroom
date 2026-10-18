const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const omr = require('./omr.cjs');
const youtube = require('./youtube.cjs');
const updater = require('./updater.cjs');

const origin = 'fretroom://app';
const dist = path.join(__dirname, '..', 'dist');

const scoreExtensions = new Set(['.gp', '.gp3', '.gp4', '.gp5', '.gp7', '.gp8', '.gpx', '.musicxml', '.xml', '.mxl', ...omr.recognizedExtensions]);
const folderPreference = () => path.join(app.getPath('userData'), 'selected-folder.json');
const recentPreference = () => path.join(app.getPath('userData'), 'recent-scores.json');
let recentWrites = Promise.resolve();

function withRecentWrite(action) {
  const result = recentWrites.then(action);
  recentWrites = result.catch(() => {});
  return result;
}

async function loadRecent() {
  let data;
  try {
    data = await fs.readFile(recentPreference(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Cannot read recent scores: ${error.message}`, { cause: error });
  }
  try {
    const scores = JSON.parse(data).scores;
    if (!Array.isArray(scores) || !scores.every((entry) =>
      entry && typeof entry.id === 'string' && entry.id &&
      typeof entry.path === 'string' && path.isAbsolute(entry.path) &&
      (entry.playedAt === undefined || Number.isFinite(entry.playedAt)))) {
      throw new Error('Invalid recent score records');
    }
    for (const entry of scores) validateScoreName(path.basename(entry.path));
    return scores;
  } catch (error) {
    throw new Error(`The recent scores preference is invalid: ${error.message}`, { cause: error });
  }
}

async function saveRecent(scores) {
  const temporary = `${recentPreference()}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({ scores }), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, recentPreference());
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`Cannot save recent scores: ${error.message}`, { cause: error });
  }
}

function sameFilePath(first, second) {
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

// Every opened score is registered so it can be reopened by id; playedAt marks the ones actually played.
async function rememberScore(filename) {
  return withRecentWrite(async () => {
    const scores = await loadRecent();
    const previous = scores.find((entry) => sameFilePath(entry.path, filename));
    if (previous) return previous.id;
    const id = randomUUID();
    await saveRecent([{ id, path: filename }, ...scores]);
    return id;
  });
}

async function readScore(filename) {
  const file = await fs.lstat(filename);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Not a regular score file');
  const handle = await fs.open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino) {
      throw new Error('Score file changed while opening');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function validateBaseName(base) {
  if (typeof base !== 'string' || !base || base === '.' || base === '..' ||
      base !== base.trim() || base.endsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(base) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) {
    throw new Error('Invalid score filename base');
  }
}

async function savedFolder() {
  let data;
  try {
    data = await fs.readFile(folderPreference(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read the selected folder preference: ${error.message}`, { cause: error });
  }
  try {
    const folder = JSON.parse(data).folder;
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Invalid folder path');
    return folder;
  } catch (error) {
    throw new Error(`The selected folder preference is invalid: ${error.message}`, { cause: error });
  }
}

async function ensureScoreFolder(folder) {
  const directory = await fs.lstat(folder);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('The selected folder is no longer a directory');
  }
}

async function listScores(folder) {
  try {
    await ensureScoreFolder(folder);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && scoreExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => ({ name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  } catch (error) {
    throw new Error(`Cannot list scores in the selected folder "${folder}": ${error.message}`, { cause: error });
  }
}

function validateScoreName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\') || name.includes(':') || name.includes('\0') ||
      !scoreExtensions.has(path.extname(name).toLowerCase())) {
    throw new Error('Invalid score filename');
  }
}

async function renameScoreFile(scores, oldPath, newBase) {
  const name = `${newBase}${path.extname(oldPath)}`;
  const filename = path.join(path.dirname(oldPath), name);
  const file = await fs.lstat(oldPath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Not a regular score file');
  const entry = scores.find((score) => sameFilePath(score.path, oldPath));
  if (sameFilePath(oldPath, filename)) return { id: entry?.id || '', name: path.basename(oldPath) };
  // Hard-link creation fails if the destination exists, unlike rename(), which can overwrite.
  await fs.link(oldPath, filename);
  try {
    await fs.unlink(oldPath);
  } catch (error) {
    await fs.unlink(filename).catch(() => {});
    throw error;
  }
  if (entry) {
    entry.path = filename;
    try {
      await saveRecent(scores);
    } catch (error) {
      // Restore the original name when saving the new recent path fails.
      try {
        await fs.link(filename, oldPath);
        await fs.unlink(filename);
      } catch (rollbackError) {
        throw new Error(`Renamed score but could not update recents or restore its name: ${error.message}; ${rollbackError.message}`, { cause: error });
      }
      throw error;
    }
  }
  return { id: entry?.id || '', name };
}

function trustedFrame(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith(`${origin}/`)) {
    throw new Error('Score library access is restricted to the application window');
  }
}


function omrProgress(event) {
  return (phase, fraction) => {
    if (!event.sender.isDestroyed()) event.sender.send('fretroom:omr-progress', { phase, fraction });
  };
}

function registerLibraryHandlers() {
  ipcMain.handle('fretroom:choose-folder', async (event) => {
    trustedFrame(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
      title: 'Choose a score folder',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return null;
    const folder = await fs.realpath(filePaths[0]);
    const files = await listScores(folder);
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(folderPreference(), JSON.stringify({ folder }), 'utf8');
    } catch (error) {
      throw new Error(`Cannot save the selected folder "${folder}": ${error.message}`, { cause: error });
    }
    return { folder, files };
  });

  ipcMain.handle('fretroom:list-folder', async (event) => {
    trustedFrame(event);
    const folder = await savedFolder();
    return { folder, files: folder ? await listScores(folder) : [] };
  });

  ipcMain.handle('fretroom:open-score', async (event, name) => {
    trustedFrame(event);
    validateScoreName(name);
    const folder = await savedFolder();
    if (!folder) throw new Error('Choose a score folder before opening a score');
    try {
      await ensureScoreFolder(folder);
    } catch (error) {
      throw new Error(`Cannot open score in the selected folder "${folder}": ${error.message}`, { cause: error });
    }
    const filename = path.join(folder, name);
    try {
      const bytes = await readScore(filename);
      const id = await rememberScore(filename);
      return { name, id, bytes };
    } catch (error) {
      throw new Error(`Cannot open score "${name}" in the selected folder: ${error.message}`, { cause: error });
    }
  });

  ipcMain.handle('fretroom:choose-score', async (event) => {
    trustedFrame(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
      title: 'Choose a score',
      properties: ['openFile'],
      filters: [{ name: 'Scores', extensions: [...scoreExtensions].map((extension) => extension.slice(1)) }],
    });
    if (canceled || !filePaths.length) return null;
    const filename = path.resolve(filePaths[0]);
    const name = path.basename(filename);
    validateScoreName(name);
    const id = await rememberScore(filename);
    return { name, id, bytes: await readScore(filename) };
  });

  ipcMain.handle('fretroom:recent-scores', async (event) => {
    trustedFrame(event);
    await recentWrites;
    return (await loadRecent()).map(({ id, path: filename, playedAt }) => ({ id, name: path.basename(filename), path: filename, playedAt: playedAt ?? 0 }));
  });

  ipcMain.handle('fretroom:open-recent', async (event, id) => {
    trustedFrame(event);
    if (typeof id !== 'string') throw new Error('Invalid recent score id');
    await recentWrites;
    const entry = (await loadRecent()).find((score) => score.id === id);
    if (!entry) throw new Error('Recent score not found');
    const name = path.basename(entry.path);
    return { id, name, bytes: await readScore(entry.path) };
  });

  ipcMain.handle('fretroom:mark-played', async (event, id) => {
    trustedFrame(event);
    if (typeof id !== 'string') throw new Error('Invalid recent score id');
    return withRecentWrite(async () => {
      const scores = await loadRecent();
      const entry = scores.find((score) => score.id === id);
      if (!entry) throw new Error('Recent score not found');
      entry.playedAt = Date.now();
      await saveRecent(scores);
    });
  });

  ipcMain.handle('fretroom:rename-recent', async (event, id, newBase) => {
    trustedFrame(event);
    if (typeof id !== 'string') throw new Error('Invalid recent score id');
    validateBaseName(newBase);
    return withRecentWrite(async () => {
      const scores = await loadRecent();
      const entry = scores.find((score) => score.id === id);
      if (!entry) throw new Error('Recent score not found');
      return renameScoreFile(scores, entry.path, newBase);
    });
  });
  ipcMain.handle('fretroom:rename-score', async (event, name, newBase) => {
    trustedFrame(event);
    validateScoreName(name);
    validateBaseName(newBase);
    const folder = await savedFolder();
    if (!folder) throw new Error('Choose a score folder before renaming a score');
    await ensureScoreFolder(folder);
    return withRecentWrite(async () => renameScoreFile(await loadRecent(), path.join(folder, name), newBase));
  });
  ipcMain.handle('fretroom:save-edited', async (event, suggestedBase, bytes) => {
    trustedFrame(event);
    validateBaseName(suggestedBase);
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Invalid score data');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const folder = await savedFolder();
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Save edited score as Guitar Pro 7+',
      defaultPath: path.join(folder || app.getPath('documents'), `${suggestedBase}-edited.gp`),
      filters: [{ name: 'Guitar Pro 7+', extensions: ['gp'] }],
    });
    if (canceled || !filePath) return null;
    if (path.extname(filePath).toLowerCase() !== '.gp') throw new Error('Save the score as a .gp file');
    await fs.writeFile(filePath, bytes);
    await rememberScore(filePath);
    return filePath;
  });
  ipcMain.handle('fretroom:recognize-score', async (event, name, bytes) => {
    trustedFrame(event);
    if (typeof name !== 'string' || !omr.isRecognizedName(name)) throw new Error('PDF 또는 이미지 악보만 인식할 수 있습니다.');
    const movements = await omr.recognize(bytes, name, omrProgress(event));
    return { name, bytes: movements[0], movements: movements.length > 1 ? movements : undefined };
  });
  ipcMain.handle('fretroom:locate-audiveris', async (event) => {
    trustedFrame(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
      title: process.platform === 'darwin' ? 'Audiveris.app 위치 선택' : 'Audiveris.exe 위치 선택',
      defaultPath: process.platform === 'darwin' ? '/Applications' : process.env.ProgramFiles || undefined,
      properties: ['openFile'],
      ...(process.platform === 'darwin' ? {} : { filters: [{ name: 'Audiveris', extensions: ['exe'] }] }),
    });
    if (canceled || !filePaths.length) return null;
    return omr.rememberExecutable(path.resolve(filePaths[0]));
  });
  ipcMain.handle('fretroom:open-audiveris-download', async (event) => {
    trustedFrame(event);
    await shell.openExternal(omr.downloadUrl);
  });
  ipcMain.handle('fretroom:youtube-audio', async (event, url) => {
    trustedFrame(event);
    if (typeof url !== 'string') throw new Error('유튜브 영상 링크를 확인해 주세요.');
    return youtube.downloadAudio(url, (phase, percent) => {
      if (!event.sender.isDestroyed()) event.sender.send('fretroom:youtube-progress', { phase, percent });
    });
  });
  ipcMain.handle('fretroom:save-transcription', async (event, id, title, xml) => {
    trustedFrame(event);
    if (typeof id !== 'string' || typeof title !== 'string') throw new Error('Invalid transcription');
    const filename = await youtube.saveTranscription(id, title, xml);
    return { id: await rememberScore(filename), name: path.basename(filename) };
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'fretroom', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(() => {
    registerLibraryHandlers();
    protocol.handle('fretroom', (request) => {
      const url = new URL(request.url);
      if (url.host !== 'app' || !['GET', 'HEAD'].includes(request.method)) {
        return new Response('Not found', { status: 404 });
      }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(dist, `.${relative}`);
      const withinDist = path.relative(dist, file);
      if (!withinDist || withinDist.startsWith('..') || path.isAbsolute(withinDist)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    const window = new BrowserWindow({
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      width: 1300,
      height: 850,
      minWidth: 750,
      minHeight: 600,
      backgroundColor: '#f7f8f5',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window.webContents &&
        contents.getURL().startsWith(`${origin}/`) &&
        permission === 'media' &&
        Array.isArray(details.mediaTypes) &&
        details.mediaTypes.length > 0 &&
        details.mediaTypes.every((type) => type === 'audio'));
    });
    window.once('ready-to-show', () => window.show());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${origin}/`)) event.preventDefault();
    });
    window.loadURL(`${origin}/`);
    window.webContents.once('did-finish-load', () => updater.checkForUpdates(window, (status) => {
      if (!window.isDestroyed()) window.webContents.send('fretroom:update-status', status);
    }));
  });

  app.on('window-all-closed', () => app.quit());
}
