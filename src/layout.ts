import * as vscode from 'vscode';
import { MembershipTracker, order } from './membership';
import { GroupStore } from './store';
import { CloseGuard, openFiles, tabUri } from './tabs';

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
      const tabs = row.tabs.map((t) => ({ label: t.label, uri: tabUri(t)?.toString() ?? '' }));
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
   * group's last tab dragged a little to the right. Waits briefly for VS Code's own move
   * first, so the tabs are judged where they landed. Returns how many tabs left.
   */
  async leaveDroppedTabs(groupId: string, rowIndex: number, labels: string[], settleMs = 300): Promise<number> {
    await new Promise((r) => setTimeout(r, settleMs));
    const row = vscode.window.tabGroups.all[rowIndex];
    if (!row || !this.store.get(groupId)) {
      return 0;
    }
    const tabs = row.tabs.map((t) => ({ label: t.label, uri: tabUri(t)?.toString() ?? '' }));
    const leaving = droppedOutOfGroup(tabs, labels, (u) => this.store.groupOf(u)?.id === groupId);
    if (leaving.length > 0) {
      this.store.removeUris(leaving);
      this.store.pruneEmpty();
    }
    return leaving.length;
  }

  /**
   * Chrome: pinned tabs are never in a group, so a pinned tab added to a group is unpinned
   * first. Call before adding `uris` to a group (a pinned group tab would leave it again).
   */
  async unpin(uris: string[]): Promise<void> {
    const wanted = new Set(uris);
    const pinned = vscode.window.tabGroups.all.flatMap((row) =>
      row.tabs.filter((t) => t.isPinned && wanted.has(tabUri(t)?.toString() ?? '')).map((tab) => ({ row, tab })),
    );
    if (pinned.length === 0) {
      return;
    }
    const before = activeLocation();
    await this.tracker.suspend(async () => {
      for (const { row, tab } of pinned) {
        await vscode.commands.executeCommand('vscode.open', tabUri(tab), { viewColumn: row.viewColumn, preview: false });
        await vscode.commands.executeCommand('workbench.action.unpinEditor');
      }
      if (before) {
        await vscode.commands.executeCommand('vscode.open', before.uri, { viewColumn: before.viewColumn, preview: false });
      }
    });
  }

  /**
   * Chrome keeps a group's tabs together: move each of `uris` (tabs just added to their
   * group) next to the group's other tabs. Added to an existing group, a tab goes after
   * the group's last tab. When every tab of the group is new (a new group made from
   * several tabs), the group forms where its leftmost tab is.
   */
  async placeInGroup(uris: string[]): Promise<void> {
    const before = activeLocation();
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
        for (const row of vscode.window.tabGroups.all) {
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
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri), {
            viewColumn: row.viewColumn,
            preview: false,
          });
          await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: last + 2 });
          movedAny = true;
        }
      }
      if (movedAny && before) {
        await vscode.commands.executeCommand('vscode.open', before.uri, { viewColumn: before.viewColumn, preview: false });
      }
    });
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
    const target = groupInsertIndex(order(row), member, beforeIndex);
    if (target === undefined) {
      return;
    }
    await this.reorder(row.viewColumn, member, target);
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
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri), { viewColumn: row.viewColumn, preview: false });
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
        moved = true;
      }
      if (moved && before) {
        await vscode.commands.executeCommand('vscode.open', before.uri, { viewColumn: before.viewColumn, preview: false });
      }
    });
  }

  /** Moves the member tabs of a row, in order, so the first one ends up at `target` among the other tabs. */
  private async reorder(viewColumn: vscode.ViewColumn, member: (u: string) => boolean, othersBefore: number): Promise<void> {
    const before = activeLocation();
    const rowOf = () => vscode.window.tabGroups.all.find((g) => g.viewColumn === viewColumn);
    await this.tracker.suspend(async () => {
      const start = rowOf();
      if (!start) {
        return;
      }
      const members = order(start).filter(member);
      const open = (u: string) =>
        vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(u), { viewColumn, preview: false });
      const moveTo = (position: number) =>
        vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
      // 1) Send the members to the end, keeping their order.
      for (const u of members) {
        await open(u);
        await moveTo(order(rowOf()!).length - 1);
      }
      // 2) Bring them back in front of the target tab, one by one.
      const total = order(rowOf()!).length;
      if (othersBefore < total - members.length) {
        for (const [j, u] of members.entries()) {
          await open(u);
          await moveTo(othersBefore + j);
        }
      }
      if (before) {
        await vscode.commands.executeCommand('vscode.open', before.uri, { viewColumn: before.viewColumn, preview: false });
      }
    });
  }

  /** Chrome collapse: hide the group's tabs; if one is active, switch to a tab outside the group. */
  async collapse(groupId: string): Promise<void> {
    const member = (u: string) => this.store.groupOf(u)?.id === groupId;
    await this.tracker.suspend(async () => {
      for (const row of vscode.window.tabGroups.all) {
        const active = row.activeTab ? tabUri(row.activeTab)?.toString() : undefined;
        if (!active || !member(active)) {
          continue;
        }
        const tabs = order(row);
        const at = tabs.indexOf(active);
        const pick =
          tabs.slice(at + 1).find((u) => !member(u) && !u.startsWith('#')) ??
          [...tabs.slice(0, at)].reverse().find((u) => !member(u) && !u.startsWith('#'));
        if (pick) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(pick), {
            viewColumn: row.viewColumn,
            preview: false,
            preserveFocus: row !== vscode.window.tabGroups.activeTabGroup,
          });
        }
      }
    });
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
    this.store.setClosed(groupId, false);
    this.store.setCollapsed(groupId, false);
    return this.tracker.suspend(() => openFiles(group.uris));
  }

  /** Chrome "Move group to new window": move every open tab of the group into one new window. */
  async moveToNewWindow(groupId: string): Promise<void> {
    const group = this.store.get(groupId);
    if (!group) {
      return;
    }
    const tabs = vscode.window.tabGroups.all.flatMap((row) =>
      row.tabs.filter((t) => group.uris.includes(tabUri(t)?.toString() ?? '')).map((t) => ({ row, tab: t })),
    );
    if (tabs.length === 0) {
      return;
    }
    await this.tracker.suspend(async () => {
      const [first, ...rest] = tabs;
      await vscode.commands.executeCommand('vscode.open', tabUri(first.tab), { viewColumn: first.row.viewColumn, preview: false });
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      const target = vscode.window.tabGroups.activeTabGroup.viewColumn;
      for (const { tab } of rest) {
        await vscode.commands.executeCommand('vscode.open', tabUri(tab), { viewColumn: target, preview: false });
        await vscode.window.tabGroups.close(tab, true);
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
 * group's tabs (they carry the group along). A dragged tab stays when it landed between two
 * group tabs that were not dragged (it is inside the group).
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
  // Nearest tab on each side that was not dragged along.
  const neighbor = (i: number, step: number) => {
    for (let j = i + step; j >= 0 && j < row.length; j += step) {
      if (!dragged.has(j)) {
        return j;
      }
    }
    return -1;
  };
  return [...dragged]
    .filter((i) => {
      const left = neighbor(i, -1);
      const right = neighbor(i, 1);
      return !(left >= 0 && right >= 0 && stays(left) && stays(right));
    })
    .map((i) => row[i].uri);
}

function activeLocation(): { uri: vscode.Uri; viewColumn: vscode.ViewColumn } | undefined {
  const row = vscode.window.tabGroups.activeTabGroup;
  const uri = row.activeTab ? tabUri(row.activeTab) : undefined;
  return uri ? { uri, viewColumn: row.viewColumn } : undefined;
}
