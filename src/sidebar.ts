import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Bridge, UiAction } from './bridge';
import { FileIcon, FileIconTheme, IconFont } from './iconTheme';
import { Layout } from './layout';
import { order } from './membership';
import { GroupColor } from './model';
import { DropTarget, groupDropIndex, moveItem, planTabDrop, planTabsDrop } from './sidebarModel';
import { GroupStore } from './store';
import { tabUri } from './tabs';

export const SIDEBAR_VIEW_ID = 'tabPalette.sidebar';

/** What the side bar shows: every editor group's tabs, in tab bar order, plus the groups. */
export interface SidebarState {
  rows: SidebarRow[];
  groups: SidebarGroup[];
  /**
   * True while the tab bar is connected: then `selected` is the tab bar's own selection, and
   * Ctrl/Shift+click in the side bar selects through the tab bar, so both always agree.
   */
  selectionSync: boolean;
  /** Fonts of the file icon theme, for icons drawn as font characters. */
  fonts: IconFont[];
}

export interface SidebarRow {
  index: number;
  active: boolean;
  tabs: SidebarTab[];
}

export interface SidebarTab {
  /** `Uri.toString()` for file tabs, `#<label>` for others (as in `order()`). */
  key: string;
  label: string;
  /** Folder, shown when two tabs in the row have the same name. */
  description?: string;
  /** Full path, for the tooltip. */
  tooltip: string;
  /** The active tab of its row. */
  active: boolean;
  dirty: boolean;
  pinned: boolean;
  preview: boolean;
  /** Selected in the tab bar (Ctrl/Shift+click); the active tab counts as selected. */
  selected: boolean;
  groupId?: string;
  /** The file icon theme's icon; none for tabs that aren't files, or with no icon theme. */
  icon?: FileIcon;
}

export interface SidebarGroup {
  id: string;
  name: string;
  color: GroupColor;
  collapsed: boolean;
  closed: boolean;
  /** Files in the group (for closed groups, the tabs that reopen). */
  count: number;
}

