import * as alphaTab from '@coderline/alphatab';
import { createTuner } from './tuner.js';
import { unfoldRepeats } from './repeats.js';
import { createLibraryUI, keyFor } from './library.js';
import { arrangeForGuitar, hasGuitarTab } from './arrange.js';
import { joinMovements } from './movements.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const bridge = window.fretroom;
const app = $('#app');
const viewer = $('#viewer');
const loading = $('#loading');
const fileInput = $('#file-input');
const playButton = $('#play-button');
const stopButton = $('#stop-button');
const validExtension = /\.(gp[34578]?|gpx|musicxml|xml|mxl|pdf|png|jpe?g|tiff?|bmp)$/i;
const recognizedExtension = /\.(pdf|png|jpe?g|tiff?|bmp)$/i;
const defaults = { speed: '1', zoom: '1', barsPerRow: '4', encoding: 'utf-8', trackView: 'all', metronome: false, unfoldRepeats: true, activeTab: 'library', sidebarOpen: true, lastRecentId: '', microphoneDeviceId: '', arrangeKey: 'auto', arrangeSpan: '4', arrangeAccompaniment: 'full' };
function storedObject(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
  catch { return {}; }
}
const prefs = { ...defaults, ...storedObject('fretroom:preferences') };
const scorePrefs = storedObject('fretroom:scores');
let files = [];
let recent = [];
let pendingName = '';
let currentBytes;
let currentId = '';
let originalScore;
let expandedScore;
let importedScore;
let arrangedScore;
let arrangeSummary = null;
let guitarTab = false;
let omrRetry = null;
let sourcePreview = null;
let previewRenderer;
let previewRequest = 0;
let convertingSource = null;
let conversionTimer;
let activeLibraryName = '';
let playedMarkId = '';
let requestId = 0;
let playerReady = false;
let loopEnabled = false;
let loopTimer;
let loopWaiting = false;
let pendingAutoPlay = false;
let tunerListening = false;
let renameId = '';
let renamePath = '';
let toastTimer;
let microphoneRequestId = 0;
let autoStartRequest = 0;

function savePrefs() { localStorage.setItem('fretroom:preferences', JSON.stringify(prefs)); }
function saveScorePrefs() { localStorage.setItem('fretroom:scores', JSON.stringify(scorePrefs)); }
function setSelect(selector, value, fallback) {
  const select = $(selector);
  select.value = String(value);
  if (!select.value) select.value = fallback;
  return select.value;
}
function applyControls(settings) {
  prefs.speed = setSelect('#performance-speed', settings.speed, '1');
  prefs.zoom = setSelect('#zoom-select', settings.zoom, '1');
  prefs.barsPerRow = setSelect('#bars-select', settings.barsPerRow, '4');
  prefs.encoding = setSelect('#encoding-select', settings.encoding, 'utf-8');
  prefs.trackView = settings.trackView || 'all';
}
applyControls(prefs);
app.classList.toggle('sidebar-collapsed', !prefs.sidebarOpen);
function syncPerformanceControls() {
  setSelect('#performance-speed', prefs.speed, '1');
  setSelect('#performance-capo', scorePrefs[currentId]?.capo ?? 'auto', 'auto');
  $('#performance-metronome').checked = Boolean(prefs.metronome);
  $('#performance-unfold').checked = Boolean(prefs.unfoldRepeats);
}
for (let fret = 0; fret <= 7; fret++) $('#performance-capo').add(new Option(fret ? `${fret}프렛` : '카포 없음', String(fret)));

const api = new alphaTab.AlphaTabApi($('#score-render'), {
  core: { fontDirectory: '/font/' },
  importer: { encoding: prefs.encoding },
  display: { scale: Number(prefs.zoom), barsPerRow: Number(prefs.barsPerRow) },
  player: {
    enablePlayer: true,
    soundFont: '/soundfont/FluidR3_GM.sf2',
    scrollElement: $('#sheet-scroll'),
    scrollMode: alphaTab.ScrollMode.Continuous,
    nativeBrowserSmoothScroll: false,
    scrollSpeed: 750,
  },
});
api.playbackSpeed = Number(prefs.speed);
new ResizeObserver(() => {
  const height = $('#sheet-scroll').clientHeight;
  if (!height) return;
  const offset = -Math.round(height * 0.38);
  if (api.settings.player.scrollOffsetY !== offset) {
    api.settings.player.scrollOffsetY = offset;
    api.updateSettings();
  }
}).observe($('#sheet-scroll'));
api.isLooping = false; // Range repetition needs a pause, rather than alphaTab's immediate loop.
api.metronomeVolume = prefs.metronome ? 1 : 0;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}
function cancelLoopDelay() {
  clearTimeout(loopTimer);
  loopTimer = undefined;
  loopWaiting = false;
  pendingAutoPlay = false;
}
function configureBarLayout(score) {
  const count = Number(prefs.barsPerRow);
  api.settings.display.systemsLayoutMode = count < 0 ? alphaTab.SystemsLayoutMode.Automatic : alphaTab.SystemsLayoutMode.UseModelLayout;
  api.settings.display.barsPerRow = count;
  if (count > 0 && score) {
    score.systemsLayout = [];
    score.defaultSystemsLayout = count;
    for (const bar of score.masterBars) bar.displayScale = 1;
    for (const track of score.tracks) {
      track.systemsLayout = [];
      track.defaultSystemsLayout = count;
      for (const staff of track.staves) for (const bar of staff.bars) bar.displayScale = 1;
    }
  }
  api.updateSettings();
}
function setSidebar(open) {
  prefs.sidebarOpen = open;
  app.classList.toggle('sidebar-collapsed', !open);
  savePrefs();
  if (api.score && !viewer.classList.contains('hidden') && $('#source-preview').classList.contains('hidden')) requestAnimationFrame(() => api.render());
}

