// Check GitHub on launch for a newer packaged release. Windows portable builds
// replace the EXE after exit; unsigned macOS bundles offer the DMG for manual
// replacement because silently overwriting an installed .app is not safe.
const { app, dialog, net, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const releasesUrl = 'https://api.github.com/repos/1000Pro-1997/fretroom/releases?per_page=30';
const assetName = 'fretroom.exe';

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match ? match.slice(1).map(Number) : null;
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function latestRelease() {
  const response = await net.fetch(releasesUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fretroom' } });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  let best = null;
  for (const release of await response.json()) {
    const version = parseVersion(release.tag_name);
    const asset = release.assets?.find((entry) => process.platform === 'darwin'
      ? entry.name === `fretroom-${version?.join('.')}-mac-${process.arch}.dmg`
      : entry.name === assetName);
    if (release.draft || release.prerelease || !version || !asset) continue;
    if (!best || newer(version, best.version)) best = { version, tag: release.tag_name, asset };
  }
  return best;
}

async function download(asset, destination, progress) {
  const expected = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1];
  if (!expected || !asset.size) throw new Error('업데이트 파일의 크기 또는 SHA-256 정보가 없습니다.');
  const response = await net.fetch(asset.browser_download_url);
  if (!response.ok || !response.body) throw new Error(`다운로드 실패 (HTTP ${response.status})`);
  const file = await fs.open(destination, 'w');
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let received = 0;
  let reported = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      let offset = 0;
      while (offset < value.length) offset += (await file.write(value, offset, value.length - offset)).bytesWritten;
      received += value.length;
      if (asset.size && received - reported > asset.size / 50) { reported = received; progress(received / asset.size); }
    }
  } finally {
    await file.close();
  }
  if (received !== asset.size) throw new Error('받은 파일 크기가 맞지 않습니다.');
  if (hash.digest('hex') !== expected) throw new Error('받은 파일 검증에 실패했습니다.');
}

// PowerShell waits until the portable launcher releases the EXE, replaces it and optionally relaunches.
function scheduleSwap(update, target, restart) {
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const script = `$src=${quote(update)}; $dst=${quote(target)}; ` +
    'for ($i = 0; $i -lt 240; $i++) { try { Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; ' +
    `${restart ? 'Start-Process -FilePath $dst; ' : ''}break } catch { Start-Sleep -Milliseconds 500 } }`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function checkForUpdates(window, notify) {
  const target = process.env.PORTABLE_EXECUTABLE_FILE;
  // The macOS build can offer the new DMG; only the Windows portable EXE swaps itself.
  if (!app.isPackaged || (process.platform !== 'darwin' && (process.platform !== 'win32' || !target))) return;
  const current = parseVersion(app.getVersion());
  void (async () => {
    // Offline or rate-limited checks stay silent; only a failed download is reported.
    const release = await latestRelease().catch(() => null);
    if (!release || !newer(release.version, current)) return;
    if (process.platform === 'darwin') {
      if (window.isDestroyed()) return;
      const { response } = await dialog.showMessageBox(window, {
        type: 'info', title: 'fretroom 업데이트', message: `새 버전 ${release.tag}이 있습니다.`,
        detail: '서명되지 않은 macOS 앱은 자동으로 교체할 수 없습니다. 새 DMG를 받아 기존 앱을 직접 교체해 주세요.',
        buttons: ['다운로드 페이지 열기', '나중에'], defaultId: 0, cancelId: 1,
      });
      if (response === 0) await shell.openExternal(release.asset.browser_download_url);
      return;
    }
    const update = `${target}.update`;
    notify({ state: 'downloading', version: release.tag, fraction: 0 });
    try {
      await download(release.asset, update, (fraction) => notify({ state: 'downloading', version: release.tag, fraction }));
    } catch (error) {
      await fs.rm(update, { force: true });
      throw error;
    }
    let restart = false;
    app.once('will-quit', () => scheduleSwap(update, target, restart));
    if (window.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'fretroom 업데이트',
      message: `새 버전 ${release.tag}을 받았습니다.`,
      detail: '지금 다시 시작하면 바로 적용됩니다. 나중을 고르면 앱을 닫을 때 적용되고 다음에 켤 때 새 버전으로 열립니다.',
      buttons: ['지금 다시 시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) { restart = true; app.quit(); }
    else notify({ state: 'ready', version: release.tag });
  })().catch((error) => notify({ state: 'error', message: error.message }));
}

module.exports = { checkForUpdates };