/** Messages from the side bar page. Every field is checked before use. */
type Incoming =
  | { type: 'ready' }
  | { type: 'activate'; row: number; index: number; key: string }
  | { type: 'close'; row: number; index: number; key: string }
  | { type: 'toggle'; groupId: string }
  | { type: 'reopen'; groupId: string }
  | { type: 'dropTab'; row: number; index: number; key: string; target: DropTarget }
  | { type: 'dropGroup'; row: number; groupId: string; target: DropTarget }
  | { type: 'groupAction'; groupId: string; action: string; value?: unknown }
  /** Selected tabs (Ctrl/Shift+click): `tabs` = their { index, key } in the row. */
  | { type: 'dropTabs'; row: number; tabs: { index: number; key: string }[]; target: DropTarget }
  | { type: 'closeTabs'; row: number; tabs: { index: number; key: string }[] }
  /** Ctrl/Shift+click on a tab, done in the tab bar so VS Code selects it there too. */
  | { type: 'select'; row: number; index: number; key: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

/** What the group settings popup (the ⋮ button) can do; handled like the tab bar's group editor. */
const POPUP_ACTIONS = new Set(['rename', 'setColor', 'newTab', 'moveToNewWindow', 'close', 'ungroup', 'delete']);

/**
 * The "Tab Groups" view in the side bar: the tabs listed top to bottom like Chrome's vertical
 * tabs, each group under a header in its color. Drawn by resources/sidebar/sidebar.js.
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private pending: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: GroupStore,
    private readonly layout: Layout,
    private readonly groupAction: (action: UiAction) => Promise<void>,
    /** The connection to the tab bar, while the patch is on. */
    private readonly bridge: () => Bridge | undefined = () => undefined,
    private readonly icons: FileIconTheme = new FileIconTheme(),
  ) {
    this.subscriptions = [
      icons,
      icons.onDidChange(() => {
        this.allowIcons();
        this.refresh();
      }),
      store.onDidChange(() => this.refresh()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.refresh()),
      // A file's language picks its icon, and changing the language reopens the document.
      vscode.workspace.onDidOpenTextDocument(() => this.refresh()),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'resources', 'sidebar');
    this.allowIcons();
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => void this.handle(m));
    view.onDidChangeVisibility(() => this.refresh());
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Lets the page load the side bar's files and the file icon themes' icons and fonts. */
  private allowIcons(): void {
    if (this.view) {
      const media = vscode.Uri.joinPath(this.extensionUri, 'resources', 'sidebar');
      this.view.webview.options = { enableScripts: true, localResourceRoots: [media, ...FileIconTheme.resourceRoots()] };
    }
  }

  /** The current state of the tabs and groups, as the page draws it. */
  state(): SidebarState {
    const all = vscode.window.tabGroups.all;
    const bridge = this.bridge();
    const selectionSync = !!bridge && bridge.connections > 0;
    const activeRow = vscode.window.tabGroups.activeTabGroup;
    const webview = this.view?.webview;
    // The language picks the icon of files with no known name or extension (like Untitled-1).
    const languages = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d.languageId]));
    const rows = all.map((row, index) => {
      const selected = new Set(selectionSync ? bridge!.selectedIndexes(index) : []);
      const keys = order(row);
      const groupOf = (key: string) => this.layout.groupIn(row, key)?.id;
      // Tabs with the same name show their folder too.
      const named = new Map<string, number>();
      for (const tab of row.tabs) {
        named.set(tab.label, (named.get(tab.label) ?? 0) + 1);
      }
      return {
        index,
        active: row === activeRow,
        tabs: row.tabs.map((tab, i) => {
          const uri = tabUri(tab);
          const key = keys[i];
          const duplicate = named.get(tab.label)! > 1;
          return {
            key,
            label: tab.label,
            description: uri && duplicate ? vscode.workspace.asRelativePath(path.dirname(uri.fsPath)) : undefined,
            tooltip: uri ? (uri.scheme === 'file' ? uri.fsPath : uri.toString(true)) : tab.label,
            active: tab.isActive,
            dirty: tab.isDirty,
            pinned: tab.isPinned,
            preview: tab.isPreview,
            selected: selected.has(i),
            groupId: uri ? groupOf(key) : undefined,
            icon: uri && webview ? this.icons.iconFor(uri, languages.get(key), webview) : undefined,
          };
        }),
      };
    });
    const groups = this.store.all().map((g) => ({
      id: g.id,
      name: g.name.trim() ? g.name : '',
      color: g.color,
      collapsed: g.collapsed,
      closed: g.closed,
      count: g.uris.length,
    }));
    return { rows, groups, selectionSync, fonts: webview ? this.icons.fonts(webview) : [] };
  }

  /** Handles a message from the page (public for the integration tests). */
  async handle(message: unknown): Promise<void> {
    const m = message as Partial<Incoming> & Record<string, unknown>;
    const tabAt = () => {
      const row = Number.isInteger(m.row) ? vscode.window.tabGroups.all[m.row as number] : undefined;
      const index = m.index as number;
      // Ignore a click on a tab that has moved since the page was drawn.
      return row && Number.isInteger(index) && order(row)[index] === m.key ? { row, tab: row.tabs[index], index } : undefined;
    };
    // Several tabs of one row; ignored when any of them has moved since the page was drawn.
    const tabsAt = () => {
      const row = Number.isInteger(m.row) ? vscode.window.tabGroups.all[m.row as number] : undefined;
      const list = Array.isArray(m.tabs) ? (m.tabs as { index?: unknown; key?: unknown }[]) : [];
      if (!row || list.length === 0) {
        return undefined;
      }
      const keys = order(row);
      const indexes = [...new Set(list.map((t) => t?.index))].filter((i): i is number => Number.isInteger(i)).sort((a, b) => a - b);
      const valid = indexes.length === list.length && list.every((t) => Number.isInteger(t?.index) && keys[t.index as number] === t.key);
      return valid ? { row, indexes, tabs: indexes.map((i) => row.tabs[i]) } : undefined;
    };
    const group = () => (typeof m.groupId === 'string' ? this.store.get(m.groupId) : undefined);
    switch (m.type) {
      case 'ready':
        return this.post(true); // a page that just loaded has nothing to show yet
      case 'select': {
        const found = tabAt();
        const bridge = this.bridge();
        if (found && bridge && bridge.connections > 0) {
          bridge.clickTab(m.row as number, found.index, found.tab.label, {
            ctrl: m.ctrl === true,
            meta: m.meta === true,
            shift: m.shift === true,
          });
        }
        return;
      }
      case 'activate': {
        const found = tabAt();
        return found && this.layout.showTab(found.row, found.tab);
      }
      case 'close': {
        const found = tabAt();
        return void (found && (await vscode.window.tabGroups.close(found.tab)));
      }
      case 'toggle': {
        const g = group();
        return g && (g.collapsed ? this.layout.expand(g.id) : this.layout.collapse(g.id));
      }
      case 'reopen': {
        const g = group();
        return void (g && (await vscode.commands.executeCommand('tabPalette.openGroup', g.id)));
      }
      case 'dropTab': {
        const found = tabAt();
        const target = dropTarget(m.target);
        return found && target && this.dropTab(m.row as number, found.index, target);
      }
      case 'dropTabs': {
        const found = tabsAt();
        const target = dropTarget(m.target);
        return found && target && this.dropTabs(m.row as number, found.indexes, target);
      }
      case 'closeTabs': {
        const found = tabsAt();
        return void (found && (await vscode.window.tabGroups.close(found.tabs)));
      }
      case 'groupAction': {
        const g = group();
        return g && typeof m.action === 'string' && POPUP_ACTIONS.has(m.action)
          ? this.groupAction({ type: 'action', action: m.action, groupId: g.id, value: m.value })
          : undefined;
      }
      case 'dropGroup': {
        const g = group();
        const target = dropTarget(m.target);
        const row = Number.isInteger(m.row) ? vscode.window.tabGroups.all[m.row as number] : undefined;
        if (!g || !target || !row) {
          return;
        }
        const before = groupDropIndex(order(row), target, (k) => this.layout.groupIn(row, k)?.id);
        return before === undefined ? undefined : this.layout.moveGroupTo(g.id, m.row as number, before);
      }
    }
  }

  dispose(): void {
    clearTimeout(this.pending);
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private async dropTab(rowIndex: number, from: number, target: DropTarget): Promise<void> {
    const row = vscode.window.tabGroups.all[rowIndex];
    const keys = order(row);
    const key = keys[from];
    const groupOf = (k: string) => this.layout.groupIn(row, k)?.id;
    const plan = planTabDrop(keys, from, target, groupOf);
    if (!plan) {
      return;
    }
    if (plan.group && row.tabs[from].isPinned) {
      await this.layout.unpin([key]); // Chrome: pinned tabs are never in a group
    }
    await this.layout.moveTab(rowIndex, from, plan.to);
    if (plan.group) {
      // Keep the group's file list in the order of the tabs: insert before the next member.
      const after = moveItem(keys, from, plan.to).slice(plan.to + 1);
      const next = after.find((k) => groupOf(k) === plan.group);
      this.store.addUris(plan.group, [key], next);
      this.store.setCollapsed(plan.group, false);
    } else if (groupOf(key)) {
      this.store.removeUris([key]);
    }
    this.store.pruneEmpty();
  }

  private async dropTabs(rowIndex: number, from: number[], target: DropTarget): Promise<void> {
    if (from.length === 1) {
      return this.dropTab(rowIndex, from[0], target);
    }
    const row = vscode.window.tabGroups.all[rowIndex];
    const keys = order(row);
    const groupOf = (k: string) => this.layout.groupIn(row, k)?.id;
    const plan = planTabsDrop(keys, from, target, groupOf);
    if (!plan) {
      return;
    }
    const dragged = from.map((i) => keys[i]);
    const files = dragged.filter((k) => !k.startsWith('#'));
    if (plan.group) {
      await this.layout.unpin(files); // Chrome: pinned tabs are never in a group
    }
    await this.layout.moveTabsTogether(rowIndex, dragged, plan.othersBefore);
    if (plan.group) {
      const last = plan.othersBefore + dragged.length - 1;
      const next = plan.order.slice(last + 1).find((k) => groupOf(k) === plan.group);
      this.store.addUris(plan.group, files, next);
      this.store.setCollapsed(plan.group, false);
    }
    if (plan.leaving.length > 0) {
      this.store.removeUris(plan.leaving);
    }
    this.store.pruneEmpty();
  }

  /**
   * Opens the group settings popup on the group's header (for a group made or edited from the
   * side bar's menu). False when the side bar is not shown.
   */
  editGroup(groupId: string): boolean {
    if (!this.view?.visible) {
      return false;
    }
    // Draw the new group first, so its header is there for the popup.
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.post();
    void this.view.webview.postMessage({ type: 'edit', groupId });
    this.lastEdit = groupId;
    return true;
  }

  /** The group whose settings were last opened through editGroup (for tests). */
  lastEdit: string | undefined;

  /** Redraws soon; several changes in a row (a tab move fires a few events) draw once. */
  refresh(): void {
    if (!this.view?.visible || this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 30);
  }

  /**
   * Sends the state to the page. Several events often leave nothing changed for the page
   * (a tab change it does not show): then nothing is sent and the page does not redraw.
   * `force` sends anyway (a page that just loaded has nothing yet).
   */
  private post(force = false): void {
    if (!this.view) {
      return;
    }
    const state = this.state();
    const signature = JSON.stringify(state);
    if (!force && signature === this.lastPosted) {
      return;
    }
    this.lastPosted = signature;
    void this.view.webview.postMessage({ type: 'state', state });
  }

  private lastPosted: string | undefined;

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Tab Groups</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="root" role="tree" aria-label="Open tabs and tab groups"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function dropTarget(value: unknown): DropTarget | undefined {
  const t = value as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') {
    return undefined;
  }
  if (t.end === true) {
    return { end: true };
  }
  if (typeof t.header === 'string') {
    return { header: t.header };
  }
  if (Number.isInteger(t.index) && typeof t.after === 'boolean') {
    return { index: t.index as number, after: t.after };
  }
  return undefined;
}