const tuner = createTuner({
  onReading(reading) {
    $('#tuner-note').textContent = reading?.note || '';
    $('#tuner-hz').textContent = reading ? `${reading.frequency.toFixed(1)} Hz · ${reading.targetLabel || ''}` : '';
    $('#tuner-cents').textContent = reading?.targetPitch == null ? '' : `${reading.cents > 0 ? '+' : ''}${reading.cents}¢`;
    $('#tuner-needle').style.left = `${50 + Math.max(-50, Math.min(50, reading?.cents || 0))}%`;
    for (const chip of $('#tuner-targets').children) {
      const detected = reading?.targetPitch != null && Number(chip.dataset.pitch) === reading.targetPitch;
      chip.classList.toggle('tuned', detected && Math.abs(reading.cents) <= 5);
      chip.classList.toggle('out-of-tune', detected && Math.abs(reading.cents) > 5);
    }
  },
  onState(state) {
    tunerListening = state === 'listening';
    $('#tuner-toggle').textContent = tunerListening ? '마이크 끄기' : '마이크 켜기';
    $('#tuner-toggle').dataset.listening = String(tunerListening);
    if (tunerListening) refreshMicrophones();
  },
  onError(error) { showToast(`마이크를 사용할 수 없습니다: ${error.message}`); },
});
async function refreshMicrophones() {
  const request = ++microphoneRequestId;
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const devices = inputs.filter((device) => device.deviceId && !['default', 'communications'].includes(device.deviceId));
    if (request !== microphoneRequestId) return;
    const select = $('#microphone-select');
    const defaultName = (inputs.find((device) => device.deviceId === 'default')?.label || devices[0]?.label || '')
      .replace(/^(Default|기본값|기본)\s*[-–:]\s*/i, '')
      .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '')
      .replace(/^마이크\s*\((.*)\)$/i, '$1');
    select.replaceChildren(new Option(defaultName ? `기본 마이크 (${defaultName})` : '기본 마이크', ''));
    devices.forEach((device, index) => select.add(new Option(device.label || `마이크 ${index + 1}`, device.deviceId)));
    if (prefs.microphoneDeviceId && !devices.some((device) => device.deviceId === prefs.microphoneDeviceId)) {
      if (devices.length) {
        prefs.microphoneDeviceId = '';
        savePrefs();
        if (tunerListening) tuner.stop();
        showToast('선택한 마이크가 연결 해제되어 시스템 기본 마이크로 변경했습니다.');
      } else {
        select.add(new Option('저장된 마이크 (연결 확인 중)', prefs.microphoneDeviceId));
      }
    }
    select.value = prefs.microphoneDeviceId;
  } catch (error) { showToast(`마이크 목록을 읽을 수 없습니다: ${error.message}`); }
}
async function startTuner() {
  $('#tuner-toggle').disabled = true;
  try { await tuner.start(prefs.microphoneDeviceId); }
  catch { /* onError reports the microphone failure. */ }
  finally { $('#tuner-toggle').disabled = false; }
}
async function autoStartTuner() {
  const request = ++autoStartRequest;
  await refreshMicrophones();
  if (request === autoStartRequest && prefs.activeTab === 'tuner' &&
      !$('#tuner-toggle').disabled && !tunerListening) startTuner();
}
function setSidebarTab(name) {
  const active = ['library', 'settings', 'tuner'].includes(name) ? name : 'library';
  prefs.activeTab = active;
  for (const tabName of ['library', 'settings', 'tuner']) {
    const selected = tabName === active;
    const tab = $(`#tab-${tabName}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#${tabName === 'library' ? 'library-pane' : `${tabName}-panel`}`).classList.toggle('hidden', !selected);
  }
  if (active !== 'tuner') {
    ++autoStartRequest;
    tuner.stop();
  } else autoStartTuner();
  savePrefs();
}
function updateTunerTargets(tracks) {
  const staff = tracks.flatMap((track) => track.staves).find((item) => item.isStringed && item.tuning.length);
  const tuning = staff?.tuning || [64, 59, 55, 50, 45, 40];
  const targets = tuning.map((pitch, index) => ({ label: `${index + 1}번 줄 ${alphaTab.model.Tuning.getTextForTuning(pitch, true)}`, pitch }));
  tuner.setTargets(targets);
  const container = $('#tuner-targets');
  container.replaceChildren();
  for (const target of targets) {
    const chip = document.createElement('span');
    chip.textContent = target.label;
    chip.dataset.pitch = String(target.pitch);
    container.append(chip);
  }
  $('#tuner-toggle').disabled = false;
  if (prefs.activeTab === 'tuner' && !$('#tuner-panel').classList.contains('hidden') && !tunerListening) autoStartTuner();
}

