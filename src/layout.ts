import * as vscode from 'vscode';
import { MembershipTracker, order } from './membership';
import { TabGroup } from './model';
import { GroupStore } from './store';
import { CloseGuard, isOtherTab, openFiles, tabUri } from './tabs';

/** Tab-row operations that make groups behave like Chrome's. */
export class Layout {
  constructor(
    private readonly store: GroupStore,
    private readonly tracker: MembershipTracker,
    private readonly guard: CloseGuard,
  ) {}

  /**
   * Chrome: tabs dropped onto one of a group's tabs join that group. The tab bar reports the
   * drop (group, tab row, labels of the dragged tabs: one tab, or all selected tabs); VS Code
   * moves the tabs on its own, and that move can reach us slightly before or after this
   * report. So wait (briefly) until each tab sits next to the group, then add it at that spot.
   * Returns how many tabs joined.
   */
  async joinDroppedTabs(groupId: string, rowIndex: number, labels: string[], timeoutMs = 1500): Promise<number> {
    const start = Date.now();
    const remaining = [...labels];
    let joined = 0;
    for (;;) {
      const row = vscode.window.tabGroups.all[rowIndex];
      if (!row || !this.store.get(groupId)) {
        return joined;
      }
      const tabs = row.tabs.map((t) => ({ label: t.label, uri: tabUri(t).toString() }));
      const member = (u: string) => this.store.groupOf(u)?.id === groupId;
      // Each joined tab can make the next one adjacent (several dropped side by side).
      for (let progress = true; progress && remaining.length > 0; ) {
        progress = false;
        for (const [i, label] of remaining.entries()) {
          const found = droppedNextToGroup(tabs, label, member);
          if (found) {
            this.store.addUris(groupId, [found.uri], found.before);
            remaining.splice(i, 1);
            joined++;
            progress = true;
            break;
          }
        }
      }
      if (remaining.length === 0 || Date.now() - start > timeoutMs) {
        this.store.pruneEmpty();
        return joined;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Chrome: grouped tabs dropped outside their group (on an ungrouped tab, a chip, or the
   * empty end of the tab bar) leave the group, even if the tab order did not change, e.g. the
   * group's last tab dragged a little to the right. The tab bar only reports drops outside the
   * group, so they leave at once, without waiting for VS Code's own move (that move can come
   * before or after this report). Returns how many tabs left.
   */
  async leaveDroppedTabs(groupId: string, rowIndex: number, labels: string[]): Promise<number> {
    const row = vscode.window.tabGroups.all[rowIndex];
    if (!row || !this.store.get(groupId)) {
      return 0;
    }
    const tabs = row.tabs.map((t) => ({ label: t.label, uri: tabUri(t).toString() }));
    const leaving = droppedOutOfGroup(tabs, labels, (u) => this.store.groupOf(u)?.id === groupId);
    if (leaving.length > 0) {
      this.store.removeUris(leaving);
      this.store.pruneEmpty();
    }
    return leaving.length;
  }

  /**
   * Opens the files that have no tab yet (e.g. several files picked in the Explorer), so all
   * of them can join the group. Folders are skipped. Returns the files that have a tab now.
   */
  async openMissing(uris: string[]): Promise<string[]> {
    const open = new Set(vscode.window.tabGroups.all.flatMap((row) => order(row)));
    const missing: string[] = [];
    for (const u of uris) {
      if (open.has(u)) {
        continue;
      }
      const stat = await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.parse(u))).catch(() => undefined);
      if (stat && !(stat.type & vscode.FileType.Directory)) {
        missing.push(u);
      }
    }
    if (missing.length > 0) {
      // In the active row, keeping the focus where it is. Not a user's move: no joining.
      await this.tracker.suspend(async () => {
        for (const u of missing) {
          await Promise.resolve(
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(u), { preview: false, preserveFocus: true }),
          ).catch(() => undefined);
        }
      });
    }
    const nowOpen = new Set(vscode.window.tabGroups.all.flatMap((row) => order(row)));
    return uris.filter((u) => nowOpen.has(u));
  }

  /** The group of the tab with this URI in this tab row (a group lives in one row). */
  groupIn(row: vscode.TabGroup, uri: string): TabGroup | undefined {
    return this.tracker.groupIn(row, uri);
  }

  /**
   * Chrome: pinned tabs are never in a group, so a pinned tab added to a group is unpinned
   * first. Call before adding `uris` to a group (a pinned group tab would leave it again).
   */
  async unpin(uris: string[]): Promise<void> {
    const wanted = new Set(uris);
    const pinned = vscode.window.tabGroups.all.flatMap((row) =>
      row.tabs.filter((t) => t.isPinned && wanted.has(tabUri(t).toString())).map((tab) => ({ row, tab })),
    );
    if (pinned.length === 0) {
      return;
    }
    const before = activeLocation();
    await this.tracker.suspend(async () => {
      for (const { row, tab } of pinned) {
        await this.showTab(row, tab);
        await vscode.commands.executeCommand('workbench.action.unpinEditor');
      }
      await this.restore(before);
    });
  }

  /**
   * Chrome keeps a group's tabs together: move each of `uris` (tabs just added to their
   * group) next to the group's other tabs. Added to an existing group, a tab goes after
   * the group's last tab. When every tab of the group is new (a new group made from
   * several tabs), the group forms where its leftmost tab is. A group lives in one tab row:
   * a tab added from another row moves there first.
   */
  async placeInGroup(uris: string[]): Promise<void> {
    let before = activeLocation();
    const added = new Set(uris);
    const position = (u: string) => {
      const row = vscode.window.tabGroups.all.find((r) => order(r).includes(u));
      return row ? order(row).indexOf(u) : Number.MAX_SAFE_INTEGER;
    };
    // Per group: tabs already in place. That is the group's existing tabs, plus each added
    // tab once it sits next to one of them. Two added tabs next to each other, away from
    // the group, are not "in place" (they would form a split-off piece of the group).
    const placed = new Map<string, Set<string>>();
    let movedAny = false;
    await this.tracker.suspend(async () => {
      movedAny = await this.bringHome(uris);
      if (movedAny && before && !vscode.window.tabGroups.all.some((r) => r.viewColumn === before!.viewColumn && order(r).includes(before!.key))) {
        before = activeLocation(); // the active tab moved to its group's row: it stays active there
      }
      for (const uri of [...uris].sort((x, y) => position(x) - position(y))) {
        const group = this.store.groupOf(uri);
        if (!group) {
          continue;
        }
        let inPlace = placed.get(group.id);
        if (!inPlace) {
          inPlace = new Set(group.uris.filter((u) => !added.has(u)));
          placed.set(group.id, inPlace);
        }
        const isPlaced = (u: string) => inPlace.has(u);
        const home = this.tracker.homeOf(group.id);
        for (const row of home ? [home] : []) {
          const current = order(row);
          const index = current.indexOf(uri);
          if (index < 0) {
            continue;
          }
          const rest = current.filter((_, i) => i !== index);
          if (!rest.some(isPlaced)) {
            inPlace.add(uri); // the group's first tab in this row: the others come to it
            continue;
          }
          if ((index > 0 && isPlaced(current[index - 1])) || (index < current.length - 1 && isPlaced(current[index + 1]))) {
            inPlace.add(uri); // already next to its group
            continue;
          }
          let last = -1;
          rest.forEach((u, i) => {
            if (isPlaced(u)) {
              last = i;
            }
          });
          inPlace.add(uri);
          await this.showTab(row, row.tabs[index]);
          await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: last + 2 });
          movedAny = true;
        }
      }
      if (movedAny) {
        await this.restore(before);
      }
    });
  }

  /**
   * Moves the tab `key` from another tab row into row `target` (any tab, not only files).
   * VS Code reports the move a moment later; returns whether the tab is there now.
   */
  private async moveToRow(key: string, target: vscode.TabGroup): Promise<boolean> {
    const from = vscode.window.tabGroups.all.find((r) => r !== target && order(r).includes(key));
    if (!from) {
      return false;
    }
    if (isOtherTab(key)) {
      // A tab that shows no file cannot be opened elsewhere: move it. (`moveActiveEditor`
      // counts only the main window's rows, by position, which is their view column.)
      await this.showTab(from, from.tabs[order(from).indexOf(key)]);
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: target.viewColumn });
      return !!(await settled(() => order(target).includes(key)));
    }
    // A file opens in the target row (in any window), then its old tab closes.
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(key), { viewColumn: target.viewColumn, preview: false });
    if (!(await settled(() => order(target).includes(key)))) {
      return false; // it did not open there: keep the tab where it is
    }
    const others = vscode.window.tabGroups.all.flatMap((r) => (r === target ? [] : r.tabs)).filter((t) => tabUri(t).toString() === key);
    if (others.length > 0) {
      await vscode.window.tabGroups.close(others, true);
    }
    return true;
  }

  /**
   * Moves tabs of `uris` that are open in another tab row than their group's home row into
   * that row. Returns whether any moved.
   */
  private async bringHome(uris: string[]): Promise<boolean> {
    let moved = false;
    for (const uri of uris) {
      const group = this.store.groupOf(uri);
      const home = group && this.tracker.homeOf(group.id);
      if (home && !order(home).includes(uri) && (await this.moveToRow(uri, home))) {
        moved = true;
      }
    }
    return moved;
  }

  /**
   * Chrome: dragging a group chip moves the whole group. Moves the group's tabs in
   * tab row `rowIndex` so they sit together right before the tab currently at
   * `beforeIndex` (or at the end when it is past the last tab).
   */
  async moveGroupTo(groupId: string, rowIndex: number, beforeIndex: number): Promise<void> {
    const row = vscode.window.tabGroups.all[rowIndex];
    if (!row) {
      return;
    }
    const member = (u: string) => this.store.groupOf(u)?.id === groupId;
    const keys = order(row);
    const target = groupInsertIndex(keys, member, beforeIndex);
    if (target === undefined) {
      return;
    }
    await this.moveTabsTogether(rowIndex, keys.filter(member), target);
  }

  /**
   * Chrome: a tab removed from the middle of its group moves to just after the group,
   * so the group stays in one piece. Call after the store no longer lists `uri` in the group.
   */
  async moveOutOfGroup(uri: string, formerGroupId: string): Promise<void> {
    const member = (u: string) => this.store.groupOf(u)?.id === formerGroupId;
    const before = activeLocation();
    let moved = false;
    await this.tracker.suspend(async () => {
      for (const row of vscode.window.tabGroups.all) {
        const position = positionAfterGroup(order(row), uri, member);
        if (position === undefined) {
          continue;
        }
        await this.showTab(row, row.tabs[order(row).indexOf(uri)]);
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
        moved = true;
      }
      if (moved) {
        await this.restore(before);
      }
    });
  }

  /**
   * Makes `tab` the active tab of its row, without pinning a preview tab. File tabs open
   * through `vscode.open`; other tabs (settings, diffs…) are opened by their position.
   */
  async showTab(row: vscode.TabGroup, tab: vscode.Tab, preserveFocus = false): Promise<void> {
    const input = tab.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
      await vscode.commands.executeCommand('vscode.open', input.uri, { viewColumn: row.viewColumn, preview: tab.isPreview, preserveFocus });
      return;
    }
    // Focus the row through a file tab of it, then pick the tab by position.
    const anchor = row.tabs.find((t) => t.input instanceof vscode.TabInputText);
    if (anchor) {
      await vscode.commands.executeCommand('vscode.open', (anchor.input as vscode.TabInputText).uri, {
        viewColumn: row.viewColumn,
        preview: anchor.isPreview,
      });
    } else {
      const index = vscode.window.tabGroups.all.indexOf(row);
      const focus = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][index];
      if (focus) {
        await vscode.commands.executeCommand(`workbench.action.focus${focus}EditorGroup`);
      }
    }
    await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', row.tabs.indexOf(tab));
  }

  /** Makes the tab that was active (see activeLocation) active again, if it is still open there. */
  private async restore(before: Location | undefined): Promise<void> {
    const row = before && vscode.window.tabGroups.all.find((r) => r.viewColumn === before.viewColumn);
    const index = row ? order(row).indexOf(before!.key) : -1;
    if (row && index >= 0) {
      await this.showTab(row, row.tabs[index]);
    }
  }

  /** Moves the tab at `from` in tab row `rowIndex` to index `to`, keeping the active tab. */
  async moveTab(rowIndex: number, from: number, to: number): Promise<void> {
    const row = vscode.window.tabGroups.all[rowIndex];
    const tab = row?.tabs[from];
    if (!row || !tab || from === to) {
      return;
    }
    const before = activeLocation();
    const wasActive = row.activeTab === tab && row === vscode.window.tabGroups.activeTabGroup;
    await this.tracker.suspend(async () => {
      await this.showTab(row, tab);
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: to + 1 });
      if (!wasActive) {
        await this.restore(before);
      }
    });
  }

  /**
   * Moves the tabs `keys` (in this order) of tab row `rowIndex` so they sit together after
   * `othersBefore` of the other tabs. Works for any tab, not only files.
   */
  async moveTabsTogether(rowIndex: number, keys: readonly string[], othersBefore: number): Promise<void> {
    const start = vscode.window.tabGroups.all[rowIndex];
    if (!start || keys.length === 0) {
      return;
    }
    const viewColumn = start.viewColumn;
    const rowOf = () => vscode.window.tabGroups.all.find((g) => g.viewColumn === viewColumn);
    const before = activeLocation();
    const show = async (key: string) => {
      const row = rowOf();
      const index = row ? order(row).indexOf(key) : -1;
      if (row && index >= 0) {
        await this.showTab(row, row.tabs[index]);
        return true;
      }
      return false;
    };
    const moveTo = (position: number) => vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
    await this.tracker.suspend(async () => {
      // Send them to the end, in order; then bring them back to their spot, one by one.
      for (const key of keys) {
        if (await show(key)) {
          await moveTo(order(rowOf()!).length - 1);
        }
      }
      const total = rowOf() ? order(rowOf()!).length : 0;
      if (othersBefore < total - keys.length) {
        for (const [j, key] of keys.entries()) {
          if (await show(key)) {
            await moveTo(othersBefore + j);
          }
        }
      }
      await this.restore(before);
    });
  }

  /**
   * Chrome collapse: hide the group's tabs. If one is active, switch to the nearest tab that stays
   * visible (not in this or another collapsed group); if there is none, open a new empty file
   * outside any group, as Chrome opens a new tab.
   */
  async collapse(groupId: string): Promise<void> {
    const hidden = (u: string) => {
      const g = this.store.groupOf(u);
      return !!g && (g.id === groupId || g.collapsed);
    };
    const created: string[] = [];
    await this.tracker.suspend(async () => {
      for (const row of vscode.window.tabGroups.all) {
        const active = row.activeTab ? tabUri(row.activeTab).toString() : undefined;
        if (!active || !hidden(active)) {
          continue;
        }
        const tabs = order(row);
        const at = tabs.indexOf(active);
        // The tabs to the right first, then those to the left, nearest first.
        const indexes = [...tabs.keys()];
        const near = [...indexes.slice(at + 1), ...indexes.slice(0, at).reverse()];
        const pick = near.find((i) => !hidden(tabs[i]));
        const preserveFocus = row !== vscode.window.tabGroups.activeTabGroup;
        if (pick !== undefined) {
          await this.showTab(row, row.tabs[pick], preserveFocus);
        } else {
          const doc = await vscode.workspace.openTextDocument({ content: '' });
          await vscode.window.showTextDocument(doc, { viewColumn: row.viewColumn, preview: false, preserveFocus });
          created.push(doc.uri.toString());
          // At the end of the row, like Chrome's new tab, so it never splits a group.
          const rowIndex = vscode.window.tabGroups.all.findIndex((r) => r.viewColumn === row.viewColumn);
          const now = vscode.window.tabGroups.all[rowIndex];
          const from = now ? order(now).indexOf(doc.uri.toString()) : -1;
          if (from >= 0) {
            await this.moveTab(rowIndex, from, now.tabs.length - 1);
          }
        }
      }
    });
    // The new file may have opened between two tabs of the group: it is never in a group.
    this.store.removeUris(created);
    this.store.setCollapsed(groupId, true);
  }

  expand(groupId: string): void {
    this.store.setCollapsed(groupId, false);
  }

  /** Chrome "Close group": close the tabs, keep the group to reopen later. */
  async close(groupId: string): Promise<void> {
    const group = this.store.get(groupId);
    if (group && (await this.guard.closeTabsFor(group.uris))) {
      this.store.setClosed(groupId, true);
    }
  }

  /** Reopens a closed group's tabs, together, at the end of the active row. */
  async reopen(groupId: string): Promise<string[]> {
    const group = this.store.get(groupId);
    if (!group) {
      return [];
    }
    // A tab that shows no file (a webview, a terminal) cannot be opened again: it leaves the group.
    this.store.removeUris(group.uris.filter((u) => isOtherTab(u)));
    this.store.setClosed(groupId, false);
    this.store.setCollapsed(groupId, false);
    const uris = this.store.get(groupId)?.uris ?? [];
    this.store.pruneEmpty();
    return this.tracker.suspend(() => openFiles(uris));
  }

  /** Chrome "Move group to new window": move every open tab of the group into one new window. */
  async moveToNewWindow(groupId: string): Promise<void> {
    const group = this.store.get(groupId);
    if (!group) {
      return;
    }
    const tabs = vscode.window.tabGroups.all.flatMap((row) =>
      row.tabs.filter((t) => group.uris.includes(tabUri(t).toString())).map((t) => ({ row, tab: t })),
    );
    if (tabs.length === 0) {
      return;
    }
    const uris = tabs.map(({ tab }) => tabUri(tab).toString());
    const rowsBefore = new Set(vscode.window.tabGroups.all);
    await this.tracker.suspend(async () => {
      const first = tabs[0];
      await this.showTab(first.row, first.tab);
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      // VS Code reports the new window's tab row a moment later: wait for it, or the other
      // tabs would be opened (and then closed) in the row they are already in.
      const target = await settled(() => vscode.window.tabGroups.all.find((r) => !rowsBefore.has(r) && order(r).includes(uris[0])));
      if (!target) {
        return;
      }
      // Only files can follow into another window (opened there); a tab that shows no file can
      // only be moved by position among the main window's rows, so it stays.
      for (const uri of uris.slice(1).filter((u) => !isOtherTab(u))) {
        await this.moveToRow(uri, target);
      }
    });
    this.store.setCollapsed(groupId, false);
  }
}

