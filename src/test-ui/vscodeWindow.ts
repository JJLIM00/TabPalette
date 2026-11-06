/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/*
 * Drives a real VS Code window the way a person does: mouse clicks, drags, right-click menus
 * and typing. Used by the UI tests in this folder.
 *
 * Each run patches the downloaded test copy of VS Code in `.vscode-test` (never your own
 * installation) and restores it afterwards. It uses its own temporary profile, so your
 * settings and extensions are not touched either.
 */
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ElectronApplication, Page, _electron } from 'playwright-core';
import { applyPatch, findWorkbenchHtml, patchStatus, removePatch } from '../patch';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test-fixtures');
const PATCH_SCRIPT = path.join(ROOT, 'resources', 'patch', 'tab-groups-patch.js');

/** What one tab in the tab bar looks like to the user. */
export interface TabView {
  name: string;
  /** Name of the group it is drawn in, or null. An unnamed group is ''. */
  group: string | null;
  /** Color of the group line under the tab (CSS rgb), or null. */
  lineColor: string | null;
  active: boolean;
  /** Hidden because its group is collapsed. */
  hidden: boolean;
  /** Shows Chrome's rounded outline (active tab of a group). */
  outlined: boolean;
}

/** What one group chip looks like to the user. */
export interface ChipView {
  name: string;
  color: string;
  collapsed: boolean;
  /** Unnamed groups show a small colored dot instead of a label. */
  isDot: boolean;
}

/** Chrome color name (as shown in the group editor) → CSS color used in the dark theme. */
export const COLORS: Record<string, string> = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const colors: Record<string, string> = {};
  for (const c of pkg.contributes.colors as { id: string; defaults: { dark: string } }[]) {
    const name = c.id.replace('tabPalette.', '');
    const hex = c.defaults.dark.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    colors[name[0].toUpperCase() + name.slice(1)] = `rgb(${r}, ${g}, ${b})`;
  }
  return colors;
})();

export class VSCodeWindow {
  private constructor(
    private readonly app: ElectronApplication,
    readonly page: Page,
    private readonly workbenchHtml: string,
    private readonly profileDir: string,
  ) {}

  /** Starts VS Code with the `test-fixtures` folder open and Chrome-style tab groups enabled. */
  static async launch(): Promise<VSCodeWindow> {
    const exe = await downloadAndUnzipVSCode();
    const html = findWorkbenchHtml(findAppRoot(path.dirname(exe)));
    if (!html) {
      throw new Error('Could not find workbench.html in the VS Code test copy');
    }
    applyPatch(html, fs.readFileSync(PATCH_SCRIPT, 'utf8'));

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-groups-ui-'));
    fs.mkdirSync(path.join(profileDir, 'user', 'User'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'user', 'User', 'settings.json'),
      JSON.stringify({
        'window.dialogStyle': 'custom', // dialogs and menus drawn in the page, so tests can click them
        'window.menuStyle': 'custom',
        'workbench.startupEditor': 'none',
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.editor.enablePreview': false,
        'git.openRepositoryInParentFolders': 'never',
        'chat.commandCenter.enabled': false,
        'workbench.tips.enabled': false,
      }),
    );
    const app = await _electron.launch({
      executablePath: exe,
      args: [
        `--extensionDevelopmentPath=${ROOT}`,
        `--user-data-dir=${path.join(profileDir, 'user')}`,
        `--extensions-dir=${path.join(profileDir, 'extensions')}`,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        FIXTURES,
      ],
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.unmaximize();
      w.setSize(1400, 800);
    });
    const vscode = new VSCodeWindow(app, page, html, profileDir);
    await vscode.acceptOnboarding();
    return vscode;
  }

  /** Closes VS Code and restores the test copy's original files. */
  async close(): Promise<void> {
    await this.app.close().catch(() => undefined);
    removePatch(this.workbenchHtml);
    fs.rmSync(this.profileDir, { recursive: true, force: true });
  }

  /** True when VS Code's workbench.html is back to the original. */
  isUnpatched(): boolean {
    return patchStatus(this.workbenchHtml, '') === 'unpatched';
  }

