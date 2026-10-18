const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fretroom', {
  chooseFolder: () => ipcRenderer.invoke('fretroom:choose-folder'),
  listFolder: () => ipcRenderer.invoke('fretroom:list-folder'),
  openScore: (name) => ipcRenderer.invoke('fretroom:open-score', name),
  chooseScore: () => ipcRenderer.invoke('fretroom:choose-score'),
  recentScores: () => ipcRenderer.invoke('fretroom:recent-scores'),
  openRecent: (id) => ipcRenderer.invoke('fretroom:open-recent', id),
  markPlayed: (id) => ipcRenderer.invoke('fretroom:mark-played', id),
  renameRecent: (id, newBase) => ipcRenderer.invoke('fretroom:rename-recent', id, newBase),
  renameScore: (name, newBase) => ipcRenderer.invoke('fretroom:rename-score', name, newBase),
  saveEditedScore: (suggestedBase, bytes) => ipcRenderer.invoke('fretroom:save-edited', suggestedBase, bytes),
  recognizeScore: (name, bytes) => ipcRenderer.invoke('fretroom:recognize-score', name, bytes),
  locateAudiveris: () => ipcRenderer.invoke('fretroom:locate-audiveris'),
  openAudiverisDownload: () => ipcRenderer.invoke('fretroom:open-audiveris-download'),
  onOmrProgress: (callback) => { ipcRenderer.on('fretroom:omr-progress', (_event, data) => callback(data)); },
  youtubeAudio: (url) => ipcRenderer.invoke('fretroom:youtube-audio', url),
  saveTranscription: (id, title, xml) => ipcRenderer.invoke('fretroom:save-transcription', id, title, xml),
  onYoutubeProgress: (callback) => { ipcRenderer.on('fretroom:youtube-progress', (_event, data) => callback(data)); },
});