function showRenameDialog(id, name, path) {
  renameId = id;
  renamePath = path;
  $('#rename-input').value = name.replace(/\.[^.]+$/, '');
  $('#rename-dialog').showModal();
  $('#rename-input').focus();
}
const libraryUI = createLibraryUI({
  openRecent: openRecentScore,
  openFolder: openLibraryScore,
  tuneRecent: async (id) => { await openRecentScore(id); setSidebarTab('tuner'); },
  tuneFolder: async (name) => { await openLibraryScore(name); setSidebarTab('tuner'); },
  rename: showRenameDialog,
  selection: () => ({ currentId, activeLibraryName }),
  hasConversion,
  forgetConversion,
  showInFolder: bridge?.showInFolder && ((path) => bridge.showInFolder(path).catch((error) => showToast(`파일 위치를 열 수 없습니다: ${error.message}`))),
});
function renderLibrary() { libraryUI.render(); }
function setLibrary(result) {
  files = result.files;
  const folder = result.folder || '폴더를 선택하면 악보 목록이 표시됩니다';
  $('#folder-path').textContent = folder;
  $('#folder-path').title = folder;
  libraryUI.setFolder(result);
}
async function refreshLibrary() {
  if (!bridge) return;
  try { setLibrary(await bridge.listFolder()); }
  catch (error) { showToast(`폴더를 읽을 수 없습니다: ${error.message}`); }
}
async function refreshRecent() {
  if (!bridge) return;
  try { recent = await bridge.recentScores(); libraryUI.setRecent(recent); }
  catch (error) { showToast(`최근 악보 목록을 읽을 수 없습니다: ${error.message}`); }
}
async function chooseFolder() {
  if (!bridge) { showToast('폴더 목록은 Windows 앱에서 사용할 수 있습니다.'); return; }
  try {
    const result = await bridge.chooseFolder();
    if (result) setLibrary(result);
  } catch (error) { showToast(`폴더를 선택할 수 없습니다: ${error.message}`); }
}
function prepareScoreSettings(id) {
  currentId = id || '';
  applyControls({ ...prefs, ...(scorePrefs[currentId] || {}) });
  api.settings.importer.encoding = prefs.encoding;
  api.settings.display.scale = Number(prefs.zoom);
  api.playbackSpeed = Number(prefs.speed);
  configureBarLayout(null);
  prefs.unfoldRepeats = scorePrefs[currentId]?.unfoldRepeats ?? prefs.unfoldRepeats;
  syncPerformanceControls();
}
function showCurrentScore() {
  if (!originalScore) return;
  if (prefs.unfoldRepeats && !expandedScore) {
    try { expandedScore = unfoldRepeats(originalScore, api.settings); }
    catch (error) { expandedScore = originalScore; showToast(`도돌이표를 펼칠 수 없습니다: ${error.message}`); }
  }
  cancelLoopDelay();
  if (api.playerState === alphaTab.synth.PlayerState.Playing) api.stop();
  api.playbackRange = null;
  loopEnabled = false;
  $('#loop-button').setAttribute('aria-pressed', 'false');
  playerReady = false;
  playButton.disabled = true;
  stopButton.disabled = true;
  const score = prefs.unfoldRepeats ? expandedScore : originalScore;
  const selected = prefs.trackView;
  const indexes = selected === 'all' || !score.tracks[Number(selected)]
    ? score.tracks.map((track) => track.index) : [Number(selected)];
  api.renderScore(score, indexes);
}
function resetConversion() {
  clearInterval(conversionTimer);
  conversionTimer = undefined;
  convertingSource = null;
  $('#pdf-convert').disabled = false;
  $('#pdf-convert').style.setProperty('--progress', '0%');
  $('.pdf-convert-label').textContent = '타브악보로 변환';
}
function updatePdfButtons(showOriginal = false) {
  const source = Boolean(sourcePreview);
  const converted = source && Boolean(sourcePreview.converted);
  $('#player-panel').classList.toggle('pdf-preview-mode', source && showOriginal && !converted);
  $('#pdf-convert').classList.toggle('hidden', !source || converted);
  $('#pdf-toggle').classList.toggle('hidden', !converted);
  $('#pdf-toggle').setAttribute('aria-pressed', String(converted && showOriginal));
  playButton.disabled = showOriginal || !playerReady;
  stopButton.disabled = showOriginal || !playerReady;
}
function clearSourcePreview() {
  previewRequest++;
  resetConversion();
  previewRenderer?.clear();
  sourcePreview = null;
  $('#source-preview').classList.add('hidden');
  $('#score-render').classList.remove('hidden');
  updatePdfButtons();
}
async function showSourcePreview(source) {
  if (sourcePreview !== source) return;
  const request = ++previewRequest;
  if (api.playerState === alphaTab.synth.PlayerState.Playing) api.stop();
  cancelLoopDelay();
  const root = $('#sheet-scroll');
  $('#score-render').classList.add('hidden');
  $('#source-preview').classList.remove('hidden');
  viewer.classList.remove('hidden');
  $('#empty-view').classList.add('hidden');
  $('#player-panel').classList.remove('hidden');
  $('#breadcrumb-title').textContent = source.name.replace(/\.[^.]+$/, '');
  document.title = `${source.name} — fretroom`;
  updatePdfButtons(true);
  root.scrollTop = 0;
  loading.textContent = '원본 악보를 여는 중...';
  loading.classList.remove('hidden');
  try {
    const { createPdfPreview } = await import('./pdf-preview.js');
    if (sourcePreview !== source || request !== previewRequest || $('#source-preview').classList.contains('hidden')) return;
    previewRenderer ||= createPdfPreview($('#source-preview'), root);
    await previewRenderer.show(source.name, source.bytes);
    if (sourcePreview === source && request === previewRequest) loading.classList.add('hidden');
  } catch (error) {
    if (sourcePreview === source && request === previewRequest) {
      loading.classList.add('hidden');
      showToast(`원본 악보를 표시할 수 없습니다: ${error.message}`);
    }
  }
}
async function openSourcePreview(name, bytes, id = '', libraryName = '') {
  clearSourcePreview();
  const source = { name, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), id, libraryName, converted: false };
  sourcePreview = source;
  currentBytes = undefined;
  importedScore = undefined;
  originalScore = undefined;
  arrangedScore = undefined;
  activeLibraryName = libraryName;
  prepareScoreSettings(id);
  playerReady = false;
  playButton.disabled = true;
  stopButton.disabled = true;
  updateTunerTargets([]);
  $('#title-edit').value = '';
  renderLibrary();
  await showSourcePreview(source);
}
async function openResult(name, bytes, id = '', libraryName = '') {
  if (recognizedExtension.test(name)) await openSourcePreview(name, bytes, id, libraryName);
  else beginLoad(name, bytes, id, libraryName);
}