  /** First start: the extension asks to enable Chrome-style tab groups. Say yes. */
  private async acceptOnboarding(): Promise<void> {
    await this.page.click('.notification-list-item a.monaco-button:has-text("Enable")', { timeout: 30_000 });
    await this.page.click('.monaco-dialog-box a.monaco-button:has-text("Enable")');
    await this.waitUntil('the tab bar is connected to the extension', () => this.page.evaluate(() => !!window.__tabGroupsPatch?.connected));
    await this.page.keyboard.press('Escape');
    await this.dismissNotifications();
  }

  // ------------------------------------------------------------------ reading the screen

  /** The tab bar of the active editor group, left to right. */
  tabs(): Promise<TabView[]> {
    return this.page.evaluate(() => {
      const state = window.__tabGroupsPatch?.state;
      const groupName = (id: string | undefined) => (id ? (state?.groups.find((g) => g.id === id)?.name ?? '?') : null);
      const row = document.querySelector('.editor-group-container.active .tabs-container') ?? document.querySelector('.tabs-container');
      return [...(row?.querySelectorAll(':scope > .tab') ?? [])].map((node) => {
        const tab = node as HTMLElement;
        const line = tab.querySelector(':scope > .tg-line');
        const outline = tab.querySelector(':scope > .tg-u');
        const style = getComputedStyle(tab);
        return {
          name: tab.querySelector('.label-name')?.textContent ?? '?',
          group: groupName(tab.dataset.tgGid),
          lineColor: line && getComputedStyle(line).display !== 'none' ? getComputedStyle(line).borderBottomColor : tab.dataset.tgGid ? 'hidden' : null,
          active: tab.classList.contains('active'),
          hidden: style.display === 'none' || tab.getBoundingClientRect().width === 0,
          outlined: !!outline && getComputedStyle(outline).display !== 'none',
        };
      });
    });
  }

  /** Names of the visible tabs, left to right. */
  async tabNames(): Promise<string[]> {
    return (await this.tabs()).filter((t) => !t.hidden).map((t) => t.name);
  }

  async tab(name: string): Promise<TabView> {
    const tab = (await this.tabs()).find((t) => t.name === name);
    if (!tab) {
      throw new Error(`No tab named ${name}`);
    }
    return tab;
  }

