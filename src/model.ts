export const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export interface TabGroup {
  id: string;
  /** May be empty, like an unnamed Chrome group (shown as a colored dot). */
  name: string;
  color: GroupColor;
  /** Member files as `Uri.toString()` strings, in display order. */
  uris: string[];
  /** Chrome "collapse": the chip stays, member tabs are hidden in the tab bar. */
  collapsed: boolean;
  /** Chrome "Close group": tabs closed, group kept so it can be reopened. */
  closed: boolean;
}

export function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === 'string' && (GROUP_COLORS as readonly string[]).includes(value);
}

export function colorLabel(color: GroupColor): string {
  return color[0].toUpperCase() + color.slice(1);
}

export function displayName(group: TabGroup): string {
  return group.name.trim() || 'Unnamed group';
}