function beginLoad(name, bytes, id = '', libraryName = '', keepSource = false) {
  if (!keepSource) clearSourcePreview();
  else {
    previewRequest++;
    previewRenderer?.clear();
    $('#source-preview').classList.add('hidden');
    $('#score-render').classList.remove('hidden');
    updatePdfButtons(false);
  }
  cancelLoopDelay();
  loopEnabled = false;
  $('#loop-button').setAttribute('aria-pressed', 'false');
  if (api.playerState === alphaTab.synth.PlayerState.Playing) api.stop();
  pendingName = name;
  currentBytes = bytes;
  activeLibraryName = libraryName;
  prepareScoreSettings(id);
  loading.textContent = '악보를 불러오는 중...';
  loading.classList.remove('hidden');
  originalScore = undefined;
  expandedScore = undefined;
  arrangedScore = undefined;
  arrangeSummary = null;
  importedScore = importScore(bytes);
  const personal = scorePrefs[currentId];
  if (personal?.title) importedScore.title = personal.title;
  guitarTab = personal?.guitarTab ?? !hasGuitarTab(importedScore);
  selectDisplayedScore();
  renderLibrary();
  showCurrentScore();
}
// Recognized PDFs can arrive as several movements; they are joined into one score.
function importScore(bytes) {
  const parts = (Array.isArray(bytes) ? bytes : [bytes]).map((part) =>
    alphaTab.importer.ScoreLoader.loadScoreFromBytes(part instanceof Uint8Array ? part : new Uint8Array(part), api.settings));
  if (parts.length === 1) return parts[0];
  const { score, joined } = joinMovements(parts, api.settings);
  if (!joined) showToast('인식된 악장의 파트 구성이 달라 첫 악장만 표시합니다.');
  return score;
}
// Transcribed recordings may have been played with a capo or an alternate tuning and may move
// to any key; hard notes there may also become similar notes.
function arrangeOptions() {
  const capo = scorePrefs[currentId]?.capo;
  return { keyMode: prefs.arrangeKey, maxSpan: Number(prefs.arrangeSpan), accompaniment: prefs.arrangeAccompaniment,
    recording: Boolean(scorePrefs[currentId]?.recording), capo: capo === undefined || capo === 'auto' ? undefined : Number(capo) };
}
function describeArrangement(summary) {
  const parts = [`키 ${summary.key}${summary.transpose
    ? ` (원곡보다 ${Math.abs(summary.transpose)}반음 ${summary.transpose > 0 ? '높임' : '낮춤'})` : ' (원래 키)'}`];
  if (summary.tuning) parts.push(summary.tuning);
  if (summary.capo) parts.push(`카포 ${summary.capo}프렛 (코드는 카포 기준 모양)`);
  if (summary.melodyShift) parts.push(`멜로디 ${Math.abs(summary.melodyShift) / 12}옥타브 ${summary.melodyShift > 0 ? '올림' : '내림'}`);
  if (summary.shifted) parts.push(`반주음 ${summary.shifted}개 옥타브 이동`);
  if (summary.similar) parts.push(`치기 어려운 음 ${summary.similar}개를 비슷한 음으로 바꿈`);
  if (summary.dropped) parts.push(`손이 닿지 않는 반주음 ${summary.dropped}개 생략`);
  if (summary.chords) parts.push(`코드 ${summary.chords}종 (${summary.chordSource === 'written' ? '악보 표기' : '자동 인식'})`);
  return `${summary.melodyPart ? `멜로디: ${summary.melodyPart} · ` : ''}${parts.join(' · ')}`;
}
function updateArrangeControls() {
  $('#tab-button').setAttribute('aria-pressed', String(guitarTab));
  $('#arrange-summary').textContent = guitarTab && arrangeSummary ? describeArrangement(arrangeSummary)
    : '위쪽 기타 타브 버튼을 켜면 이 악보를 기타 한 대로 편곡해 보여줍니다.';
}
// Picks the imported score or its guitar arrangement as the score to display.
function selectDisplayedScore() {
  expandedScore = undefined;
  if (guitarTab && !arrangedScore) {
    try {
      const result = arrangeForGuitar(importedScore, api.settings, arrangeOptions());
      arrangedScore = result.score;
      arrangeSummary = result.summary;
    } catch (error) {
      guitarTab = false;
      showToast(`기타 타브로 편곡할 수 없습니다: ${error.message}`);
    }
  }
  originalScore = guitarTab ? arrangedScore : importedScore;
  updateArrangeControls();
}
function payloadBytes(result) { return result.movements || result.bytes; }
function showBusy(message) {
  $('#busy-text').textContent = message;
  $('#busy').classList.remove('hidden');
}
function hideBusy() { $('#busy').classList.add('hidden'); }
bridge?.onOmrProgress(({ phase, fraction }) => {
  if (!convertingSource || sourcePreview !== convertingSource) return;
  const button = $('#pdf-convert');
  const value = phase === 'download' ? Math.round(40 * fraction) : phase === 'install' ? 42 : 45;
  button.style.setProperty('--progress', `${value}%`);
  $('.pdf-convert-label').textContent = phase === 'download' ? '인식 도구 받는 중' : '변환중…';
  if (phase === 'recognize') {
    const started = Date.now();
    clearInterval(conversionTimer);
    conversionTimer = setInterval(() => {
      if (sourcePreview !== convertingSource) { clearInterval(conversionTimer); return; }
      // OMR does not report per-page progress; the fill approaches 90% until it finishes.
      button.style.setProperty('--progress', `${Math.round(45 + 45 * (1 - Math.exp(-(Date.now() - started) / 60000)))}%`);
    }, 400);
  }
});
function handleOpenError(error, prefix, retry) {
  if (String(error?.message).includes('AUDIVERIS_MISSING')) {
    omrRetry = retry;
    $('#omr-error').textContent = String(error.message).replace(/^.*AUDIVERIS_MISSING:\s*/, '');
    $('#omr-dialog').showModal();
    return;
  }
  showToast(`${prefix}: ${error.message}`);
}
async function openLibraryScore(name) {
  if (!bridge) return;
  const id = ++requestId;
  // PDF files are previewed before recognition.
  try {
    const result = await bridge.openScore(name);
    if (id !== requestId) return;
    await openResult(result.name, payloadBytes(result), result.id, name);
    prefs.lastRecentId = result.id;
    savePrefs();
    await refreshRecent();
  } catch (error) { if (id === requestId) handleOpenError(error, '악보를 열 수 없습니다', () => openLibraryScore(name)); }
  finally { if (id === requestId) hideBusy(); }
}
async function openRecentScore(recentId) {
  if (!bridge) return;
  const id = ++requestId;
  try {
    const result = await bridge.openRecent(recentId);
    if (id !== requestId) return;
    await openResult(result.name, payloadBytes(result), result.id, files.some(({ name }) => name === result.name) ? result.name : '');
    prefs.lastRecentId = result.id;
    savePrefs();
    await refreshRecent();
  } catch (error) { if (id === requestId) handleOpenError(error, '최근 악보를 열 수 없습니다', () => openRecentScore(recentId)); }
  finally { if (id === requestId) hideBusy(); }
}
async function openPicker() {
  if (!bridge) { fileInput.click(); return; }
  const id = ++requestId;
  try {
    const result = await bridge.chooseScore();
    if (!result || id !== requestId) return;
    await openResult(result.name, payloadBytes(result), result.id, files.some(({ name }) => name === result.name) ? result.name : '');
    prefs.lastRecentId = result.id;
    savePrefs();
    await refreshRecent();
  } catch (error) { showToast(`파일을 열 수 없습니다: ${error.message}`); }
}
async function openFile(file) {
  if (!file) return;
  if (!validExtension.test(file.name)) { showToast('Guitar Pro, MusicXML, PDF 또는 이미지 악보를 선택해 주세요.'); return; }
  const id = ++requestId;
  try {
    const bytes = await file.arrayBuffer();
    if (id !== requestId) return;
    await openResult(file.name, bytes, file.name);
    prefs.lastRecentId = '';
    savePrefs();
  } catch (error) { if (id === requestId) handleOpenError(error, '파일을 열 수 없습니다', () => openFile(file)); }
}
function goHome() {
  ++requestId;
  clearSourcePreview();
  hideBusy();
  cancelLoopDelay();
  if (api.playerState === alphaTab.synth.PlayerState.Playing) api.stop();
  updateTunerTargets([]);
  viewer.classList.add('hidden');
  $('#empty-view').classList.remove('hidden');
  $('#player-panel').classList.add('hidden');
  $('#breadcrumb-title').textContent = '내 악보';
  document.title = 'fretroom — 기타 연습 악보';
  activeLibraryName = '';
  currentId = '';
  playedMarkId = '';
  prefs.lastRecentId = '';
  savePrefs();
  setSidebarTab('library');
  renderLibrary();
}

