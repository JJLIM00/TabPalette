import * as vscode from 'vscode';
import { TabGroup } from './model';
import { GroupStore } from './store';
import { CloseGuard, tabUri } from './tabs';

// ---------- pure rules (unit-tested) ----------

/**
 * When `after` is `before` with exactly one item moved, returns that item.
 * Returns undefined for no move, several moves, or different contents.
 */
export function movedItem(before: readonly string[], after: readonly string[], prefer?: string): string | undefined {
  if (before.length !== after.length || before.length < 2 || before.every((x, i) => x === after[i])) {
    return undefined;
  }
  const without = (list: readonly string[], x: string) => {
    const i = list.indexOf(x);
    return [...list.slice(0, i), ...list.slice(i + 1)];
  };
  const isTheMove = (x: string) => {
    if (!before.includes(x) || before.indexOf(x) === after.indexOf(x)) {
      return false;
    }
    const a = without(before, x);
    const b = without(after, x);
    return a.every((y, i) => y === b[i]);
  };
  // Swapping two neighbours is ambiguous; the dragged tab is the active one.
  if (prefer && isTheMove(prefer)) {
    return prefer;
  }
  return after.find(isTheMove);
}

export type MembershipChange = { join: string } | { leave: string } | undefined;

/**
 * Chrome-style membership for the tab at `index` after it was dropped (or opened) there:
 * - between two tabs of the same group → joins that group;
 * - a grouped tab dragged away from all its siblings in this tab row → leaves its group.
 *   (A group's only tab in this row keeps its group wherever it goes.)
 */
export function decideMembership(
  order: readonly string[],
  index: number,
  groupOf: (uri: string) => string | undefined,
  allowLeave = true,
): MembershipChange {
  const self = groupOf(order[index]);
  const left = index > 0 ? groupOf(order[index - 1]) : undefined;
  const right = index < order.length - 1 ? groupOf(order[index + 1]) : undefined;
  if (left && left === right && left !== self) {
    return { join: left };
  }
  if (allowLeave && self && left !== self && right !== self) {
    const siblings = order.filter((u, i) => i !== index && groupOf(u) === self).length;
    if (siblings > 0) {
      return { leave: self };
    }
  }
  return undefined;
}

// ---------- tracking real tab rows ----------

/**
 * Watches tab rows and applies Chrome rules: drag between group tabs to join,
 * drag out to leave, closing a tab removes it, an emptied group disappears,
 * and activating a tab of a collapsed group expands it.
 *
 * Like a Chrome group lives in one window, a group lives in one tab row (editor group): its
 * "home". A tab dragged to another row leaves its group (a group's only tab takes the group
 * along), and a second tab of the same file in another row (Open to the Side) is not grouped.
 */
export class MembershipTracker implements vscode.Disposable {
  private readonly snapshots = new WeakMap<vscode.TabGroup, string[]>();
  private readonly subscription: vscode.Disposable;
  private suspended = 0;
  /** The tab row each group lives in (see `homeOf`). */
  private readonly homes = new Map<string, vscode.TabGroup>();
  /**
   * `homeOf` results until the tabs or the groups change: the tab bar and the side bar ask
   * for every tab when they redraw, and each answer counts the group's tabs in every row.
   */
  private readonly resolved = new Map<string, vscode.TabGroup | undefined>();