/**
 * For dropping a group before the tab at `beforeIndex`: how many non-member tabs
 * end up before the group. Undefined when nothing changes (dropped inside itself,
 * or already there). The tab bar UI never offers a drop inside another group.
 */
export function groupInsertIndex(row: readonly string[], member: (u: string) => boolean, beforeIndex: number): number | undefined {
  const others = row.filter((u) => !member(u));
  let k: number;
  if (beforeIndex >= row.length) {
    k = others.length;
  } else {
    const anchor = row[Math.max(0, beforeIndex)];
    if (member(anchor)) {
      return undefined;
    }
    k = others.indexOf(anchor);
  }
  const current = row.findIndex(member);
  const currentK = current < 0 ? -1 : row.slice(0, current).filter((u) => !member(u)).length;
  return k === currentK ? undefined : k;
}

/**
 * Where `uri` must go so it no longer splits the group (`member`): right after the
 * group's last tab. Undefined when it isn't between two of the group's tabs.
 */
export function positionAfterGroup(row: readonly string[], uri: string, member: (u: string) => boolean): number | undefined {
  const index = row.indexOf(uri);
  if (index < 0) {
    return undefined;
  }
  const leftIn = row.slice(0, index).some(member);
  const rightIn = row.slice(index + 1).some(member);
  if (!leftIn || !rightIn) {
    return undefined;
  }
  const rest = row.filter((_, i) => i !== index);
  let last = -1;
  rest.forEach((u, i) => {
    if (member(u)) {
      last = i;
    }
  });
  return last + 1;
}