$('#home-button').addEventListener('click', goHome);
$('#top-home').addEventListener('click', goHome);
$('#sidebar-toggle').addEventListener('click', () => setSidebar(app.classList.contains('sidebar-collapsed')));
$('#sidebar-close').addEventListener('click', () => setSidebar(false));
$('#choose-folder').addEventListener('click', chooseFolder);
$('#empty-folder').addEventListener('click', chooseFolder);
$('#refresh-folder').addEventListener('click', () => { refreshLibrary(); refreshRecent(); });
$('#library-query').addEventListener('input', renderLibrary);
for (const selector of ['#open-file', '#empty-open']) $(selector).addEventListener('click', openPicker);
fileInput.addEventListener('change', () => { openFile(fileInput.files[0]); fileInput.value = ''; });
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => { event.preventDefault(); openFile(event.dataTransfer?.files[0]); });
window.addEventListener('beforeunload', () => tuner.stop());
$('#rename-save').addEventListener('click', async () => {
  const input = $('#rename-input');
  if (!input.reportValidity()) return;
  try {
    const renamedActive = currentId === renameId;
    const oldName = renamePath.split(/[\\/]/).at(-1);
    const result = renameId
      ? await bridge.renameRecent(renameId, input.value)
      : await bridge.renameScore(oldName, input.value);
    libraryUI.moveMark(renamePath, result.name);
    if (renamedActive) {
      pendingName = result.name;
      if (activeLibraryName === oldName) activeLibraryName = result.name;
    }
    $('#rename-dialog').close();
    await Promise.all([refreshRecent(), refreshLibrary()]);
  } catch (error) { showToast(`이름을 바꿀 수 없습니다: ${error.message}`); }
});
$('#tuner-toggle').addEventListener('click', () => {
  ++autoStartRequest;
  if (tunerListening) tuner.stop();
  else startTuner();
});
$('#microphone-select').addEventListener('change', (event) => {
  ++autoStartRequest;
  prefs.microphoneDeviceId = event.target.value;
  savePrefs();
  if (tunerListening) {
    tuner.stop();
    startTuner();
  }
});
navigator.mediaDevices?.addEventListener?.('devicechange', refreshMicrophones);
for (const name of ['library', 'settings', 'tuner']) {
  $(`#tab-${name}`).addEventListener('click', () => setSidebarTab(name));
}
$('.sidebar-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const names = ['library', 'settings', 'tuner'];
  const next = (names.indexOf(prefs.activeTab) + (event.key === 'ArrowRight' ? 1 : 2)) % names.length;
  setSidebarTab(names[next]);
  $(`#tab-${names[next]}`).focus();
});
updateTunerTargets([]);
setSidebarTab(prefs.activeTab);
$('#score-note').addEventListener('input', (event) => {
  if (!currentId) return;
  (scorePrefs[currentId] ||= {}).note = event.target.value;
  saveScorePrefs();
});
function applyTitle() {
  if (!api.score || viewer.classList.contains('hidden')) return false;
  const title = $('#title-edit').value.trim();
  if (!title) { showToast('악보 제목을 입력해 주세요.'); return false; }
  originalScore.title = title;
  if (expandedScore) expandedScore.title = title;
  if (importedScore) importedScore.title = title;
  if (arrangedScore) arrangedScore.title = title;
  (scorePrefs[currentId] ||= {}).title = title;
  saveScorePrefs();
  $('#breadcrumb-title').textContent = title;
  document.title = `${title} — fretroom`;
  api.render();
  return true;
}
$('#apply-title').addEventListener('click', applyTitle);
$('#save-edited').addEventListener('click', async () => {
  if (!api.score || !applyTitle()) return;
  try {
    const data = new alphaTab.exporter.Gp7Exporter().export(originalScore, api.settings);
    const base = originalScore.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim().replace(/[. ]+$/, '') || 'edited-score';
    if (bridge) {
      const saved = await bridge.saveEditedScore(base, data);
      if (saved) { showToast('수정본을 .gp 파일로 저장했습니다.'); await Promise.all([refreshRecent(), refreshLibrary()]); }
    } else {
      const url = URL.createObjectURL(new Blob([data]));
      const link = document.createElement('a');
      link.href = url; link.download = `${base}-edited.gp`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) { showToast(`수정본을 저장할 수 없습니다: ${error.message}`); }
});

api.scoreLoaded.on((score) => {
  if (sourcePreview && !sourcePreview.converted) return;
  cancelLoopDelay();
  const personal = scorePrefs[currentId];
  if (personal?.title) score.title = personal.title;
  $('#title-edit').value = score.title || '';
  $('#score-note').value = personal?.note || '';
  $('#empty-view').classList.add('hidden');
  viewer.classList.remove('hidden');
  $('#player-panel').classList.remove('hidden');
  const title = score.title?.trim() || pendingName.replace(/\.[^.]+$/, '');
  $('#breadcrumb-title').textContent = title;
  document.title = `${title} — fretroom`;
  configureBarLayout(score);
  const select = $('#track-select');
  select.replaceChildren(new Option('전체 파트', 'all'));
  for (const track of score.tracks) select.add(new Option(`${track.index + 1}. ${track.name || '파트'}`, String(track.index)));
  select.value = prefs.trackView;
  if (!select.value) select.value = 'all';
  const tracks = select.value === 'all' ? score.tracks : [score.tracks[Number(select.value)]];
  updateTunerTargets(tracks);
  $('#sheet-scroll').scrollTop = 0;
});
api.renderFinished.on(() => loading.classList.add('hidden'));
api.error.on((error) => { loading.classList.add('hidden'); showToast(`악보 처리 중 오류가 발생했습니다: ${error.message || error}`); });
api.playerReady.on(() => {
  playerReady = true;
  const pdfVisible = !$('#source-preview').classList.contains('hidden');
  playButton.disabled = pdfVisible;
  stopButton.disabled = pdfVisible;
  if (pendingAutoPlay && !pdfVisible) { pendingAutoPlay = false; api.play(); }
});
api.playerStateChanged.on((event) => {
  const playing = event.state === alphaTab.synth.PlayerState.Playing;
  playButton.textContent = playing ? '❚❚' : '▶';
  playButton.setAttribute('aria-label', playing ? '일시정지' : '재생');
  // Only scores that actually start playing enter the home screen's recently played list.
  if (playing && bridge && currentId && recent.some((entry) => entry.id === currentId) && playedMarkId !== currentId) {
    playedMarkId = currentId;
    bridge.markPlayed(currentId).then(refreshRecent).catch((error) => showToast(`최근 재생 기록을 저장할 수 없습니다: ${error.message}`));
  }
});
api.playbackRangeChanged.on(({ playbackRange }) => {
  cancelLoopDelay();
  loopEnabled = Boolean(playbackRange);
  $('#loop-button').setAttribute('aria-pressed', String(loopEnabled));
  if (!playbackRange) return;
  if (api.playerState === alphaTab.synth.PlayerState.Playing) api.stop();
  if (playerReady) api.play(); else pendingAutoPlay = true;
});
api.playerFinished.on(() => {
  const range = api.playbackRange;
  if (!loopEnabled || !range || !playerReady) return;
  loopWaiting = true;
  api.tickPosition = Math.max(range.startTick, range.endTick - 1);
  loopTimer = setTimeout(() => {
    api.stop();
    loopTimer = setTimeout(() => {
      loopWaiting = false;
      loopTimer = undefined;
      if (loopEnabled && api.playbackRange) api.play();
    }, 500);
  }, 500);
});
playButton.addEventListener('click', () => {
  if (loopWaiting) cancelLoopDelay();
  else api.playPause();
});
stopButton.addEventListener('click', () => { cancelLoopDelay(); api.stop(); });
// Space always toggles playback, whatever button was clicked last; only text entry keeps it.
const typesText = (target) => target instanceof Element &&
  Boolean(target.closest('textarea, [contenteditable="true"], input:not([type=checkbox]):not([type=radio]):not([type=button])'));
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || typesText(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || !api.score || !playerReady || viewer.classList.contains('hidden') ||
      !$('#source-preview').classList.contains('hidden')) return;
  playButton.click();
}, true);
// Buttons and checkboxes activate on Space release; swallow that so only playback reacts.
document.addEventListener('keyup', (event) => {
  if (event.code === 'Space' && !typesText(event.target)) { event.preventDefault(); event.stopPropagation(); }
}, true);
$('#track-select').addEventListener('change', (event) => {
  const value = event.target.value;
  const tracks = value === 'all' ? api.score.tracks : [api.score.tracks[Number(value)]];
  prefs.trackView = value;
  (scorePrefs[currentId] ||= {}).trackView = value;
  savePrefs(); saveScorePrefs();
  api.renderTracks(tracks);
  updateTunerTargets(tracks);
  $('#sheet-scroll').scrollTop = 0;
});
$('#encoding-select').addEventListener('change', (event) => {
  prefs.encoding = event.target.value;
  (scorePrefs[currentId] ||= {}).encoding = prefs.encoding;
  savePrefs(); saveScorePrefs();
  if (!currentBytes) return;
  try { beginLoad(pendingName, currentBytes, currentId, activeLibraryName, Boolean(sourcePreview)); }
  catch (error) { loading.classList.add('hidden'); showToast(`악보를 다시 불러올 수 없습니다: ${error.message}`); }
});
$('#performance-speed').addEventListener('change', (event) => {
  prefs.speed = event.target.value;
  api.playbackSpeed = Number(prefs.speed);
  (scorePrefs[currentId] ||= {}).speed = prefs.speed;
  savePrefs(); saveScorePrefs();
});
$('#zoom-select').addEventListener('change', (event) => {
  prefs.zoom = event.target.value;
  api.settings.display.scale = Number(prefs.zoom);
  api.updateSettings(); api.render();
  (scorePrefs[currentId] ||= {}).zoom = prefs.zoom;
  savePrefs(); saveScorePrefs();
});
$('#bars-select').addEventListener('change', (event) => {
  prefs.barsPerRow = event.target.value;
  configureBarLayout(api.score);
  if (api.score) api.render();
  (scorePrefs[currentId] ||= {}).barsPerRow = prefs.barsPerRow;
  savePrefs(); saveScorePrefs();
});
$('#loop-button').addEventListener('click', (event) => {
  if (!api.playbackRange) { showToast('악보의 구간을 드래그하면 자동으로 반복됩니다.'); return; }
  loopEnabled = !loopEnabled;
  event.currentTarget.setAttribute('aria-pressed', String(loopEnabled));
  if (!loopEnabled) cancelLoopDelay();
});
function setUnfoldRepeats(enabled) {
  prefs.unfoldRepeats = enabled;
  (scorePrefs[currentId] ||= {}).unfoldRepeats = enabled;
  savePrefs(); saveScorePrefs();
  syncPerformanceControls();
  if (originalScore) {
    loading.classList.remove('hidden');
    showCurrentScore();
    $('#sheet-scroll').scrollTop = 0;
  }
}
function setMetronome(enabled) {
  prefs.metronome = enabled;
  api.metronomeVolume = enabled ? 1 : 0;
  savePrefs();
  syncPerformanceControls();
}
function setCapo(value) {
  const entry = (scorePrefs[currentId] ||= {});
  if (value === 'auto') delete entry.capo; else entry.capo = value;
  arrangedScore = undefined;
  arrangeSummary = null;
  // A capo only means something on guitar tab, so choosing one shows the arrangement.
  if (value !== 'auto' && importedScore && !guitarTab) { guitarTab = true; entry.guitarTab = true; }
  saveScorePrefs();
  syncPerformanceControls();
  if (importedScore && guitarTab) rerenderArrangement();
}
$('#performance-unfold').addEventListener('change', (event) => setUnfoldRepeats(event.target.checked));
$('#performance-metronome').addEventListener('change', (event) => setMetronome(event.target.checked));
$('#performance-capo').addEventListener('change', (event) => setCapo(event.target.value));
$('#performance-reset').addEventListener('click', () => {
  prefs.speed = '1';
  api.playbackSpeed = 1;
  if (scorePrefs[currentId]) delete scorePrefs[currentId].speed;
  setMetronome(false);
  if (scorePrefs[currentId]?.capo !== undefined) setCapo('auto');
  if (!prefs.unfoldRepeats) setUnfoldRepeats(true);
  savePrefs(); saveScorePrefs();
  syncPerformanceControls();
});
function setPerformancePopup(open) {
  $('#performance-popup').classList.toggle('hidden', !open);
  $('#performance-button').setAttribute('aria-expanded', String(open));
}
$('#performance-button').addEventListener('click', () => setPerformancePopup($('#performance-popup').classList.contains('hidden')));
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#performance-popup, #performance-button')) setPerformancePopup(false);
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setPerformancePopup(false); });
syncPerformanceControls();

