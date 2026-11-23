import * as path from 'path';
import * as vscode from 'vscode';
import { Bridge, GoToTabRow, UiAction } from './bridge';
import { colorIconFactory } from './colorIcons';
import { Layout, stepGroup } from './layout';
import { GROUP_COLORS, GroupColor, TabGroup, colorLabel, displayName, isGroupColor } from './model';
import type { Settings } from './settings';
import { GO_TO_GROUP_COMMANDS } from './shortcuts';
import { GroupStore } from './store';
import { t, tabCount } from './text';
import { CloseGuard, activeTabUri, isOtherTab, menuTabUri, openFiles, openUris, selectedTabUris, tabUri } from './tabs';

const NEW_GROUP = '__new__';
const REMOVE = '__remove__';

export interface CommandDeps {
  store: GroupStore;
  guard: CloseGuard;
  layout: Layout;
  /** Undefined until the workbench patch is enabled. */
  bridge: () => Bridge | undefined;
  /** Opens the group settings in the side bar; false when the side bar is not shown. */
  editInSidebar?: (groupId: string) => boolean;
  /** The user's settings (the group colors for the pickers' dots). */
  settings: () => Settings;
}

export function registerCommands(ctx: vscode.ExtensionContext, deps: CommandDeps): (action: UiAction) => Promise<void> {
  const { store, guard, layout } = deps;
  /** A dot in the group color for the pickers; follows the user's color settings. */
  const colorIcon = colorIconFactory(ctx, deps.settings);
  /** The group tabs were last added to (or made with), first in the group picker. */
  let lastUsedGroup: string | undefined;

  // ---------- prompts (fallbacks when the in-tab-bar editor is not available) ----------

  const promptName = (value = '', title = t('group.name')) =>
    vscode.window.showInputBox({ title, value, placeHolder: t('group.namePlaceholderOptional') });

  async function pickColor(current?: GroupColor): Promise<GroupColor | undefined> {
    type ColorItem = vscode.QuickPickItem & { color: GroupColor };
    const picked = await vscode.window.showQuickPick<ColorItem>(
      GROUP_COLORS.map((color) => ({
        label: colorLabel(color),
        description: color === current ? t('color.current') : undefined,
        iconPath: colorIcon(color),
        color,
      })),
      { title: t('group.color') },
    );
    return picked?.color;
  }

  /**
   * Chrome's "Add tab to group" submenu: New group first, then existing groups. For a grouped
   * tab (`exclude`), "Remove from group" too: the tab bar's menu shows "Add Tab to Group…" on a
   * grouped tab that shows no file (like Git Graph), as it cannot tell that it is grouped.
   */
  async function pickGroup(placeHolder: string, exclude?: string): Promise<string | undefined> {
    type GroupItem = vscode.QuickPickItem & { id: string };
    const items: GroupItem[] = [{ label: `$(add) ${t('group.new')}`, id: NEW_GROUP }];
    if (exclude) {
      items.push({ label: `$(close) ${t('group.remove')}`, id: REMOVE });
    }
    const groups = store.all().filter((g) => g.id !== exclude && !g.closed);
    const item = (g: TabGroup): GroupItem => ({ label: displayName(g), description: tabCount(g.uris.length), iconPath: colorIcon(g.color), id: g.id });
    // The group tabs were last added to comes first, already selected: Enter adds to it again.
    const last = groups.find((g) => g.id === lastUsedGroup);
    if (last) {
      items.unshift(item(last), { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' });
    }
    const others = groups.filter((g) => g !== last);
    if (others.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, id: '' }, ...others.map(item));
    }
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.id;
  }

  /** Chrome: a new group gets the next color and opens its editor bubble right away. */
  async function createGroup(uris: string[], fromSidebar = false): Promise<TabGroup | undefined> {
    uris = await layout.openMissing(uris);
    if (uris.length === 0) {
      return undefined;
    }
    await layout.unpin(uris);
    const group = store.create('', store.nextColor(), uris);
    lastUsedGroup = group.id;
    await layout.placeInGroup(uris);
    const bridge = deps.bridge();
    if (fromSidebar && deps.editInSidebar?.(group.id)) {
      // Made from the side bar's menu: the settings open there.
    } else if (bridge && bridge.connections > 0) {
      bridge.requestEdit(group.id);
    } else {
      const name = await promptName();
      if (name) {
        store.rename(group.id, name);
      }
    }
    return group;
  }

  async function addTo(groupId: string, uris: string[]): Promise<void> {
    uris = await layout.openMissing(uris);
    if (uris.length === 0) {
      return;
    }
    await layout.unpin(uris);
    store.addUris(groupId, uris);
    lastUsedGroup = groupId;
    store.setCollapsed(groupId, false);
    await layout.placeInGroup(uris);
    store.pruneEmpty();
  }

  // ---------- argument resolution ----------

  function resolveFiles(arg: unknown, multi: unknown): string[] {
    const toString = (x: unknown): string | undefined => (x instanceof vscode.Uri ? x.toString() : sidebarArg(x).uri);
    if (Array.isArray(multi) && multi.length > 0) {
      const all = multi.map(toString).filter((s): s is string => !!s);
      if (all.length > 0) {
        return all;
      }
    }
    const single = (arg instanceof vscode.Uri ? menuTabUri(arg, multi)?.toString() : toString(arg)) ?? activeTabUri()?.toString();
    return single ? [single] : [];
  }

  /** The group a command is for; `placeHolder` asks for one when nothing tells. */
  async function resolveGroup(arg: unknown, placeHolder: string): Promise<TabGroup | undefined> {
    const fromSidebar = sidebarArg(arg);
    if (fromSidebar.groupId) {
      return store.get(fromSidebar.groupId);
    }
    if (fromSidebar.uri) {
      arg = vscode.Uri.parse(fromSidebar.uri);
    }
    if (typeof arg === 'string') {
      return store.get(arg);
    }
    if (arg instanceof vscode.Uri) {
      const group = store.groupOf(arg.toString());
      if (group) {
        return group;
      }
    }
    const active = activeTabUri();
    const fromActive = active ? store.groupOf(active.toString()) : undefined;
    if (fromActive) {
      return fromActive;
    }
    if (store.all().length === 0) {
      void vscode.window.showInformationMessage(t('group.noneYet'));
      return undefined;
    }
    type GroupItem = vscode.QuickPickItem & { id: string };
    const picked = await vscode.window.showQuickPick<GroupItem>(
      store.all().map((g) => ({ label: displayName(g), iconPath: colorIcon(g.color), id: g.id, description: g.closed ? t('group.closed') : undefined })),
      { placeHolder },
    );
    return picked ? store.get(picked.id) : undefined;
  }

  const noFiles = () => void vscode.window.showInformationMessage(t('tab.openFileFirst'));

  /** The selected tabs for a tab context-menu command (`arg`, `context` = the right-clicked tab). */
  const selectedTabs = async (arg: unknown, context: unknown) => {
    const fromSidebar = sidebarArg(arg).uris; // the tabs selected in the side bar
    if (fromSidebar && fromSidebar.length > 0) {
      return fromSidebar;
    }
    const anchor = arg instanceof vscode.Uri ? menuTabUri(arg, context) : undefined;
    return selectedTabUris(anchor, (key) => deps.bridge()?.selectedUris(key));
  };

  // ---------- group actions (shared by commands and the chip editor) ----------

  const groupActions: Record<string, (group: TabGroup, value?: unknown) => unknown> = {
    toggleCollapse: (g) => (g.collapsed ? layout.expand(g.id) : layout.collapse(g.id)),
    rename: (g, value) => typeof value === 'string' && store.rename(g.id, value.slice(0, 200)),
    setColor: (g, value) => isGroupColor(value) && store.setColor(g.id, value),
    newTab: async (g) => {
      const uri = await pickWorkspaceFile(t('group.newTabIn', displayName(g)));
      if (uri) {
        await openFiles([uri.toString()]);
        await addTo(g.id, [uri.toString()]);
      }
    },
    moveToNewWindow: (g) => layout.moveToNewWindow(g.id),
    // Chip dragged in the tab bar: { row, index } = drop before the tab at index in that tab row.
    moveGroup: (g, value) => {
      const v = value as { row?: unknown; index?: unknown } | undefined;
      if (v && Number.isInteger(v.row) && Number.isInteger(v.index)) {
        return layout.moveGroupTo(g.id, v.row as number, v.index as number);
      }
    },
    // Tabs dropped onto one of the group's tabs: { row, labels } = the tab row and the dragged tabs' labels.
    joinOnDrop: (g, value) => {
      const drop = droppedTabs(value);
      return drop && layout.joinDroppedTabs(g.id, drop.row, drop.labels);
    },
    // Tabs of this group dropped outside it: { row, labels } = the tab row and the dragged tabs' labels.
    leaveOnDrop: (g, value) => {
      const drop = droppedTabs(value);
      return drop && layout.leaveDroppedTabs(g.id, drop.row, drop.labels);
    },
    close: (g) => layout.close(g.id),
    ungroup: (g) => store.remove(g.id),
    delete: async (g) => {
      // Stop if the user cancelled a save prompt for a modified tab.
      if (await guard.closeTabsFor(g.uris)) {
        store.remove(g.id);
      }
    },
  };

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'tabPalette.addToGroup': async (arg, multi) => {
      const uris = resolveFiles(arg, multi);
      if (uris.length === 0) {
        return noFiles();
      }
      const current = uris.length === 1 ? store.groupOf(uris[0]) : undefined;
      const id = current || store.all().some((g) => !g.closed)
        ? await pickGroup(uris.length > 1 ? t('tab.addManyToGroup', uris.length) : t('tab.addToGroup'), current?.id)
        : NEW_GROUP;
      if (id === REMOVE) {
        await commands['tabPalette.removeFromGroup'](undefined, uris.map((u) => vscode.Uri.parse(u)));
      } else if (id === NEW_GROUP) {
        await createGroup(uris, isSidebarArg(arg));
      } else if (id) {
        await addTo(id, uris);
      }
    },
    'tabPalette.addToNewGroup': async (arg, multi) => {
      const uris = resolveFiles(arg, multi);
      return uris.length === 0 ? noFiles() : createGroup(uris, isSidebarArg(arg));
    },
    'tabPalette.moveToGroup': (arg, multi) => commands['tabPalette.addToGroup'](arg, multi),
    'tabPalette.removeFromGroup': async (arg, multi) => {
      const uris = resolveFiles(arg, multi).filter((u) => store.groupOf(u));
      if (uris.length === 0) {
        void vscode.window.showInformationMessage(t('tab.notGrouped'));
        return;
      }
      const former = new Map(uris.map((u) => [u, store.groupOf(u)!.id]));
      store.removeUris(uris);
      // Chrome: a removed tab moves out to the right of its group instead of splitting it.
      for (const [u, groupId] of former) {
        await layout.moveOutOfGroup(u, groupId);
      }
      store.pruneEmpty();
    },
    'tabPalette.addSelectedToGroup': async (arg, context) => {
      const uris = await selectedTabs(arg, context);
      return commands['tabPalette.addToGroup'](isSidebarArg(arg) ? arg : undefined, uris.map((u) => vscode.Uri.parse(u)));
    },
    'tabPalette.addSelectedToNewGroup': async (arg, context) => {
      const uris = await selectedTabs(arg, context);
      return commands['tabPalette.addToNewGroup'](isSidebarArg(arg) ? arg : undefined, uris.map((u) => vscode.Uri.parse(u)));
    },
    'tabPalette.removeSelectedFromGroup': async (arg, context) => {
      const uris = await selectedTabs(arg, context);
      return commands['tabPalette.removeFromGroup'](undefined, uris.map((u) => vscode.Uri.parse(u)));
    },

    'tabPalette.editGroup': async (arg) => {
      const group = await resolveGroup(arg, t('pick.edit'));
      if (!group) {
        return;
      }
      if (isSidebarArg(arg) && !group.closed && deps.editInSidebar?.(group.id)) {
        return;
      }
      const bridge = deps.bridge();
      if (bridge && bridge.connections > 0 && !group.closed) {
        store.setCollapsed(group.id, false);
        bridge.requestEdit(group.id);
        return;
      }
      const name = await promptName(group.name, t('group.rename'));
      if (name !== undefined) {
        store.rename(group.id, name);
      }
      const color = await pickColor(group.color);
      if (color) {
        store.setColor(group.id, color);
      }
    },
    'tabPalette.renameGroup': async (arg) => {
      const group = await resolveGroup(arg, t('pick.rename'));
      const name = group && (await promptName(group.name, t('group.rename')));
      if (group && name !== undefined) {
        store.rename(group.id, name);
      }
    },
    'tabPalette.changeColor': async (arg) => {
      const group = await resolveGroup(arg, t('pick.recolor'));
      const color = group && (await pickColor(group.color));
      if (group && color) {
        store.setColor(group.id, color);
      }
    },
  };

  const groupCommand = (action: string, placeHolder: string) => async (arg: unknown) => {
    const group = await resolveGroup(arg, placeHolder);
    if (group) {
      await groupActions[action](group);
    }
  };
  commands['tabPalette.toggleCollapse'] = groupCommand('toggleCollapse', t('pick.toggleCollapse'));
  commands['tabPalette.newTabInGroup'] = groupCommand('newTab', t('pick.newTab'));
  commands['tabPalette.moveGroupToNewWindow'] = groupCommand('moveToNewWindow', t('pick.moveToNewWindow'));
  commands['tabPalette.closeGroup'] = groupCommand('close', t('pick.close'));
  commands['tabPalette.ungroup'] = groupCommand('ungroup', t('pick.ungroup'));
  commands['tabPalette.deleteGroup'] = groupCommand('delete', t('pick.delete'));
  /** Reopens a closed group; offers to drop the files that could not be opened. */
  async function reopenGroup(group: TabGroup): Promise<void> {
    const failed = await layout.reopen(group.id);
    if (failed.length > 0) {
      const names = failed.map((u) => path.basename(vscode.Uri.parse(u).path)).join(', ');
      if (await vscode.window.showWarningMessage(t('group.couldNotOpen', names), t('group.remove'))) {
        store.removeUris(failed);
        store.pruneEmpty();
      }
    }
  }
  commands['tabPalette.openGroup'] = async (arg) => {
    const group = await resolveGroup(arg, t('pick.reopen'));
    if (group) {
      await reopenGroup(group);
    }
  };

  // ---------- keyboard: go to a group of the active tab row ----------

  /** Opens the group `pick` chooses from the groups of the active tab row (in tab bar order). */
  const goTo = (pick: (groups: TabGroup[], current: number) => number | undefined) => async () => {
    const row = vscode.window.tabGroups.activeTabGroup;
    const groups = layout.groupsIn(row);
    const active = row.activeTab ? layout.groupIn(row, tabUri(row.activeTab).toString()) : undefined;
    const index = pick(groups, active ? groups.indexOf(active) : -1);
    const group = index === undefined ? undefined : groups[index];
    if (group) {
      await layout.showGroup(row, group.id);
    }
  };
  GO_TO_GROUP_COMMANDS.forEach((id, n) => {
    commands[id] = goTo((groups) => (n < groups.length ? n : undefined));
  });
  commands['tabPalette.nextGroup'] = goTo((groups, current) => stepGroup(groups.length, current, 1));
  commands['tabPalette.previousGroup'] = goTo((groups, current) => stepGroup(groups.length, current, -1));

  // ---------- "Show Tab Groups" menu: groups in this workspace, including closed ones ----------

  type MenuItem = vscode.QuickPickItem & { run?: () => unknown };
  async function showGroupMenu(): Promise<void> {
    const active = activeTabUri();
    const activeGroup = active ? store.groupOf(active.toString()) : undefined;
    const open = openUris();
    const items: MenuItem[] = [];
    if (active) {
      items.push({ label: t('menu.thisTab', path.basename(active.path)), kind: vscode.QuickPickItemKind.Separator });
      items.push(
        activeGroup
          ? { label: `$(close) ${t('menu.removeTab')}`, description: displayName(activeGroup), run: () => commands['tabPalette.removeFromGroup'](active) }
          : { label: `$(add) ${t('menu.addTab')}`, run: () => commands['tabPalette.addToGroup'](active) },
      );
    }
    const openGroups = store.all().filter((g) => !g.closed);
    const closedGroups = store.all().filter((g) => g.closed);
    if (openGroups.length > 0) {
      items.push({ label: t('menu.groups'), kind: vscode.QuickPickItemKind.Separator });
      for (const g of openGroups) {
        const count = g.uris.filter((u) => open.has(u)).length;
        items.push({
          label: displayName(g),
          description: g.collapsed ? t('menu.collapsedCount', tabCount(count)) : tabCount(count),
          iconPath: colorIcon(g.color),
          run: () => commands['tabPalette.editGroup'](g.id),
        });
      }
    }
    if (closedGroups.length > 0) {
      items.push({ label: t('menu.closedGroups'), kind: vscode.QuickPickItemKind.Separator });
      for (const g of closedGroups) {
        items.push({
          label: displayName(g),
          description: tabCount(g.uris.length),
          iconPath: colorIcon(g.color),
          run: () => commands['tabPalette.openGroup'](g.id),
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, { title: t('menu.title'), placeHolder: t('menu.placeholder') });
    await picked?.run?.();
  }
  commands['tabPalette.showMenu'] = showGroupMenu;

  // ---------- "Go to Tab in Group": every open tab, and the tabs of closed groups ----------

  type TabItem = vscode.QuickPickItem & { run: () => Promise<void> };
  /**
   * Lists the open tabs of each group (in tab bar order), then the open tabs in no group, then
   * the tabs of closed groups. Picking one shows it, expanding its group, or reopening it first.
   */
  async function goToTabInGroup(): Promise<void> {
    const items: TabItem[] = [];
    /** What the tab bar script needs to draw each row, by its accessible label ("label, description"). */
    const look: Record<string, GoToTabRow> = {};
    const add = (item: TabItem, row: GoToTabRow) => {
      items.push(item);
      look[item.description ? `${item.label}, ${item.description}` : item.label] = row;
    };
    const describe = (g: TabGroup, tag?: string) => ({
      description: tag ? `${displayName(g)} · ${tag}` : displayName(g),
      iconPath: colorIcon(g.color),
    });
    /** The open tabs of `group` (undefined: in no group), in tab bar order. */
    const openTabs = (group: TabGroup | undefined, make: (row: vscode.TabGroup, tab: vscode.Tab) => TabItem) =>
      vscode.window.tabGroups.all.forEach((row, r) =>
        row.tabs.forEach((tab, index) => {
          if (layout.groupIn(row, tabUri(tab).toString()) === group) {
            add(make(row, tab), { row: r, index, label: tab.label, color: group?.color });
          }
        }),
      );
    for (const g of store.all().filter((g) => !g.closed)) {
      openTabs(g, (row, tab) => ({
        label: tab.label,
        ...describe(g, g.collapsed ? t('goToTab.collapsed') : undefined),
        run: async () => {
          layout.expand(g.id);
          await layout.showTab(row, tab);
        },
      }));
    }
    openTabs(undefined, (row, tab) => ({ label: tab.label, run: () => layout.showTab(row, tab) }));
    for (const g of store.all().filter((g) => g.closed)) {
      // A closed group's tab opens the whole group again, then shows that tab.
      for (const uri of g.uris.filter((u) => !isOtherTab(u))) {
        const file = path.basename(vscode.Uri.parse(uri).path);
        const run = async () => {
          await reopenGroup(g);
          await showTabOf(uri);
        };
        add({ label: file, ...describe(g, t('goToTab.closed')), run }, { file, color: g.color });
      }
    }
    deps.bridge()?.goToTab(t('goToTab.title'), [t('goToTab.collapsed'), t('goToTab.closed')], look);
    const picked = await vscode.window.showQuickPick(items, {
      title: t('goToTab.title'),
      placeHolder: items.length > 0 ? t('goToTab.placeholder') : t('goToTab.none'),
      matchOnDescription: true,
    });
    await picked?.run();
  }
  commands['tabPalette.goToTab'] = goToTabInGroup;

  /** Shows the tab of `uri`, in the active row if it is open there. */
  async function showTabOf(uri: string): Promise<void> {
    const rows = [vscode.window.tabGroups.activeTabGroup, ...vscode.window.tabGroups.all];
    for (const row of rows) {
      const tab = row.tabs.find((tb) => tabUri(tb).toString() === uri);
      if (tab) {
        await layout.showTab(row, tab);
        return;
      }
    }
  }

  for (const [id, handler] of Object.entries(commands)) {
    ctx.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  /** Handles actions sent from the chip editor in the tab bar. */
  return async (action: UiAction) => {
    const group = store.get(action.groupId);
    const handler = groupActions[action.action];
    if (group && handler) {
      await handler(group, action.value);
    }
  };
}

/**
 * A command run from the side bar's context menu gets the right-clicked item's context:
 * `{ webviewSection, uri }` for a tab, `{ webviewSection, uris }` for selected tabs,
 * `{ webviewSection, groupId }` for a group.
 */
function isSidebarArg(arg: unknown): boolean {
  return !!arg && typeof arg === 'object' && typeof (arg as { webviewSection?: unknown }).webviewSection === 'string';
}

function sidebarArg(arg: unknown): { uri?: string; uris?: string[]; groupId?: string } {
  const a = arg as { webviewSection?: unknown; uri?: unknown; uris?: unknown; groupId?: unknown } | undefined;
  if (!a || typeof a !== 'object' || typeof a.webviewSection !== 'string') {
    return {};
  }
  return {
    uri: typeof a.uri === 'string' ? a.uri : undefined,
    uris: Array.isArray(a.uris) ? a.uris.filter((u): u is string => typeof u === 'string') : undefined,
    groupId: typeof a.groupId === 'string' ? a.groupId : undefined,
  };
}

/** Validates a drop report from the tab bar: { row, labels } (labels of the dragged tabs). */
function droppedTabs(value: unknown): { row: number; labels: string[] } | undefined {
  const v = value as { row?: unknown; labels?: unknown } | undefined;
  const labels = Array.isArray(v?.labels) ? v.labels.filter((l): l is string => typeof l === 'string') : [];
  return v && Number.isInteger(v.row) && labels.length > 0 ? { row: v.row as number, labels } : undefined;
}

/** Quick-pick over workspace files; falls back to an open dialog without a workspace. */
async function pickWorkspaceFile(title: string): Promise<vscode.Uri | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return (await vscode.window.showOpenDialog({ title, canSelectMany: false }))?.[0];
  }
  type FileItem = vscode.QuickPickItem & { uri: vscode.Uri };
  const files = vscode.workspace.findFiles('**/*', undefined, 5000).then((uris) =>
    uris
      .map<FileItem>((uri) => ({
        label: path.basename(uri.fsPath),
        description: vscode.workspace.asRelativePath(path.dirname(uri.fsPath)),
        uri,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
  return (await vscode.window.showQuickPick(files, { title, placeHolder: t('files.search'), matchOnDescription: true }))?.uri;
}
