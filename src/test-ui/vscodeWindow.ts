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
import { ElectronApplication, Frame, Page, _electron } from 'playwright-core';
import { applyPatch, findWorkbenchHtml, patchStatus, removePatch, scriptName } from '../patch';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test-fixtures');
const PATCH_SCRIPT = path.join(ROOT, 'resources', 'patch', 'tab-groups-patch.js');

/** Where a dragged tab is dropped: left half of a tab, right half of a tab, a group's chip, or the empty end of the tab bar. */
export type DropSpot = { before: string } | { after: string } | { onChip: string } | { end: true };

/** What one tab in the tab bar looks like to the user. */
export interface TabView {
  name: string;
  /** Name of the group it is drawn in, or null. An unnamed group is ''. */
  group: string | null;
  /** Color of the group line under the tab (CSS rgb), or null. */
  lineColor: string | null;
  active: boolean;
  /** Selected (Ctrl/Shift+click); the active tab is selected too. */
  selected: boolean;
  /** Hidden because its group is collapsed. */
  hidden: boolean;
  /** Shows Chrome's rounded outline (active tab of a group). */
  outlined: boolean;
  pinned: boolean;
}

/** What one group chip looks like to the user. */
export interface ChipView {
  name: string;
  color: string;
  collapsed: boolean;
  /** Unnamed groups show a small colored dot instead of a label. */
  isDot: boolean;
}

/**
 * The tests name the nine color slots by their default Chrome color, to stay readable:
 * 'Grey' = tabPalette.color1 (shown as "Color 1" in the group editor), 'Blue' = color2, …
 */
const CHROME_NAMES = ['Grey', 'Blue', 'Red', 'Yellow', 'Green', 'Pink', 'Purple', 'Cyan', 'Orange'];

/** Group editor swatch title ("Color 1" …) for a Chrome color name ('Grey' …). */
const swatchTitle = (chromeName: string) => `Color ${CHROME_NAMES.indexOf(chromeName) + 1}`;

/**
 * Default dark-theme CSS color of each slot, by Chrome name ('Grey' … 'Orange'), plus the other
 * theme colors by id ('UngroupDropLine'), read from package.json.
 */
