import * as vscode from 'vscode';
import { GROUP_COLORS, GroupColor, TabGroup, isGroupColor } from './model';

/** The subset of `vscode.Memento` the store needs (lets tests pass a fake). */
export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export const STORAGE_KEY = 'tabPalette.v1';

/**
 * Holds all tab groups for the workspace and persists them on every change.
 * Invariant: a file (URI string) belongs to at most one group.
 */
export class GroupStore implements vscode.Disposable {
  private groups: TabGroup[];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly storage: StateStorage) {
    this.groups = GroupStore.load(storage.get<unknown>(STORAGE_KEY));
  }

  all(): readonly TabGroup[] {
    return this.groups;
  }

  get(id: string): TabGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupOf(uri: string): TabGroup | undefined {
    return this.groups.find((g) => g.uris.includes(uri));
  }

  /** First color not used by any group, cycling when all are taken. */
  nextColor(): GroupColor {
    const used = new Set(this.groups.map((g) => g.color));
    return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[this.groups.length % GROUP_COLORS.length];
  }

  create(name: string, color: GroupColor = this.nextColor(), uris: string[] = []): TabGroup {
    const group: TabGroup = { id: newId(), name: name.trim(), color, uris: [], collapsed: false, closed: false };
    this.takeFromOtherGroups(uris);
    group.uris.push(...unique(uris));
    this.groups.push(group);
    this.commit();
    return group;
  }

  /** Not trimmed, so live typing in the group editor keeps spaces between words. */
  rename(id: string, name: string): void {
    const g = this.get(id);
    if (g && g.name !== name) {
      g.name = name;
      this.commit();
    }
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const g = this.get(id);
    if (g && g.collapsed !== collapsed) {
      g.collapsed = collapsed;
      this.commit();
    }
  }

  setClosed(id: string, closed: boolean): void {
    const g = this.get(id);
    if (g && g.closed !== closed) {
      g.closed = closed;
      if (closed) {
        g.collapsed = false;
      }
      this.commit();
    }
  }

  /** Chrome removes a group when its last tab leaves (unless it was closed on purpose). */
  pruneEmpty(): void {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => g.uris.length > 0 || g.closed);
    if (this.groups.length !== before) {
      this.commit();
    }
  }

  setColor(id: string, color: GroupColor): void {
    const g = this.get(id);
    if (g) {
      g.color = color;
      this.commit();
    }
  }

  /**
   * Adds files to a group, moving them out of any other group (a group that loses its
   * last tab this way is deleted, like Chrome). When `beforeUri` is a member of the
   * target group, they are inserted before it.
   */
  addUris(id: string, uris: string[], beforeUri?: string): void {
    const g = this.get(id);
    if (!g) {
      return;
    }
    const items = unique(uris);
    this.takeFromOtherGroups(items, id);
    const index = beforeUri ? g.uris.indexOf(beforeUri) : -1;
    if (index < 0) {
      g.uris.push(...items);
    } else {
      g.uris.splice(index, 0, ...items);
    }
    this.commit();
  }

  removeUris(uris: string[]): void {
    if (this.detach(uris)) {
      this.commit();
    }
  }

  /** Removes the group; its files simply become ungrouped. */
  remove(id: string): TabGroup | undefined {
    const index = this.groups.findIndex((g) => g.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = this.groups.splice(index, 1);
    this.commit();
    return removed;
  }

  /** Follows a file or folder rename: `oldUri` itself and anything under it. */
  renameUri(oldUri: string, newUri: string): void {
    let changed = false;
    for (const g of this.groups) {
      g.uris = g.uris.map((u) => {
        if (isSameOrChild(u, oldUri)) {
          changed = true;
          return newUri + u.slice(oldUri.length);
        }
        return u;
      });
    }
    if (changed) {
      this.commit();
    }
  }

  /** Drops a deleted file or folder (and anything under it) from all groups. */
  removeUriTree(uri: string): void {
    this.removeUris(this.groups.flatMap((g) => g.uris).filter((u) => isSameOrChild(u, uri)));
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /**
   * Moving tabs into a group: takes them out of their current groups, and deletes any
   * group that this leaves with no tabs (except `keepId`, and closed groups, which
   * are kept on purpose until reopened or deleted).
   */
  private takeFromOtherGroups(uris: string[], keepId?: string): void {
    const set = new Set(uris);
    const losing = new Set(this.groups.filter((g) => g.id !== keepId && g.uris.some((u) => set.has(u))).map((g) => g.id));
    this.detach(uris);
    this.groups = this.groups.filter((g) => !losing.has(g.id) || g.uris.length > 0 || g.closed);
  }

  private detach(uris: string[]): boolean {
    if (uris.length === 0) {
      return false;
    }
    const set = new Set(uris);
    let changed = false;
    for (const g of this.groups) {
      const kept = g.uris.filter((u) => !set.has(u));
      if (kept.length !== g.uris.length) {
        g.uris = kept;
        changed = true;
      }
    }
    return changed;
  }

  private commit(): void {
    void this.storage.update(STORAGE_KEY, this.groups);
    this.emitter.fire();
  }

  /** Reads persisted data defensively; bad entries are dropped or repaired. */
  private static load(raw: unknown): TabGroup[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const seen = new Set<string>();
    const groups: TabGroup[] = [];
    for (const item of raw as Partial<TabGroup>[]) {
      if (!item || typeof item.id !== 'string' || groups.some((g) => g.id === item.id)) {
        continue;
      }
      const uris = (Array.isArray(item.uris) ? item.uris : []).filter((u): u is string => {
        if (typeof u !== 'string' || seen.has(u)) {
          return false;
        }
        seen.add(u);
        return true;
      });
      groups.push({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : '',
        color: isGroupColor(item.color) ? item.color : 'grey',
        uris,
        collapsed: item.collapsed === true,
        closed: item.closed === true,
      });
    }
    return groups;
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isSameOrChild(uri: string, parent: string): boolean {
  return uri === parent || uri.startsWith(parent.endsWith('/') ? parent : parent + '/');
}
