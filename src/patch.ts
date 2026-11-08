import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Opt-in patch of VS Code's workbench.html: adds a <script> that draws the group
 * chips, group lines and group editor on the tab bar (resources/patch/tab-groups-patch.js).
 * Pure fs logic so it can be unit-tested against a temp folder.
 *
 * The script file is named after its content (`tab-groups-patch.<hash>.js`): VS Code's window
 * can keep serving an old copy of a file whose address did not change, even across reloads,
 * so each version of the script gets an address of its own.
 */

/** File name of the installed script for this script content. */
export function scriptName(scriptSource: string): string {
  return `tab-groups-patch.${crypto.createHash('sha256').update(scriptSource).digest('hex').slice(0, 12)}.js`;
}
/** Our script files: this version's and older ones (including the unhashed `tab-groups-patch.js`). */
const SCRIPT_FILE_RE = /^tab-groups-patch(\.[0-9a-f]+)?\.js$/;
export const BACKUP_SUFFIX = '.tab-groups.bak';
const START = '<!-- tab-groups-patch:start -->';
const END = '<!-- tab-groups-patch:end -->';
const BLOCK_RE = /\s*<!-- tab-groups-patch:start -->[\s\S]*?<!-- tab-groups-patch:end -->/;

const WORKBENCH_CANDIDATES = [
  ['out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'],
  ['out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'],
];

export function findWorkbenchHtml(appRoot: string): string | undefined {
  for (const parts of WORKBENCH_CANDIDATES) {
    const candidate = path.join(appRoot, ...parts);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export type PatchStatus = 'patched' | 'outdated' | 'unpatched';

/** `outdated` = patched, but the installed script differs from this extension's version. */
export function patchStatus(htmlPath: string, scriptSource: string): PatchStatus {
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes(START)) {
    return 'unpatched';
  }
  // Current when the page loads the file named after this script, and that file holds it.
  const name = scriptName(scriptSource);
  const block = BLOCK_RE.exec(html)?.[0] ?? '';
  const scriptPath = path.join(path.dirname(htmlPath), name);
  const installed = block.includes(`src="./${name}"`) && fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  return installed === scriptSource ? 'patched' : 'outdated';
}

export function applyPatch(htmlPath: string, scriptSource: string): void {
  const dir = path.dirname(htmlPath);
  const backup = htmlPath + BACKUP_SUFFIX;
  let html = fs.readFileSync(htmlPath, 'utf8');
  if (!fs.existsSync(backup) && !html.includes(START)) {
    fs.writeFileSync(backup, html, 'utf8');
  }
  html = html.replace(BLOCK_RE, '');
  const name = scriptName(scriptSource);
  const tag = `\n\t${START}\n\t<script src="./${name}"></script>\n\t${END}\n`;
  const close = html.lastIndexOf('</html>');
  if (close < 0) {
    throw new Error('Unexpected workbench.html format (no </html>).');
  }
  html = html.slice(0, close).replace(/\s*$/, '') + tag + html.slice(close);
  // The new file first, then the page that loads it; then older versions can go.
  fs.writeFileSync(path.join(dir, name), scriptSource, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  removeScripts(dir, name);
}

export function removePatch(htmlPath: string): void {
  const dir = path.dirname(htmlPath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (html.includes(START)) {
    fs.writeFileSync(htmlPath, html.replace(BLOCK_RE, ''), 'utf8');
  }
  removeScripts(dir);
  fs.rmSync(htmlPath + BACKUP_SUFFIX, { force: true });
}

/** Deletes our script files in `dir`, except `keep`. */
function removeScripts(dir: string, keep?: string): void {
  for (const file of fs.readdirSync(dir)) {
    if (SCRIPT_FILE_RE.test(file) && file !== keep) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
  }
}

export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}
