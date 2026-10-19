const $ = (selector) => document.querySelector(selector);

function storedMarks(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Paths, rather than recent-list positions or display names, identify scores across folder changes.
export const keyFor = (filename) => filename.replaceAll('/', '\\').toLocaleLowerCase();
// Windows folders use backslashes; macOS and Linux folders use slashes.
const filenameIn = (folder, name) => {
  if (folder.endsWith('\\') || folder.endsWith('/')) return `${folder}${name}`;
  return `${folder}${folder.includes('\\') && !folder.includes('/') ? '\\' : '/'}${name}`;
};
const folderOf = (filename) => filename.replace(/[\\/][^\\/]*$/, '');
const folderName = (folder) => folder.split(/[\\/]/).filter(Boolean).at(-1) || folder;
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
const HOME_RECENT_LIMIT = 10;

export function createLibraryUI({ openRecent, openFolder, tuneRecent, tuneFolder, rename, selection, hasConversion, forgetConversion, showInFolder }) {
  const favorites = storedMarks('fretroom:favorite-scores');
  const removed = storedMarks('fretroom:removed-scores');
  const collapsed = storedMarks('fretroom:collapsed-folders');
  let files = [];
  let recent = [];
  let folder = '';
  let contextPath = '';

  function save() {
    localStorage.setItem('fretroom:favorite-scores', JSON.stringify(favorites));
    localStorage.setItem('fretroom:removed-scores', JSON.stringify(removed));
    localStorage.setItem('fretroom:collapsed-folders', JSON.stringify(collapsed));
  }
  function setMark(marks, filename, enabled) {
    const key = keyFor(filename);
    if (enabled) marks[key] = { path: filename, at: Date.now() };
    else delete marks[key];
    save();
    render();
    renderManager();
  }
  function closeMenu() { $('#library-menu').classList.add('hidden'); }
  function placeMenu(menu, x, y) {
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  }
  function showMenu(event, filename) {
    event.preventDefault();
    contextPath = filename;
    const menu = $('#library-menu');
    $('#favorite-action').textContent = favorites[keyFor(filename)] ? '☆ 즐겨찾기 해제' : '★ 즐겨찾기';
    $('#forget-conversion-action').classList.add('hidden');
    menu.classList.remove('hidden');
    placeMenu(menu, event.clientX, event.clientY);
    $('#favorite-action').focus();
    // "Delete tab conversion" only appears for a PDF/image that has one.
    void hasConversion(filename).then((has) => {
      if (!has || contextPath !== filename || menu.classList.contains('hidden')) return;
      $('#forget-conversion-action').classList.remove('hidden');
      placeMenu(menu, event.clientX, event.clientY);
    });
  }
  function makeRow(entry, { tuning = false } = {}) {
    const { name, path, id } = entry;
    const key = keyFor(path);
    const wrapper = document.createElement('div');
    wrapper.className = 'recent-row';
    wrapper.addEventListener('contextmenu', (event) => showMenu(event, path));
    const tune = document.createElement('button');
    tune.type = 'button';
    const preview = /\.pdf$/i.test(name) ? 'PDF' : /\.(png|jpe?g|tiff?|bmp)$/i.test(name) ? 'IMG' : '';
    tune.className = `library-tune${preview ? ' library-file-type' : ''}${tuning ? ' active' : ''}`;
    tune.textContent = preview || '♫';
    tune.title = preview ? `${name} 열기` : `${name}의 튜닝으로 맞추기`;
    tune.setAttribute('aria-label', tune.title);
    tune.addEventListener('click', () => id
      ? preview ? openRecent(id) : tuneRecent(id)
      : preview ? openFolder(name) : tuneFolder(name));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `library-item${tuning ? ' active' : ''}`;
    button.title = name;
    const text = document.createElement('span');
    text.className = 'file-name';
    text.textContent = name.replace(/\.[^.]+$/, '');
    button.append(text);
    if (favorites[key]) {
      const star = document.createElement('span');
      star.className = 'favorite-indicator';
      star.textContent = '★';
      star.setAttribute('aria-label', '즐겨찾기');
      button.prepend(star);
    }
    button.addEventListener('click', () => id ? openRecent(id) : openFolder(name));
    wrapper.append(tune, button);
    return wrapper;
  }
  function placeholder(text) {
    const message = document.createElement('p');
    message.className = 'library-placeholder';
    message.textContent = text;
    return message;
  }
  // A folder heading toggles its score list; searching shows every match regardless of the saved state.
  function folderGroup(path, rows, emptyText, searching) {
    const key = keyFor(path);
    const open = searching || !collapsed[key];
    const section = document.createElement('section');
    section.className = 'folder-group';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'folder-heading';
    head.title = path;
    head.setAttribute('aria-expanded', String(open));
    const caret = document.createElement('span');
    caret.className = 'folder-caret';
    caret.textContent = open ? '▾' : '▸';
    const label = document.createElement('span');
    label.className = 'folder-name';
    label.textContent = folderName(path);
    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = String(rows.length);
    head.append(caret, label, count);
    head.addEventListener('click', () => {
      if (searching) return;
      if (collapsed[key]) delete collapsed[key]; else collapsed[key] = true;
      save();
      render();
    });
    const list = document.createElement('div');
    list.className = 'folder-items';
    list.setAttribute('role', 'list');
    list.hidden = !open;
    list.append(...(rows.length ? rows : [placeholder(emptyText)]));
    section.append(head, list);
    return section;
  }
  function renderHome() {
    const played = recent.filter(({ path, playedAt }) => playedAt > 0 && !removed[keyFor(path)])
      .sort((a, b) => b.playedAt - a.playedAt).slice(0, HOME_RECENT_LIMIT);
    const selected = selection();
    $('#home-recent').classList.toggle('hidden', !played.length);
    $('#home-recent-list').replaceChildren(...played.map((entry) => makeRow(entry, { tuning: Boolean(selected.currentId && entry.id === selected.currentId) })));
  }
  function render() {
    const query = $('#library-query').value.trim().toLocaleLowerCase();
    const searching = Boolean(query);
    const selected = selection();
    const matches = ({ name, path }) => !removed[keyFor(path)] && name.toLocaleLowerCase().includes(query);
    const folderKey = folder ? keyFor(folder) : '';
    const visibleFiles = files.map(({ name }) => ({ name, path: filenameIn(folder, name) })).filter(matches);
    // Scores opened with "파일 열기" from other folders are grouped under their own folder.
    const added = recent.filter((entry) => keyFor(folderOf(entry.path)) !== folderKey && matches(entry));
    const starred = new Map();
    for (const entry of [...added, ...visibleFiles]) if (favorites[keyFor(entry.path)] && !starred.has(keyFor(entry.path))) starred.set(keyFor(entry.path), entry);
    const starredEntries = [...starred.values()].sort((a, b) => favorites[keyFor(b.path)].at - favorites[keyFor(a.path)].at);
    const chosen = (entry) => Boolean(selected.currentId && (entry.id === selected.currentId || entry.name === selected.activeLibraryName && keyFor(entry.path) === keyFor(filenameIn(folder, entry.name))));
    const row = (entry) => makeRow(entry, { tuning: chosen(entry) });
    $('#favorite-section').classList.toggle('hidden', !starredEntries.length);
    $('#favorite-list').replaceChildren(...starredEntries.map(row));
    const groups = [];
    if (folder) {
      const ordinary = visibleFiles.filter(({ path }) => !favorites[keyFor(path)]);
      groups.push(folderGroup(folder, ordinary.map(row), files.length ? (searching ? '검색 결과가 없습니다.' : '표시할 악보가 없습니다.') : '폴더에 지원하는 악보가 없습니다.', searching));
    }
    const others = new Map();
    for (const entry of added) {
      if (favorites[keyFor(entry.path)]) continue;
      const dir = folderOf(entry.path);
      if (!others.has(keyFor(dir))) others.set(keyFor(dir), { dir, entries: [] });
      others.get(keyFor(dir)).entries.push(entry);
    }
    for (const { dir, entries } of [...others.values()].sort((a, b) => folderName(a.dir).localeCompare(folderName(b.dir), 'ko'))) {
      groups.push(folderGroup(dir, entries.sort(byName).map(row), '', searching));
    }
    if (!groups.length) groups.push(placeholder(searching ? '검색 결과가 없습니다.' : '자주 연습하는 악보 폴더를 선택하거나 파일을 열어 보세요.'));
    $('#folder-groups').replaceChildren(...groups);
    const total = files.filter(({ name }) => !removed[keyFor(filenameIn(folder, name))]).length
      + recent.filter((entry) => keyFor(folderOf(entry.path)) !== folderKey && !removed[keyFor(entry.path)]).length;
    $('#file-count').textContent = `악보 ${total}개`;
    renderHome();
  }
  function managerList(container, marks, action) {
    const rows = Object.values(marks).filter((entry) => entry?.path).sort((a, b) => b.at - a.at);
    const nodes = rows.map(({ path }) => {
      const row = document.createElement('div');
      row.className = 'manager-row';
      const label = document.createElement('span');
      label.textContent = path.split(/[\\/]/).at(-1);
      label.title = path;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action;
      button.addEventListener('click', () => setMark(marks, path, false));
      row.append(label, button);
      return row;
    });
    if (!nodes.length) {
      const empty = document.createElement('p');
      empty.textContent = '없음';
      nodes.push(empty);
    }
    $(container).replaceChildren(...nodes);
  }
  function renderManager() {
    managerList('#manager-favorites', favorites, '해제');
    managerList('#manager-removed', removed, '복구');
  }
  $('#favorite-action').addEventListener('click', () => {
    setMark(favorites, contextPath, !favorites[keyFor(contextPath)]);
    closeMenu();
  });
  $('#rename-action').addEventListener('click', () => {
    const entry = recent.find(({ path }) => keyFor(path) === keyFor(contextPath));
    rename(entry?.id || '', contextPath.split(/[\\/]/).at(-1), contextPath);
    closeMenu();
  });
  $('#remove-action').addEventListener('click', () => {
    setMark(removed, contextPath, true);
    closeMenu();
  });
  $('#reveal-action').classList.toggle('hidden', !showInFolder);
  $('#reveal-action').addEventListener('click', () => {
    void showInFolder(contextPath);
    closeMenu();
  });
  $('#forget-conversion-action').addEventListener('click', () => {
    void forgetConversion(contextPath);
    closeMenu();
  });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#library-menu')) closeMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  $('#manage-library').addEventListener('click', () => { renderManager(); $('#library-dialog').showModal(); });
  $('#library-close').addEventListener('click', () => $('#library-dialog').close());
  return {
    render,
    setFolder(result) { files = result.files; folder = result.folder || ''; render(); },
    setRecent(result) { recent = result; render(); },
    isRemoved(filename) { return Boolean(removed[keyFor(filename)]); },
    findRecent(id) { return recent.find((entry) => entry.id === id); },
    moveMark(oldPath, newName) {
      const updated = filenameIn(oldPath.replace(/[\\/][^\\/]+$/, ''), newName);
      for (const marks of [favorites, removed]) {
        const oldKey = keyFor(oldPath);
        if (!marks[oldKey]) continue;
        marks[keyFor(updated)] = { ...marks[oldKey], path: updated };
        delete marks[oldKey];
      }
      save();
      renderManager();
    },
  };
}