  constructor(
    private readonly store: GroupStore,
    private readonly guard: CloseGuard,
  ) {
    this.resync();
    this.subscription = vscode.Disposable.from(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        this.resolved.clear();
        this.onTabs(e);
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.resolved.clear();
        this.resync();
      }),
      store.onDidChange(() => this.resolved.clear()),
    );
  }

  /** Runs programmatic tab moves without them counting as user drags. */
  async suspend<T>(fn: () => Thenable<T> | Promise<T>): Promise<T> {
    this.suspended++;
    try {
      return await fn();
    } finally {
      this.suspended--;
      this.resync();
    }
  }

  /**
   * The tab row a group lives in: the row it was in, as long as one of its tabs is still
   * there; otherwise the row with the most of its tabs. Undefined when none is open.
   */
  homeOf(groupId: string): vscode.TabGroup | undefined {
    if (this.resolved.has(groupId)) {
      return this.resolved.get(groupId);
    }
    const home = this.findHome(groupId);
    this.resolved.set(groupId, home);
    return home;
  }

  private findHome(groupId: string): vscode.TabGroup | undefined {
    const group = this.store.get(groupId);
    if (!group) {
      this.homes.delete(groupId);
      return undefined;
    }
    const members = new Set(group.uris);
    const count = (row: vscode.TabGroup) => order(row).filter((u) => members.has(u)).length;
    const rows = vscode.window.tabGroups.all;
    const home = this.homes.get(groupId);
    if (home && rows.includes(home) && count(home) > 0) {
      return home;
    }
    let best: vscode.TabGroup | undefined;
    let most = 0;
    for (const row of rows) {
      const n = count(row);
      if (n > most) {
        best = row;
        most = n;
      }
    }
    if (best) {
      this.homes.set(groupId, best);
    } else {
      this.homes.delete(groupId);
    }
    return best;
  }

  /** The group of the tab with this URI in this tab row: none outside the group's home row. */
  groupIn(row: vscode.TabGroup, uri: string): TabGroup | undefined {
    const group = this.store.groupOf(uri);
    if (!group) {
      return undefined;
    }
    const home = this.homeOf(group.id);
    return !home || home === row ? group : undefined;
  }

  /** Tabs in another row than their group's (dragged there) leave the group, like Chrome's other window. */
  private dropStrays(): void {
    const open = new Set(vscode.window.tabGroups.all.flatMap((row) => order(row)));
    const strays: string[] = [];
    for (const group of this.store.all()) {
      const home = group.closed ? undefined : this.homeOf(group.id);
      if (home) {
        const inHome = new Set(order(home));
        strays.push(...group.uris.filter((u) => open.has(u) && !inHome.has(u)));
      }
    }
    if (strays.length > 0) {
      this.store.removeUris(strays);
      this.store.pruneEmpty();
    }
  }

  private resync(): void {
    for (const group of vscode.window.tabGroups.all) {
      this.snapshots.set(group, order(group));
    }
  }

  private onTabs(e: vscode.TabChangeEvent): void {
    // Closed tabs leave their group (Chrome), unless we closed them (Close group, Delete group).
    const stillOpen = e.closed.length > 0 ? new Set(vscode.window.tabGroups.all.flatMap((g) => order(g))) : undefined;
    const closed = e.closed
      .map((t) => tabUri(t)?.toString())
      .filter((u): u is string => !!u && !stillOpen!.has(u) && !this.guard.consume(u) && !!this.store.groupOf(u));
    if (closed.length > 0) {
      this.store.removeUris(closed);
      this.store.pruneEmpty();
    }

    // Chrome: pinned tabs are never in a group, so pinning a grouped tab takes it out.
    const pinned = [...e.opened, ...e.changed]
      .filter((t) => t.isPinned)
      .map((t) => tabUri(t)?.toString())
      .filter((u): u is string => !!u && !!this.store.groupOf(u));
    if (pinned.length > 0) {
      this.store.removeUris(pinned);
      this.store.pruneEmpty();
    }

    if (this.suspended === 0) {
      for (const group of vscode.window.tabGroups.all) {
        const before = this.snapshots.get(group);
        const after = order(group);
        if (!before) {
          continue;
        }
        const groupOf = (u: string) => this.groupIn(group, u)?.id;
        const activeTab = group.activeTab ? tabUri(group.activeTab)?.toString() : undefined;
        const moved = movedItem(before, after, activeTab);
        let target: string | undefined = moved;
        let allowLeave = true;
        if (!moved && after.length === before.length + 1) {
          // A newly opened tab: it may join (never leave) the group it lands in.
          target = after.find((u) => !before.includes(u));
          allowLeave = false;
        }
        if (target) {
          const change = decideMembership(after, after.indexOf(target), groupOf, allowLeave);
          if (change && 'join' in change) {
            this.store.addUris(change.join, [target]);
          } else if (change && 'leave' in change) {
            this.store.removeUris([target]);
            this.store.pruneEmpty();
          }
        }
      }
      this.dropStrays();
    }
    this.resync();

    // Activating a hidden tab of a collapsed group expands it (Chrome).
    const activeRow = vscode.window.tabGroups.activeTabGroup;
    const active = activeRow.activeTab;
    const uri = active ? tabUri(active)?.toString() : undefined;
    const g = uri ? this.groupIn(activeRow, uri) : undefined;
    if (g?.collapsed && this.suspended === 0) {
      this.store.setCollapsed(g.id, false);
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

export function order(group: vscode.TabGroup): string[] {
  return group.tabs.map((t) => tabUri(t)?.toString() ?? `#${t.label}`);
}
