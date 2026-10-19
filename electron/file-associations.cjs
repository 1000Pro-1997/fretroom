// The portable Windows EXE has no installer, so it registers its score types for the current
// user (HKCU, no administrator rights) and re-points them whenever the EXE has moved.
// macOS gets the same types from CFBundleDocumentTypes (package.json build.fileAssociations).
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const progId = 'fretroom.score';
// Keep in sync with build.fileAssociations in package.json.
const extensions = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'gp7', 'gp8', 'musicxml', 'mxl'];
const classes = 'HKEY_CURRENT_USER\\Software\\Classes';

function registryText(executable) {
  const value = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const lines = [
    'Windows Registry Editor Version 5.00', '',
    `[${classes}\\${progId}]`, `@=${value('fretroom 악보')}`, '',
    `[${classes}\\${progId}\\DefaultIcon]`, `@=${value(`"${executable}",0`)}`, '',
    `[${classes}\\${progId}\\shell\\open\\command]`, `@=${value(`"${executable}" "%1"`)}`, '',
  ];
  // A per-user default; Windows still prefers a handler the user picked with "Always use this app".
  for (const extension of extensions) {
    lines.push(`[${classes}\\.${extension}]`, `@=${value(progId)}`, '');
    lines.push(`[${classes}\\.${extension}\\OpenWithProgids]`, `${value(progId)}=hex(0):`, '');
  }
  return lines.join('\r\n');
}

async function registeredCommand() {
  try {
    const { stdout } = await run('reg.exe', ['query', `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '/ve'], { windowsHide: true });
    return /REG_SZ\s+(.*)$/m.exec(stdout)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

async function registerFileAssociations() {
  const executable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform !== 'win32' || !executable) return;
  if (await registeredCommand() === `"${executable}" "%1"`) return;
  const file = path.join(os.tmpdir(), `fretroom-associations-${process.pid}.reg`);
  // reg.exe import expects UTF-16LE with a byte order mark.
  await fs.writeFile(file, `\ufeff${registryText(executable)}`, 'utf16le');
  try {
    await run('reg.exe', ['import', file], { windowsHide: true });
  } finally {
    await fs.rm(file, { force: true });
  }
}

module.exports = { registerFileAssociations };
