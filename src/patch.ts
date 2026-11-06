import * as fs from 'fs';
import * as path from 'path';

/**
 * Opt-in patch of VS Code's workbench.html: adds a <script> that draws the group
 * chips, group lines and group editor on the tab bar (resources/patch/tab-groups-patch.js).
 * Pure fs logic so it can be unit-tested against a temp folder.
 */

export const SCRIPT_NAME = 'tab-groups-patch.js';
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
  const scriptPath = path.join(path.dirname(htmlPath), SCRIPT_NAME);
  const installed = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
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
  const tag = `\n\t${START}\n\t<script src="./${SCRIPT_NAME}"></script>\n\t${END}\n`;
  const close = html.lastIndexOf('</html>');
  if (close < 0) {
    throw new Error('Unexpected workbench.html format (no </html>).');
  }
  html = html.slice(0, close).replace(/\s*$/, '') + tag + html.slice(close);
  fs.writeFileSync(path.join(dir, SCRIPT_NAME), scriptSource, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
}

export function removePatch(htmlPath: string): void {
  const dir = path.dirname(htmlPath);
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (html.includes(START)) {
    fs.writeFileSync(htmlPath, html.replace(BLOCK_RE, ''), 'utf8');
  }
  fs.rmSync(path.join(dir, SCRIPT_NAME), { force: true });
  fs.rmSync(htmlPath + BACKUP_SUFFIX, { force: true });
}

export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}
