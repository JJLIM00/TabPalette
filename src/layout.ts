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
    let movedAny = false;
    await this.tracker.suspend(async () => {
      for (const uri of [...uris].sort((x, y) => position(x) - position(y))) {
        const group = this.store.groupOf(uri);
        if (!group) {
          continue;
        }
        const member = (u: string) => this.store.groupOf(u)?.id === group.id;
        const onlyNewTabs = group.uris.every((u) => added.has(u));
        for (const row of vscode.window.tabGroups.all) {
          const current = order(row);
          const index = current.indexOf(uri);
          if (index < 0) {
            continue;
          }
          if ((index > 0 && member(current[index - 1])) || (index < current.length - 1 && member(current[index + 1]))) {
            continue; // already next to its group
          }
          const rest = current.filter((_, i) => i !== index);
          let last = -1;
          rest.forEach((u, i) => {
            if (member(u) && (!onlyNewTabs || i < index)) {
              last = i;
            }
          });
          if (last < 0) {
            continue; // the group's first tab in this row: the others come to it
          }
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

function activeLocation(): { uri: vscode.Uri; viewColumn: vscode.ViewColumn } | undefined {
  const row = vscode.window.tabGroups.activeTabGroup;
  const uri = row.activeTab ? tabUri(row.activeTab) : undefined;
  return uri ? { uri, viewColumn: row.viewColumn } : undefined;
}