export const COLORS: Record<string, string> = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const colors: Record<string, string> = {};
  for (const c of pkg.contributes.colors as { id: string; defaults: { dark: string } }[]) {
    const id = c.id.replace('tabPalette.', '');
    const hex = c.defaults.dark.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const slot = /^color(\d)$/.exec(id);
    colors[slot ? CHROME_NAMES[+slot[1] - 1] : id[0].toUpperCase() + id.slice(1)] = `rgb(${r}, ${g}, ${b})`;
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
        // Keep pickers open if another window on the desktop briefly takes focus during a run.
        'workbench.quickOpen.closeOnFocusLost': false,
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

  /**
   * Brings the test window to the front. Popups such as the group editor close when the
   * window loses focus, so each test starts with the window focused.
   */
  async focus(): Promise<void> {
    await this.app.evaluate(({ BrowserWindow }) => {
      // The first window opened (a window closed by a test can still be listed for a moment).
      type Win = { id: number; isDestroyed(): boolean; show(): void; focus(): void };
      const all: Win[] = BrowserWindow.getAllWindows();
      const w = all.filter((b) => !b.isDestroyed()).sort((x, y) => x.id - y.id)[0];
      w.show();
      w.focus();
    });
    await this.page.bringToFront();
  }

  /** True when VS Code's workbench.html is back to the original and our script files are gone. */
  isUnpatched(): boolean {
    return patchStatus(this.workbenchHtml, '') === 'unpatched' && this.installedScripts().length === 0;
  }

  /** Our script files next to VS Code's workbench.html. */
  installedScripts(): string[] {
    return fs.readdirSync(path.dirname(this.workbenchHtml)).filter((f) => f.startsWith('tab-groups-patch'));
  }

  /** File name of this extension's current tab bar script once installed. */
  expectedScript(): string {
    return scriptName(fs.readFileSync(PATCH_SCRIPT, 'utf8'));
  }

  /**
   * Changes a user setting by editing the test profile's settings.json, like a user editing
   * the file (VS Code picks up the change by itself). `undefined` removes the setting.
   */
  async setUserSetting(key: string, value: unknown): Promise<void> {
    const file = path.join(this.profileDir, 'user', 'User', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (value === undefined) {
      delete settings[key];
    } else {
      settings[key] = value;
    }
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    await this.idle(1000); // VS Code notices the file change
  }

  /**
   * Sets `workbench.colorCustomizations` by editing the test profile's settings.json, like a
   * user editing the file, and waits until VS Code has applied it (the theme colors changed).
   * `undefined` removes the setting again.
   */
  async setColorCustomizations(colors: Record<string, string> | undefined): Promise<void> {
    const file = path.join(this.profileDir, 'user', 'User', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const before = (settings['workbench.colorCustomizations'] ?? {}) as Record<string, string>;
    if (colors === undefined) {
      delete settings['workbench.colorCustomizations'];
    } else {
      settings['workbench.colorCustomizations'] = colors;
    }
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    const themeColor = (id: string) =>
      this.page.evaluate(
        (name) => getComputedStyle(document.querySelector('.monaco-workbench')!).getPropertyValue(name).trim().toLowerCase(),
        `--vscode-${id.replace('.', '-')}`,
      );
    for (const [id, value] of Object.entries(colors ?? before)) {
      const wanted = value.toLowerCase();
      await this.waitUntil(`VS Code applies the color setting for ${id}`, async () => ((await themeColor(id)) === wanted) === (colors !== undefined), 15_000);
    }
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
      // All tab bars of the active editor group (pinned tabs can have a tab bar of their own).
      const group = document.querySelector('.editor-group-container.active') ?? document;
      return [...group.querySelectorAll('.tabs-container > .tab')].map((node) => {
        const tab = node as HTMLElement;
        const line = tab.querySelector(':scope > .tg-line');
        const outline = tab.querySelector(':scope > .tg-u');
        const style = getComputedStyle(tab);
        return {
          name: tab.querySelector('.label-name')?.textContent ?? '?',
          group: groupName(tab.dataset.tgGid),
          lineColor: line && getComputedStyle(line).display !== 'none' ? getComputedStyle(line).borderBottomColor : tab.dataset.tgGid ? 'hidden' : null,
          active: tab.classList.contains('active'),
          selected: tab.classList.contains('selected'),
          hidden: style.display === 'none' || tab.getBoundingClientRect().width === 0,
          outlined: !!outline && getComputedStyle(outline).display !== 'none',
          pinned: tab.classList.contains('sticky'),
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

  /** Runs `action` and returns the VS Code window it opens (e.g. "Move group to new window"). */
  async newWindowFrom(action: () => Promise<void>): Promise<Page> {
    const opened = this.app.waitForEvent('window', { timeout: 10_000 });
    await action();
    return opened;
  }

  /** In another VS Code window: its tabs (names) and group chips (names), as drawn. */
  static tabBarOf(page: Page): Promise<{ tabs: string[]; chips: string[] }> {
    return page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.tabs-container > .tab .label-name')].map((e) => e.textContent ?? ''),
      chips: [...document.querySelectorAll('.tg-chip')].map((e) => e.textContent ?? ''),
    }));
  }

  /** Whether the group editor bubble is open. */
  editorIsOpen(): Promise<boolean> {
    return this.page.locator('.tg-popup').isVisible();
  }

  /** The color (Chrome name, e.g. 'Purple') whose swatch is marked as selected in the group editor. */
  async selectedSwatch(): Promise<{ color: string | null; hasCenterDot: boolean }> {
    const swatch = await this.page.evaluate(() => {
      const el = document.querySelector('.tg-popup .tg-color.tg-selected') as HTMLElement | null;
      return { title: el?.title ?? null, hasCenterDot: !!el && getComputedStyle(el).backgroundImage !== 'none' };
    });
    const slot = swatch.title ? /^Color (\d)$/.exec(swatch.title) : null;
    return { color: slot ? CHROME_NAMES[+slot[1] - 1] : swatch.title, hasCenterDot: swatch.hasCenterDot };
  }

  /** Tooltips of the nine swatches in the open group editor, left to right. */
  swatchTitles(): Promise<string[]> {
    return this.page.evaluate(() => [...document.querySelectorAll('.tg-popup .tg-color')].map((b) => (b as HTMLElement).title));
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
    await this.settled();
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 10 });
    await this.settled(300); // the group editor sends the name 120 ms after the last key
  }

  async clickTab(name: string, modifiers: ('Control' | 'Shift')[] = []): Promise<void> {
    await this.tabLocator(name).click({ modifiers });
    await this.settled();
  }

  /** Clicks a file in the Explorer view (opening the Explorer first if needed). */
  async clickExplorerItem(name: string): Promise<void> {
    const item = this.page.locator('.explorer-folders-view .monaco-list-row', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }).first();
    if (!(await item.isVisible())) {
      await this.page.keyboard.press('Control+Shift+E');
      await item.waitFor({ state: 'visible', timeout: 5000 });
    }
    await item.click();
    await this.settled();
  }

  /** Right-clicks a tab and picks an item from its context menu (use 'Tab Group > Remove Tab from Group' for a submenu). */
  async tabMenu(name: string, item: string): Promise<void> {
    await this.tabLocator(name).click({ button: 'right' });
    await this.chooseContextMenuItem(item);
  }

  /** Clicks a group chip (collapses or expands the group). */
  async clickChip(group: string): Promise<void> {
    await this.chipLocator(group).click();
    await this.settled();
  }

  /** Right-clicks a group chip, which opens the group editor. */
  async openGroupEditor(group: string): Promise<void> {
    await this.chipLocator(group).click({ button: 'right' });
    await this.page.waitForSelector('.tg-popup');
  }

  /** In the open group editor: clicks a color swatch by its default Chrome color, e.g. 'Orange' (= "Color 9"). */
  async pickColor(color: string): Promise<void> {
    await this.page.click(`.tg-popup .tg-color[title="${swatchTitle(color)}"]`);
    await this.settled();
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
    await this.settled();
  }

  /**
   * Drags a tab with the mouse and drops it: on the left half of tab `before`, the right half
   * of tab `after`, or on a group's chip (`onChip`).
   */
  async dragTab(name: string, to: DropSpot): Promise<void> {
    await this.startTabDrag(name, to);
    await this.drop();
  }

  /** Like dragTab, but holds the tab over the drop spot with the mouse still down. */
  async startTabDrag(name: string, to: DropSpot): Promise<void> {
    const from = await this.tabLocator(name).boundingBox();
    if (!from) {
      throw new Error(`no tab named ${name}`);
    }
    const y = from.y + from.height / 2;
    await this.page.mouse.move(from.x + from.width / 2, y);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + from.width / 2 + 10, y, { steps: 3 });
    await this.idle(150);
    // Measure the drop spot only now: the tab bar may still shift (e.g. a chip that was just
    // renamed gets its final width) until the drag is under way.
    let x: number;
    let y2: number;
    if ('end' in to) {
      // the empty part of the tab bar, after the last tab
      const tabs = await this.page.locator('.editor-group-container.active .tabs-container > .tab').all();
      const last = (await tabs[tabs.length - 1].boundingBox())!;
      x = last.x + last.width + 60;
      y2 = last.y + last.height / 2;
    } else {
      const target = await ('onChip' in to ? this.chipLocator(to.onChip) : this.tabLocator('before' in to ? to.before : to.after)).boundingBox();
      if (!target) {
        throw new Error('drop target not found');
      }
      x = 'after' in to ? target.x + target.width * 0.75 : 'before' in to ? target.x + target.width * 0.25 : target.x + target.width / 2;
      y2 = target.y + target.height / 2;
    }
    await this.page.mouse.move(x, y2, { steps: 12 });
    // Chromium can skip drag-over events when moves come quickly; a real user's mouse keeps
    // sending them while it rests. Settle on the spot so the page sees the final position.
    for (const dx of [1, 0]) {
      await this.idle(60);
      await this.page.mouse.move(x + dx, y2);
    }
    await this.idle(120);
  }

  /** Releases the mouse to finish a drag started with startTabDrag. */
  async drop(): Promise<void> {
    await this.page.mouse.up();
    // A tab dropped out of its group leaves it 300 ms later (the extension lets VS Code move it first).
    await this.settled(400);
  }

  /**
   * While a tab is being dragged: where VS Code's drop marker (the vertical line) is drawn,
   * as an x position, or null when no marker is shown.
   */
  dropMarkerX(): Promise<number | null> {
    return this.page.evaluate(() => {
      const right = document.querySelector('.tabs-container > .tab.drop-target-right');
      if (right) {
        return right.getBoundingClientRect().left + parseFloat(getComputedStyle(right, '::before').left);
      }
      const left = document.querySelector('.tabs-container > .tab.drop-target-left');
      return left ? left.getBoundingClientRect().right : null;
    });
  }

  /** While a tab is being dragged: the color of VS Code's drop line (CSS rgb), or null when none is shown. */
  dropMarkerColor(): Promise<string | null> {
    return this.page.evaluate(() => {
      const right = document.querySelector('.tabs-container > .tab.drop-target-right');
      if (right) {
        return getComputedStyle(right, '::before').backgroundColor;
      }
      const left = document.querySelector('.tabs-container > .tab.drop-target-left');
      return left ? getComputedStyle(left, '::after').backgroundColor : null;
    });
  }

  /** Left edge of a group's chip, as an x position. */
  async chipLeft(group: string): Promise<number> {
    return (await this.chipLocator(group).boundingBox())!.x;
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
    await this.settled(400); // the extension moves the group's tabs one by one
  }

  /**
   * Reloads the window with a command that reloads it (Developer: Reload Window by default),
   * and waits until the tab bar is connected again.
   */
  async reload(command = 'Developer: Reload Window'): Promise<void> {
    // Wait for the new page to load, not the old one that is still on screen when the command runs.
    const loaded = this.page.waitForEvent('load', { timeout: 90_000 });
    await this.runCommand(command);
    await loaded;
    await this.page.waitForSelector('.monaco-workbench', { timeout: 90_000 });
    // While the page is still being replaced, a check can throw; that just means "not yet".
    const connected = () => this.page.evaluate(() => !!window.__tabGroupsPatch?.connected).catch(() => false);
    await this.waitUntil('the tab bar is connected again', connected, 90_000);
    await this.dismissNotifications();
    await this.settled(500);
  }

  /** Closes every tab (Ctrl+K Ctrl+W), which also clears every open group, so the next test starts clean. */
  async closeAllTabs(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Control+K');
    await this.page.keyboard.press('Control+W');
    await this.waitUntil('all tabs are closed and no groups are left', () =>
      this.page.evaluate(
        () => document.querySelectorAll('.tabs-container > .tab').length === 0 && (window.__tabGroupsPatch?.state?.groups.length ?? 0) === 0,
      ),
    );
  }

  /**
   * Clicks an item in an open quick pick by its label. A click that comes right after the
   * picker opens can be ignored; then the picker still shows the same items, so click again.
   * (The picker may also be replaced by the next prompt, e.g. a group list after a command.)
   */
  async pickFromList(label: string): Promise<void> {
    const row = this.page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    const items = () =>
      this.page.evaluate(() => {
        const widget = document.querySelector('.quick-input-widget') as HTMLElement | null;
        if (!widget || widget.style.display === 'none' || widget.offsetParent === null) {
          return '(closed)';
        }
        return [...widget.querySelectorAll('.quick-input-list .monaco-list-row')].map((r) => r.getAttribute('aria-label')).join('|');
      });
    const before = await items();
    await row.hover();
    for (let attempt = 0; attempt < 4; attempt++) {
      await row.click({ timeout: 3000 }).catch(() => undefined);
      const changed = await this.waitUntil('the picker reacts', async () => (await items()) !== before, 700).then(
        () => true,
        () => false,
      );
      if (changed) {
        break;
      }
    }
    await this.settled();
  }

  /** In an open quick pick: the color of the dot icon in front of the item `label` (from its SVG image). */
  pickerDotColor(label: string): Promise<string | null> {
    return this.page.evaluate((l) => {
      const row = [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find((r) => (r.getAttribute('aria-label') ?? '').startsWith(l));
      const icon = row?.querySelector('.quick-input-list-icon') as HTMLElement | null;
      const m = /base64,([^"')]+)/.exec(icon?.style.backgroundImage ?? '');
      return m ? (/fill="([^"]+)"/.exec(atob(m[1]))?.[1] ?? null) : null;
    }, label);
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
      await this.page.waitForTimeout(25);
    }
  }

  /**
   * Waits until VS Code and the extension have finished reacting to the last action: the tab
   * bar, the groups the extension sent, and any open menu, picker or group editor stay the
   * same for `quietMs`. Returns as soon as that is the case (gives up waiting after `maxMs`).
   */
  async settled(quietMs = 200, maxMs = 4000): Promise<void> {
    const snapshot = () =>
      this.page
        .evaluate(() => {
          const tabs = [...document.querySelectorAll('.tabs-container > .tab')]
            .map((t) => `${t.className}:${t.querySelector('.label-name')?.textContent}`)
            .join('|');
          const quickInput = document.querySelector('.quick-input-widget') as HTMLElement | null;
          return [
            JSON.stringify(window.__tabGroupsPatch?.state ?? null),
            tabs,
            document.querySelectorAll('.tg-popup, .context-view .monaco-menu, .tg-chip').length,
            quickInput?.style.display,
            document.querySelectorAll('.quick-input-list .monaco-list-row').length,
          ].join('#');
        })
        .catch(() => 'reloading');
    const start = Date.now();
    let last = await snapshot();
    let quietSince = Date.now();
    while (Date.now() - quietSince < quietMs && Date.now() - start < maxMs) {
      await this.page.waitForTimeout(25);
      const now = await snapshot();
      if (now !== last) {
        last = now;
        quietSince = Date.now();
      }
    }
  }

  /** Waits a fixed time: for mouse moves during a drag, and for VS Code to notice a settings file change. */
  idle(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  // ------------------------------------------------------------------ the Tab Groups side bar

  /** Opens the Tab Groups view from the Activity Bar and returns its page (a frame inside the window). */
  async openSidebar(): Promise<Frame> {
    await this.page.locator('.activitybar .action-item a[aria-label^="Tab Groups"]').click();
    return this.sidebar();
  }

  /** The Tab Groups view's page, once it has drawn the tabs. */
  async sidebar(): Promise<Frame> {
    for (const start = Date.now(); Date.now() - start < 10_000; await this.idle(50)) {
      for (const frame of this.page.frames()) {
        if (await frame.$('#root .row').catch(() => null)) {
          return frame;
        }
      }
    }
    throw new Error('The Tab Groups view did not open');
  }

  /**
   * The side bar as text, one line per row: a group header as `[name]` (`[name +]` when collapsed),
   * a tab as its name, indented when it is in a group.
   */
  async sidebarLines(): Promise<string[]> {
    const frame = await this.sidebar();
    return frame.evaluate(() =>
      [...document.querySelectorAll('.group-header, .tab')].map((el) =>
        el.classList.contains('group-header')
          ? '[' + el.querySelector('.group-name')!.textContent + (el.closest('.group')!.classList.contains('collapsed') ? ' +' : '') + ']'
          : (el.closest('.members') ? '  ' : '') + el.querySelector('.label')!.textContent,
      ),
    );
  }

  /** Drags a tab in the side bar onto another tab (its upper or lower half), with the mouse. */
  async dragInSidebar(tab: string, onto: string, half: 'upper' | 'lower'): Promise<void> {
    const frame = await this.sidebar();
    const named = (name: string) => frame.locator('.tab', { has: frame.locator('.label', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) });
    const target = named(onto);
    const box = await target.boundingBox();
    await named(tab)
      .dragTo(target, { targetPosition: { x: 40, y: half === 'upper' ? 4 : box!.height - 4 } });
  }

  /** Hovers a group header in the side bar and clicks its ⋮ button (`group` '' = the unnamed group). */
  async openSidebarGroupSettings(group: string): Promise<Frame> {
    const frame = await this.sidebar();
    const header = frame.locator('.group-header').filter({ has: frame.locator('.group-name', { hasText: new RegExp(`^${escapeRegExp(group)}$`) }) });
    await header.hover();
    await header.locator('.more').click();
    await frame.locator('.popup').waitFor();
    return frame;
  }

  /** Clicks a tab in the side bar, optionally with Ctrl or Shift held (to select several). */
  async clickSidebarTab(name: string, modifiers: ('Control' | 'Shift')[] = []): Promise<void> {
    const frame = await this.sidebar();
    await frame.locator('.tab', { has: frame.locator('.label', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) }).click({ modifiers });
  }

  /** How many times the tab bar script has redrawn the groups so far. */
  tabBarRenders(): Promise<number> {
    return this.page.evaluate(() => window.__tabGroupsPatch?.renders ?? 0);
  }

  /** Right-clicks a tab in the side bar and picks an item from its context menu. */
  async sidebarTabMenu(name: string, item: string): Promise<void> {
    const frame = await this.sidebar();
    await frame.locator('.tab', { has: frame.locator('.label', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) }).click({ button: 'right' });
    await this.chooseContextMenuItem(item);
  }

  /**
   * Right-clicks a tab in the side bar and reads the menu that opens: its items in order, '---'
   * between sections, and '(off)' after a disabled item. The menu is closed again.
   */
  async sidebarTabMenuItems(name: string): Promise<string[]> {
    const frame = await this.sidebar();
    await frame.locator('.tab', { has: frame.locator('.label', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) }).click({ button: 'right' });
    const menu = this.page.locator('.context-view .monaco-menu');
    await menu.waitFor({ state: 'visible', timeout: 5000 });
    const items = await menu.locator('.action-item').evaluateAll((all) =>
      all.map((li) =>
        li.querySelector('.action-label.separator') || li.classList.contains('separator')
          ? '---'
          : (li.querySelector('.action-label')?.textContent ?? '').trim() + (li.classList.contains('disabled') ? ' (off)' : ''),
      ),
    );
    await this.page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 5000 });
    return items;
  }

  /** Names of the tabs selected (Ctrl/Shift+click) in the side bar. */
  async sidebarSelection(): Promise<string[]> {
    const frame = await this.sidebar();
    return frame.locator('.tab.selected .label').allTextContents();
  }

  /** The file icon of a tab in the tab bar: the icon font character VS Code draws before its name. */
  async tabBarIcon(name: string): Promise<string> {
    return this.tabLocator(name).locator('.monaco-icon-label').first().evaluate((el) => getComputedStyle(el, '::before').content.replace(/^"|"$/g, ''));
  }

  /** The file icon of a tab in the side bar: its font character and whether that font has loaded. */
  async sidebarIcon(name: string): Promise<{ char: string; fontLoaded: boolean; image: string }> {
    const frame = await this.sidebar();
    return frame
      .locator('.tab', { has: frame.locator('.label', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
      .locator('.icon')
      .evaluate(async (el) => {
        await document.fonts.ready;
        const style = (el as HTMLElement).style;
        const family = style.fontFamily;
        return {
          char: el.textContent ?? '',
          fontLoaded: !!family && document.fonts.check('16px ' + family, el.textContent ?? ''),
          image: style.backgroundImage,
        };
      });
  }

  /** Clicks a group header in the side bar. */
  async clickSidebarHeader(group: string): Promise<void> {
    const frame = await this.sidebar();
    await frame.locator('.group-header', { hasText: group }).click();
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
      await item.hover(); // like a user: move onto the item first (this opens a submenu)
      if (i === steps.length - 1) {
        // VS Code's menus ignore a click that comes too soon after they open. If the menu is
        // still open after the click, it was ignored: click again. A submenu that just opened
        // ignores clicks a little longer, so wait for it first.
        if (steps.length > 1) {
          await this.idle(150);
        }
        const menu = this.page.locator('.context-view .monaco-menu').first(); // with a submenu open there are two
        for (let attempt = 0; attempt < 4; attempt++) {
          await item.click({ timeout: 3000 }).catch(() => undefined); // gone already = the previous click worked
          if (await menu.waitFor({ state: 'hidden', timeout: 700 }).then(() => true, () => false)) {
            break;
          }
        }
      }
    }
    await this.settled();
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
      renders: number;
    };
  }
}