/**
 * The tab named `label` that sits right next to the group (`member`) but is not in it yet:
 * the tab just dropped onto the group. `before` is the group tab right after it, if any
 * (so it is added at that spot, not at the end). Undefined while no such tab exists.
 */
export function droppedNextToGroup(
  row: readonly { label: string; uri: string }[],
  label: string,
  member: (uri: string) => boolean,
): { uri: string; before?: string } | undefined {
  for (const [i, tab] of row.entries()) {
    if (tab.label !== label || !tab.uri || member(tab.uri)) {
      continue;
    }
    const prev = i > 0 && member(row[i - 1].uri);
    const next = i < row.length - 1 && member(row[i + 1].uri);
    if (prev || next) {
      return { uri: tab.uri, before: next ? row[i + 1].uri : undefined };
    }
  }
  return undefined;
}

/**
 * Of the dragged tabs (`labels`: one tab, or all selected tabs), the grouped ones that were
 * dropped outside their group and should leave it. None when the drag held all of the
 * group's tabs (they carry the group along). Where the tabs are does not matter: the report
 * may come before VS Code moves them. (A tab that VS Code then puts between two of the
 * group's tabs joins again, as any tab moved there does.)
 */
export function droppedOutOfGroup(
  row: readonly { label: string; uri: string }[],
  labels: readonly string[],
  member: (uri: string) => boolean,
): string[] {
  const dragged = new Set<number>();
  for (const label of labels) {
    const index = row.findIndex((t, i) => !dragged.has(i) && t.label === label && !!t.uri && member(t.uri));
    if (index >= 0) {
      dragged.add(index);
    }
  }
  const stays = (i: number) => member(row[i].uri) && !dragged.has(i);
  if (dragged.size === 0 || !row.some((_, i) => stays(i))) {
    return [];
  }
  return [...dragged].map((i) => row[i].uri);
}

/** Waits (up to 1 s) until `check` gives a value: VS Code reports tab changes a moment after a command. */
async function settled<T>(check: () => T | undefined | false): Promise<T | undefined> {
  for (let i = 0; i < 50; i++) {
    const value = check();
    if (value) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

interface Location {
  key: string;
  viewColumn: vscode.ViewColumn;
}

/** The active tab: its key and its row. */
function activeLocation(): Location | undefined {
  const row = vscode.window.tabGroups.activeTabGroup;
  return row.activeTab ? { key: tabUri(row.activeTab).toString(), viewColumn: row.viewColumn } : undefined;
}
