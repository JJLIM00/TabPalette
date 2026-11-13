import * as path from 'path';
import * as vscode from 'vscode';
import { Bridge, UiAction } from './bridge';
import { colorIconFactory } from './colorIcons';
import { Layout } from './layout';
import { GROUP_COLORS, GroupColor, TabGroup, colorLabel, displayName, isGroupColor } from './model';
import { GroupStore } from './store';
import { CloseGuard, activeTabUri, menuTabUri, openFiles, openUris, selectedTabUris } from './tabs';

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
}

export function registerCommands(ctx: vscode.ExtensionContext, deps: CommandDeps): (action: UiAction) => Promise<void> {
  const { store, guard, layout } = deps;
  /** A dot in the group color for the pickers; follows the user's workbench.colorCustomizations. */
  const colorIcon = colorIconFactory(ctx);

  // ---------- prompts (fallbacks when the in-tab-bar editor is not available) ----------

  const promptName = (value = '', title = 'Group name') =>
    vscode.window.showInputBox({ title, value, placeHolder: 'Name this group (optional)' });

  async function pickColor(current?: GroupColor): Promise<GroupColor | undefined> {
    type ColorItem = vscode.QuickPickItem & { color: GroupColor };
    const picked = await vscode.window.showQuickPick<ColorItem>(
      GROUP_COLORS.map((color) => ({
        label: colorLabel(color),
        description: color === current ? 'current' : undefined,
        iconPath: colorIcon(color),
        color,
      })),
      { title: 'Group color' },
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
    const items: GroupItem[] = [{ label: '$(add) New group', id: NEW_GROUP }];
    if (exclude) {
      items.push({ label: '$(close) Remove from group', id: REMOVE });
    }
    const groups = store.all().filter((g) => g.id !== exclude && !g.closed);
    if (groups.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, id: '' });
      for (const g of groups) {
        items.push({
          label: displayName(g),
          description: `${g.uris.length} tab${g.uris.length === 1 ? '' : 's'}`,
          iconPath: colorIcon(g.color),
          id: g.id,
        });
      }
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

  async function resolveGroup(arg: unknown, action: string): Promise<TabGroup | undefined> {
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
      void vscode.window.showInformationMessage('There are no tab groups yet.');
      return undefined;
    }
    type GroupItem = vscode.QuickPickItem & { id: string };
    const picked = await vscode.window.showQuickPick<GroupItem>(
      store.all().map((g) => ({ label: displayName(g), iconPath: colorIcon(g.color), id: g.id, description: g.closed ? 'closed' : undefined })),
      { placeHolder: `Select a group to ${action}` },
    );
    return picked ? store.get(picked.id) : undefined;
  }

  const noFiles = () => void vscode.window.showInformationMessage('Open a file to add it to a tab group.');

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
      const uri = await pickWorkspaceFile(`New tab in "${displayName(g)}"`);
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
        ? await pickGroup(uris.length > 1 ? `Add ${uris.length} tabs to group` : 'Add tab to group', current?.id)
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
        void vscode.window.showInformationMessage('This tab is not in a tab group.');
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
      const group = await resolveGroup(arg, 'edit');
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
      const name = await promptName(group.name, 'Rename group');
      if (name !== undefined) {
        store.rename(group.id, name);
      }
      const color = await pickColor(group.color);
      if (color) {
        store.setColor(group.id, color);
      }
    },
    'tabPalette.renameGroup': async (arg) => {
      const group = await resolveGroup(arg, 'rename');
      const name = group && (await promptName(group.name, 'Rename group'));
      if (group && name !== undefined) {
        store.rename(group.id, name);
      }
    },
    'tabPalette.changeColor': async (arg) => {
      const group = await resolveGroup(arg, 'recolor');
      const color = group && (await pickColor(group.color));
      if (group && color) {
        store.setColor(group.id, color);
      }
    },
  };

  const groupCommand = (action: string, verb: string) => async (arg: unknown) => {
    const group = await resolveGroup(arg, verb);
    if (group) {
      await groupActions[action](group);
    }
  };
  commands['tabPalette.toggleCollapse'] = groupCommand('toggleCollapse', 'collapse or expand');
  commands['tabPalette.newTabInGroup'] = groupCommand('newTab', 'add a tab to');
  commands['tabPalette.moveGroupToNewWindow'] = groupCommand('moveToNewWindow', 'move');
  commands['tabPalette.closeGroup'] = groupCommand('close', 'close');
  commands['tabPalette.ungroup'] = groupCommand('ungroup', 'ungroup');
  commands['tabPalette.deleteGroup'] = groupCommand('delete', 'delete');
  commands['tabPalette.openGroup'] = async (arg) => {
    const group = await resolveGroup(arg, 'reopen');
    if (!group) {
      return;
    }
    const failed = await layout.reopen(group.id);
    if (failed.length > 0) {
      const names = failed.map((u) => path.basename(vscode.Uri.parse(u).path)).join(', ');
      if (await vscode.window.showWarningMessage(`Could not open: ${names}`, 'Remove from group')) {
        store.removeUris(failed);
        store.pruneEmpty();
      }
    }
  };

  // ---------- "Show Tab Groups" menu: groups in this workspace, including closed ones ----------

  type MenuItem = vscode.QuickPickItem & { run?: () => unknown };
  async function showGroupMenu(): Promise<void> {
    const active = activeTabUri();
    const activeGroup = active ? store.groupOf(active.toString()) : undefined;
    const open = openUris();
    const items: MenuItem[] = [];
    if (active) {
      items.push({ label: `This tab: ${path.basename(active.path)}`, kind: vscode.QuickPickItemKind.Separator });
      items.push(
        activeGroup
          ? { label: '$(close) Remove tab from group', description: displayName(activeGroup), run: () => commands['tabPalette.removeFromGroup'](active) }
          : { label: '$(add) Add tab to group…', run: () => commands['tabPalette.addToGroup'](active) },
      );
    }
    const openGroups = store.all().filter((g) => !g.closed);
    const closedGroups = store.all().filter((g) => g.closed);
    if (openGroups.length > 0) {
      items.push({ label: 'Groups', kind: vscode.QuickPickItemKind.Separator });
      for (const g of openGroups) {
        const count = g.uris.filter((u) => open.has(u)).length;
        items.push({
          label: displayName(g),
          description: `${count} tab${count === 1 ? '' : 's'}${g.collapsed ? ' · collapsed' : ''}`,
          iconPath: colorIcon(g.color),
          run: () => commands['tabPalette.editGroup'](g.id),
        });
      }
    }
    if (closedGroups.length > 0) {
      items.push({ label: 'Closed groups (pick to reopen)', kind: vscode.QuickPickItemKind.Separator });
      for (const g of closedGroups) {
        items.push({
          label: displayName(g),
          description: `${g.uris.length} tab${g.uris.length === 1 ? '' : 's'}`,
          iconPath: colorIcon(g.color),
          run: () => commands['tabPalette.openGroup'](g.id),
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'TabPalette - Tab Groups', placeHolder: 'Pick a group' });
    await picked?.run?.();
  }
  commands['tabPalette.showMenu'] = showGroupMenu;

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
  return (await vscode.window.showQuickPick(files, { title, placeHolder: 'Search files by name', matchOnDescription: true }))?.uri;
}