function rerenderArrangement() {
  loading.textContent = guitarTab ? '기타 타브로 편곡하는 중...' : '악보를 불러오는 중...';
  loading.classList.remove('hidden');
  selectDisplayedScore();
  showCurrentScore();
  $('#sheet-scroll').scrollTop = 0;
}
$('#pdf-convert').addEventListener('click', async () => {
  const source = sourcePreview;
  if (!source || source.converted || convertingSource || !bridge) return;
  convertingSource = source;
  const button = $('#pdf-convert');
  button.disabled = true;
  button.style.setProperty('--progress', '3%');
  $('.pdf-convert-label').textContent = '변환중…';
  try {
    // Vector tablature (exported from notation software) is read exactly and shown as written;
    // only scanned pages go through optical recognition and the guitar arrangement.
    const vector = /\.pdf$/i.test(source.name)
      ? await (await import('./pdf-preview.js')).readVectorTab(source.bytes).catch((error) => { console.warn('Vector tab reading failed; using recognition', error); return null; })
      : null;
    const recognized = vector ? null : await bridge.recognizeScore(source.name, source.bytes);
    if (sourcePreview !== source) return;
    button.style.setProperty('--progress', '100%');
    $('.pdf-convert-label').textContent = '변환 완료';
    source.converted = true;
    (scorePrefs[source.id] ||= {}).guitarTab = !vector;
    saveScorePrefs();
    beginLoad(source.name, vector ? new TextEncoder().encode(vector.tex) : payloadBytes(recognized), source.id, source.libraryName, true);
    if (vector?.uncertain.length) showToast(`PDF의 타브를 그대로 옮겼습니다. ${vector.uncertain.slice(0, 5).join(', ')}${vector.uncertain.length > 5 ? ' 등' : ''}마디는 원본과 다를 수 있으니 확인해 주세요.`);
  } catch (error) {
    if (sourcePreview !== source) return;
    source.converted = false;
    if ($('#source-preview').classList.contains('hidden')) void showSourcePreview(source);
    handleOpenError(error, '타브악보로 변환할 수 없습니다', () => $('#pdf-convert').click());
  } finally {
    if (sourcePreview === source) resetConversion();
  }
});
// The PDF/image open now, if it is the given library file.
function openSourceAt(path) {
  const source = sourcePreview;
  return source && recent.some((entry) => entry.id === source.id && keyFor(entry.path) === keyFor(path)) ? source : null;
}
// A conversion exists when the file is open and converted, or when its recognition was saved.
async function hasConversion(path) {
  if (!bridge?.hasRecognition || !recognizedExtension.test(path)) return false;
  if (openSourceAt(path)?.converted) return true;
  return bridge.hasRecognition(path).catch(() => false);
}
// Deleting drops the saved recognition, so the next conversion starts from scratch, and puts an
// open converted copy back to the original so it can be converted again right away.
async function forgetConversion(path) {
  try {
    await bridge.forgetRecognition(path);
  } catch (error) {
    showToast(`타브 변환을 삭제할 수 없습니다: ${error.message}`);
    return;
  }
  const source = openSourceAt(path);
  if (source?.converted && !convertingSource) {
    source.converted = false;
    await showSourcePreview(source);
  }
  showToast('타브 변환을 삭제했습니다. 다시 변환하면 처음부터 변환합니다.');
}
$('#pdf-toggle').addEventListener('click', () => {
  if (!sourcePreview?.converted) return;
  if ($('#source-preview').classList.contains('hidden')) {
    sourcePreview.tabScroll = $('#sheet-scroll').scrollTop;
    void showSourcePreview(sourcePreview);
  } else {
    previewRequest++;
    loading.classList.add('hidden');
    previewRenderer?.clear();
    $('#source-preview').classList.add('hidden');
    $('#score-render').classList.remove('hidden');
    updatePdfButtons(false);
    $('#sheet-scroll').scrollTop = sourcePreview.tabScroll || 0;
    requestAnimationFrame(() => api.render());
  }
});
$('#tab-button').addEventListener('click', () => {
  if (!importedScore) return;
  guitarTab = !guitarTab;
  (scorePrefs[currentId] ||= {}).guitarTab = guitarTab;
  saveScorePrefs();
  rerenderArrangement();
});
for (const [selector, key, fallback] of [['#arrange-key', 'arrangeKey', 'auto'], ['#arrange-span', 'arrangeSpan', '4'], ['#arrange-accompaniment', 'arrangeAccompaniment', 'full']]) {
  prefs[key] = setSelect(selector, prefs[key], fallback);
  $(selector).addEventListener('change', (event) => {
    prefs[key] = event.target.value;
    savePrefs();
    arrangedScore = undefined;
    arrangeSummary = null;
    if (importedScore && guitarTab) rerenderArrangement();
    else updateArrangeControls();
  });
}
updateArrangeControls();
$('#omr-download').addEventListener('click', () => bridge?.openAudiverisDownload());
$('#omr-locate').addEventListener('click', async () => {
  try {
    if (!(await bridge.locateAudiveris())) return;
    $('#omr-dialog').close();
    showToast('Audiveris를 연결했습니다. 악보를 다시 인식합니다.');
    const retry = omrRetry;
    omrRetry = null;
    retry?.();
  } catch (error) { showToast(`Audiveris를 연결할 수 없습니다: ${error.message}`); }
});
$('#omr-close').addEventListener('click', () => { omrRetry = null; $('#omr-dialog').close(); });

