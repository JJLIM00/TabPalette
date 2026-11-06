/**
 * The nine group colors are numbered slots, not fixed colors: each is a theme color
 * (`tabPalette.color1` … `tabPalette.color9`) that defaults to one of Chrome's group colors
 * and can be changed in `workbench.colorCustomizations`.
 */
export const GROUP_COLORS = ['color1', 'color2', 'color3', 'color4', 'color5', 'color6', 'color7', 'color8', 'color9'] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

/** Earlier versions stored Chrome color names; each maps to the slot that defaults to it. */
const LEGACY_COLOR_NAMES: Record<string, GroupColor> = {
  grey: 'color1',
  blue: 'color2',
  red: 'color3',
  yellow: 'color4',
  green: 'color5',
  pink: 'color6',
  purple: 'color7',
  cyan: 'color8',
  orange: 'color9',
};

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

/** A stored color: a slot, or an old Chrome color name (converted). Undefined if neither. */
export function toGroupColor(value: unknown): GroupColor | undefined {
  if (isGroupColor(value)) {
    return value;
  }
  return typeof value === 'string' ? LEGACY_COLOR_NAMES[value] : undefined;
}

/** "Color 1" … "Color 9" (the slots can be any color, so they are not named after one). */
export function colorLabel(color: GroupColor): string {
  return `Color ${color.slice('color'.length)}`;
}

/** Theme color id of a slot, contributed in package.json (CSS variable `--vscode-tabPalette-colorN`). */
export function themeColorId(color: GroupColor): string {
  return `tabPalette.${color}`;
}

export function displayName(group: TabGroup): string {
  return group.name.trim() || 'Unnamed group';
}
