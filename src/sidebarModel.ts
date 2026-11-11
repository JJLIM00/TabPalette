/**
 * Pure rules for the Tab Groups side bar (unit-tested). A tab row is the list of tab keys of
 * one editor group, in order: `Uri.toString()` for file tabs, `#<label>` for other tabs.
 */

/** Where a dragged tab was dropped in the side bar. */
export type DropTarget =
  /** On a tab: before it, or after it. */
  | { index: number; after: boolean }
  /** On a group's header: join the group, at its start. */
  | { header: string }
  /** On the empty space below the tabs: the end of the row, outside any group. */
  | { end: true };

export interface TabDropPlan {
  /** Index of the tab once moved (equal to `from` when it stays in place). */
  to: number;
  /** The group the tab ends up in, or undefined for none. */
  group: string | undefined;
}

/**
 * What dropping the tab at `from` on `target` does, like dropping it in Chrome's vertical tabs:
 * - dropped before or after a grouped tab, or on a group's header → in that group;
 * - dropped next to an ungrouped tab, or below all tabs → in no group, except that a group's
 *   only tab in this row keeps its group (the group moves with it);
 * - tabs that are not files never join a group.
 * Undefined when nothing changes.
 */
export function planTabDrop(
  row: readonly string[],
  from: number,
  target: DropTarget,
  groupOf: (key: string) => string | undefined,
): TabDropPlan | undefined {
  const key = row[from];
  if (key === undefined) {
    return undefined;
  }
  const own = groupOf(key);
  let insert: number;
  let targetGroup: string | undefined;
  if ('header' in target) {
    insert = row.findIndex((k) => groupOf(k) === target.header);
    if (insert < 0) {
      return undefined;
    }
    targetGroup = target.header;
  } else if ('end' in target) {
    insert = row.length;
  } else {
    if (target.index < 0 || target.index >= row.length) {
      return undefined;
    }
    insert = target.index + (target.after ? 1 : 0);
    targetGroup = groupOf(row[target.index]);
  }
  const to = insert > from ? insert - 1 : insert;
  const onlyMember = !!own && !row.some((k, i) => i !== from && groupOf(k) === own);
  let group = targetGroup ?? (onlyMember ? own : undefined);
  if (key.startsWith('#')) {
    group = undefined;
  }
  return to === from && group === own ? undefined : { to, group };
}

export interface TabsDropPlan {
  /** The row afterwards. */
  order: string[];
  /** How many of the other tabs end up before the dropped tabs. */
  othersBefore: number;
  /** The group the dropped file tabs join, if any. */
  group: string | undefined;
  /** Dropped tabs that leave their group. */
  leaving: string[];
}

/**
 * Several selected tabs (at `from`, any order) dropped together on `target`, like Chrome:
 * they land side by side, in their row order.
 * - On a grouped tab or a group's header → the file tabs join that group.
 * - Elsewhere → each grouped tab leaves its group, unless all of that group's tabs in this
 *   row were dragged along (then the group moves with them).
 * Undefined when nothing changes, or when dropped on one of the dragged tabs.
 */
export function planTabsDrop(
  row: readonly string[],
  from: readonly number[],
  target: DropTarget,
  groupOf: (key: string) => string | undefined,
): TabsDropPlan | undefined {
  const dragged = new Set(from);
  if (from.length === 0 || from.some((i) => row[i] === undefined)) {
    return undefined;
  }
  let insert: number;
  let group: string | undefined;
  if ('header' in target) {
    insert = row.findIndex((k) => groupOf(k) === target.header);
    if (insert < 0) {
      return undefined;
    }
    group = target.header;
  } else if ('end' in target) {
    insert = row.length;
  } else {
    if (target.index < 0 || target.index >= row.length || dragged.has(target.index)) {
      return undefined;
    }
    insert = target.index + (target.after ? 1 : 0);
    group = groupOf(row[target.index]);
  }
  const keys = row.filter((_, i) => dragged.has(i));
  const others = row.filter((_, i) => !dragged.has(i));
  const othersBefore = row.slice(0, insert).filter((_, i) => !dragged.has(i)).length;
  const order = [...others.slice(0, othersBefore), ...keys, ...others.slice(othersBefore)];
  const files = keys.filter((k) => !k.startsWith('#'));
  const leaving = group
    ? []
    : files.filter((k) => {
        const g = groupOf(k);
        return !!g && others.some((o) => groupOf(o) === g);
      });
  const moved = order.some((k, i) => k !== row[i]);
  const joining = !!group && files.some((k) => groupOf(k) !== group);
  return moved || joining || leaving.length > 0 ? { order, othersBefore, group, leaving } : undefined;
}

/**
 * For dropping a whole group (dragged by its header): the index of the tab it goes before,
 * or the row length for the end. A drop on a tab inside another group goes before that group.
 */
export function groupDropIndex(
  row: readonly string[],
  target: DropTarget,
  groupOf: (key: string) => string | undefined,
): number | undefined {
  const startOf = (group: string) => row.findIndex((k) => groupOf(k) === group);
  if ('end' in target) {
    return row.length;
  }
  if ('header' in target) {
    const start = startOf(target.header);
    return start < 0 ? undefined : start;
  }
  if (target.index < 0 || target.index >= row.length) {
    return undefined;
  }
  const other = groupOf(row[target.index]);
  if (other) {
    if (!target.after) {
      return startOf(other);
    }
    let end = target.index;
    while (end + 1 < row.length && groupOf(row[end + 1]) === other) {
      end++;
    }
    return end + 1;
  }
  return target.index + (target.after ? 1 : 0);
}

/** Moves the item at `from` to index `to` (the index it has afterwards). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const result = [...list];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}