let youtubeActive = false;
const youtubePhases = { tool: '유튜브 다운로드 도구를 준비하는 중', download: '유튜브 소리를 받는 중', decode: '소리를 읽는 중', notes: '기타 음을 인식하는 중', score: '악보를 만드는 중' };
function youtubeProgress(phase, percent) {
  if (youtubeActive) showBusy(`${youtubePhases[phase] || '처리하는 중'}${percent > 0 && percent < 1 ? ` ${Math.round(percent * 100)}%` : '...'}`);
}
bridge?.onYoutubeProgress?.(({ phase, percent }) => youtubeProgress(phase, percent));
bridge?.onUpdateStatus?.(({ state, version, fraction, message }) => {
  if (state === 'downloading') showToast(`새 버전 ${version}을 받는 중입니다${fraction ? ` (${Math.round(fraction * 100)}%)` : ''}…`);
  else if (state === 'ready') showToast(`앱을 닫으면 ${version}으로 업데이트되고, 다음에 켤 때 새 버전으로 열립니다.`);
  else if (state === 'error') showToast(`업데이트를 받지 못했습니다: ${message}`);
});
// YouTube link → audio (yt-dlp in the main process) → notes (Basic Pitch) → MusicXML → guitar tab.
async function transcribeYoutube(url) {
  if (!bridge?.youtubeAudio) { showToast('유튜브 변환은 데스크톱 앱에서만 할 수 있습니다.'); return; }
  const id = ++requestId;
  youtubeActive = true;
  youtubeProgress('download', 0);
  try {
    const audio = await bridge.youtubeAudio(url);
    if (id !== requestId) return;
    const { transcribeAudio } = await import('./transcribe.js');
    const result = await transcribeAudio(audio.bytes, audio.title, youtubeProgress);
    if (id !== requestId) return;
    const saved = await bridge.saveTranscription(audio.id, audio.title, result.xml);
    scorePrefs[saved.id] = { ...scorePrefs[saved.id], recording: true, guitarTab: true };
    saveScorePrefs();
    youtubeActive = false;
    hideBusy();
    await refreshRecent();
    await openRecentScore(saved.id);
    showToast(`템포 ${result.tempo} BPM, ${result.bars}마디로 받아 적었습니다. 자동 인식이라 틀린 음이나 박자가 있을 수 있어요.`);
  } catch (error) {
    if (id === requestId) showToast(`유튜브 악보를 만들 수 없습니다: ${String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  } finally {
    if (id === requestId) { youtubeActive = false; hideBusy(); }
  }
}
for (const selector of ['#open-youtube', '#empty-youtube']) {
  $(selector).addEventListener('click', () => {
    $('#youtube-url').value = '';
    $('#youtube-dialog').showModal();
    $('#youtube-url').focus();
  });
}
$('#youtube-cancel').addEventListener('click', () => $('#youtube-dialog').close());
$('#youtube-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = $('#youtube-url').value.trim();
  if (!url) return;
  $('#youtube-dialog').close();
  transcribeYoutube(url);
});

// Files double-clicked in Finder/Explorer arrive through the main process; they win over the last score.
let fileHandedOver = false;
async function openHandedFile() {
  const recentId = await bridge.takeOpenedFile();
  if (!recentId) return;
  fileHandedOver = true;
  await openRecentScore(recentId);
}
if (bridge) {
  bridge.onFileOpened(openHandedFile);
  Promise.all([refreshLibrary(), refreshRecent()]).then(async () => {
    await openHandedFile();
    if (fileHandedOver) return;
    if (prefs.lastRecentId && recent.some(({ id, path }) => id === prefs.lastRecentId && !libraryUI.isRemoved(path))) openRecentScore(prefs.lastRecentId);
  });
} else renderLibrary();