  /** Group chips in the tab bar, left to right. */
  chips(): Promise<ChipView[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('.tabs-container .tg-chip')]
        .map((node) => node as HTMLElement)
        .filter((chip) => chip.getBoundingClientRect().width > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map((chip) => {
          const group = window.__tabGroupsPatch?.state?.groups.find((g) => g.id === chip.dataset.gid);
          return {
            name: chip.textContent ?? '',
            color: getComputedStyle(chip).backgroundColor,
            collapsed: !!group?.collapsed,
            isDot: chip.classList.contains('tg-unnamed'),
          };
        }),
    );
  }

  async chip(name: string): Promise<ChipView | undefined> {
    return (await this.chips()).find((c) => c.name === name);
  }

  /** Whether the group editor bubble is open. */
  editorIsOpen(): Promise<boolean> {
    return this.page.locator('.tg-popup').isVisible();
  }

  /** The color whose swatch is marked as selected in the group editor. */
  selectedSwatch(): Promise<{ color: string | null; hasCenterDot: boolean }> {
    return this.page.evaluate(() => {
      const swatch = document.querySelector('.tg-popup .tg-color.tg-selected') as HTMLElement | null;
      return {
        color: swatch?.title ?? null,
        hasCenterDot: !!swatch && getComputedStyle(swatch).backgroundImage !== 'none',
      };
    });
  }

  // ------------------------------------------------------------------ mouse and keyboard

  /** Opens a file with Quick Open (Ctrl+P), like a user does. */
  async open(file: string): Promise<void> {
    await this.page.keyboard.press('Control+P');
    await this.page.waitForSelector('.quick-input-widget input');
    await this.page.keyboard.type(file);
    await this.waitUntil(`Quick Open finds ${file}`, () =>
      this.page.evaluate((f) => !!document.querySelector('.quick-input-list .monaco-list-row')?.textContent?.includes(f), file),
    );
    await this.page.keyboard.press('Enter');
    await this.waitUntil(`${file} is the active tab`, async () => (await this.tabs()).some((t) => t.name === file && t.active));
  }

  /** Runs a command by its title from the Command Palette. */
  async runCommand(title: string): Promise<void> {
    await this.page.keyboard.press('F1');
    await this.page.waitForSelector('.quick-input-widget input');
    await this.page.keyboard.type(title);
    await this.waitUntil(`the Command Palette shows "${title}"`, () =>
      this.page.evaluate(
        (t) => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => (r.getAttribute('aria-label') ?? r.textContent ?? '').includes(t)),
        title,
      ),
    );
    await this.pickFromList(title);
  }

  async press(keys: string): Promise<void> {
    await this.page.keyboard.press(keys);
    await this.idle();
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 20 });
    await this.idle();
  }

  async clickTab(name: string, modifiers: ('Control' | 'Shift')[] = []): Promise<void> {
    await this.tabLocator(name).click({ modifiers });
    await this.idle();
  }

  /** Right-clicks a tab and picks an item from its context menu (use 'Tab Group > Remove Tab from Group' for a submenu). */
  async tabMenu(name: string, item: string): Promise<void> {
    await this.tabLocator(name).click({ button: 'right' });
    await this.chooseContextMenuItem(item);
  }

  /** Clicks a group chip (collapses or expands the group). */
  async clickChip(group: string): Promise<void> {
    await this.chipLocator(group).click();
    await this.idle();
  }

  /** Right-clicks a group chip, which opens the group editor. */
  async openGroupEditor(group: string): Promise<void> {
    await this.chipLocator(group).click({ button: 'right' });
    await this.page.waitForSelector('.tg-popup');
  }

  /** In the open group editor: clicks a color swatch, e.g. 'Orange'. */
  async pickColor(color: string): Promise<void> {
    await this.page.click(`.tg-popup .tg-color[title="${color}"]`);
    await this.idle();
  }

  /** In the open group editor: replaces the name, typing it like a user. */
  async typeGroupName(name: string): Promise<void> {
    await this.page.click('.tg-popup .tg-name');
    await this.page.keyboard.press('Control+A');
    await this.type(name);
  }

  /** In the open group editor: clicks a menu item such as 'Close group'. */
  async groupEditorItem(text: string): Promise<void> {
    await this.page.locator('.tg-popup .tg-item', { hasText: text }).click();
    await this.idle();
  }

  /** Drags a tab with the mouse and drops it on the left half of `before` (or right half of `after`). */
  async dragTab(name: string, to: { before: string } | { after: string }): Promise<void> {
    const from = await this.tabLocator(name).boundingBox();
    const target = await this.tabLocator('before' in to ? to.before : to.after).boundingBox();
    if (!from || !target) {
      throw new Error('tab not found');
    }
    const x = 'before' in to ? target.x + target.width * 0.25 : target.x + target.width * 0.75;
    const y = target.y + target.height / 2;
    await this.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + from.width / 2 + 10, y, { steps: 3 });
    await this.page.mouse.move(x, y, { steps: 12 });
    await this.page.mouse.up();
    await this.idle(600);
  }

  /** Drags a group chip with the mouse and drops it just before tab `before` (or after the last tab). */
  async dragChip(group: string, to: { before: string } | 'end'): Promise<void> {
    const from = await this.chipLocator(group).boundingBox();
    if (!from) {
      throw new Error('chip not found');
    }
    let x: number;
    if (to === 'end') {
      const tabs = await this.page.locator('.editor-group-container.active .tabs-container > .tab').all();
      const last = await tabs[tabs.length - 1].boundingBox();
      x = last!.x + last!.width + 4;
    } else {
      const target = await this.tabLocator(to.before).boundingBox();
      const chip = await this.page.evaluate((name) => {
        const tab = [...document.querySelectorAll('.tabs-container > .tab')].find((t) => t.querySelector('.label-name')?.textContent === name);
        const c = tab?.querySelector(':scope > .tg-chip');
        return c ? c.getBoundingClientRect().left : null;
      }, to.before);
      x = (chip ?? target!.x) - 4;
    }
    const y = from.y + from.height / 2;
    await this.page.mouse.move(from.x + from.width / 2, y);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + from.width / 2 + 12, y, { steps: 4 });
    await this.page.mouse.move(x, y, { steps: 15 });
    await this.page.mouse.up();
    await this.idle(1500);
  }

  /** Reloads the window, like Developer: Reload Window, and waits until the tab bar is connected again. */
  async reload(): Promise<void> {
    await this.page.evaluate(() => window.__tabGroupsPatch && (window.__tabGroupsPatch.connected = false));
    await this.runCommand('Developer: Reload Window');
    await this.page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
    await this.waitUntil('the tab bar is connected again', () => this.page.evaluate(() => !!window.__tabGroupsPatch?.connected), 60_000);
    await this.dismissNotifications();
    await this.idle(1000);
  }

  /** Closes every tab, which also clears every open group, so the next test starts clean. */
  async closeAllTabs(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.runCommand('View: Close All Editors');
    await this.waitUntil('all tabs are closed and no groups are left', async () =>
      (await this.tabs()).length === 0 && (await this.page.evaluate(() => window.__tabGroupsPatch?.state?.groups.length ?? 0)) === 0,
    );
  }

  /** Clicks an item in an open quick pick by its label. */
  async pickFromList(label: string): Promise<void> {
    const row = this.page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first();
    await row.click();
    await this.idle();
  }

  // ------------------------------------------------------------------ waiting

  /** Polls `check` until it returns true (Trusted Types in VS Code block page.waitForFunction). */
  async waitUntil(what: string, check: () => Promise<boolean> | boolean, timeout = 10_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await check()) {
        return;
      }
      if (Date.now() - start > timeout) {
        throw new Error(`Timed out waiting until ${what}`);
      }
      await this.page.waitForTimeout(100);
    }
  }

  /** Gives VS Code and the extension time to react (tab events, state sync, redraw). */
  idle(ms = 400): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  // ------------------------------------------------------------------ internals

  private tabLocator(name: string) {
    return this.page
      .locator('.editor-group-container.active .tabs-container > .tab')
      .filter({ has: this.page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
      .first();
  }

  private chipLocator(group: string) {
    return this.page.locator('.tabs-container .tg-chip', { hasText: new RegExp(`^${escapeRegExp(group)}$`) }).first();
  }

  private async chooseContextMenuItem(path: string): Promise<void> {
    const steps = path.split('>').map((s) => s.trim());
    for (const [i, label] of steps.entries()) {
      const item = this.page.locator('.context-view .monaco-menu .action-item').filter({
        has: this.page.locator('.action-label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }),
      }).last();
      await item.waitFor({ state: 'visible', timeout: 5000 });
      if (i < steps.length - 1) {
        await item.hover();
        await this.idle(500);
      } else {
        await item.click();
      }
    }
    await this.idle();
  }

  private async dismissNotifications(): Promise<void> {
    await this.page.evaluate(() =>
      document.querySelectorAll('.notification-toast .codicon-notifications-clear, .notification-toast .codicon-close').forEach((b) => (b as HTMLElement).click()),
    );
  }
}

function findAppRoot(installDir: string): string {
  const direct = path.join(installDir, 'resources', 'app');
  if (fs.existsSync(direct)) {
    return direct;
  }
  for (const entry of fs.readdirSync(installDir)) {
    const candidate = path.join(installDir, entry, 'resources', 'app');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No resources/app folder under ${installDir}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

declare global {
  interface Window {
    __tabGroupsPatch?: {
      connected: boolean;
      state: { groups: { id: string; name: string; color: string; collapsed: boolean }[] } | null;
    };
  }
}
