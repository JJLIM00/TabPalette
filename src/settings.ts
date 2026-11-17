import * as vscode from 'vscode';
import { GROUP_COLORS, GroupColor, isHexColor } from './model';

/** The settings section: every setting is `tabPalette.<key>` (contributed in package.json). */
export const SETTINGS_SECTION = 'tabPalette';

/** The user's TabPalette settings, checked (see parseSettings). */
export interface Settings {
  /** Chrome's rounded outline around a group's active tab on the tab bar. */
  activeTabOutline: boolean;
  /** The widest a group chip gets on the tab bar, in pixels; a longer name ends in "…". */
  chipMaxWidth: number;
  /** When a group's chip shows how many tabs the group has. */
  chipTabCount: ChipTabCount;
  /** Group colors set in the settings (hex), by slot. A slot not listed uses its theme color. */
  colors: Partial<Record<GroupColor, string>>;
  /** The drop line's color (hex) when a dropped tab would leave its group; unset: its theme color. */
  ungroupDropLine?: string;
}

/** `tabPalette.tabBar.chipTabCount`: the tab count on a chip never, while its group is collapsed, or always. */
export const CHIP_TAB_COUNT = ['off', 'collapsed', 'always'] as const;
export type ChipTabCount = (typeof CHIP_TAB_COUNT)[number];

export const DEFAULT_SETTINGS: Settings = { activeTabOutline: true, chipMaxWidth: 160, chipTabCount: 'off', colors: {} };

/** The range `tabPalette.tabBar.chipMaxWidth` is kept in. */
export const CHIP_MAX_WIDTH = { min: 40, max: 400 };

/**
 * Reads the settings through `get` (a setting's value by its key in the section), keeping
 * each one in range: a missing or invalid value gets its default, so a typo in settings.json
 * never breaks the tab bar.
 */
export function parseSettings(get: (key: string) => unknown): Settings {
  const outline = get('tabBar.activeTabOutline');
  const width = get('tabBar.chipMaxWidth');
  const count = get('tabBar.chipTabCount');
  const hex = (key: string) => {
    const value = get(key);
    return typeof value === 'string' && isHexColor(value.trim()) ? value.trim() : undefined;
  };
  const colors: Settings['colors'] = {};
  for (const color of GROUP_COLORS) {
    const value = hex(`groupColors.${color}`);
    if (value) {
      colors[color] = value;
    }
  }
  const drop = hex('ungroupDropLineColor');
  return {
    activeTabOutline: typeof outline === 'boolean' ? outline : DEFAULT_SETTINGS.activeTabOutline,
    chipMaxWidth:
      typeof width === 'number' && Number.isFinite(width)
        ? Math.round(Math.min(CHIP_MAX_WIDTH.max, Math.max(CHIP_MAX_WIDTH.min, width)))
        : DEFAULT_SETTINGS.chipMaxWidth,
    chipTabCount: (CHIP_TAB_COUNT as readonly unknown[]).includes(count) ? (count as ChipTabCount) : DEFAULT_SETTINGS.chipTabCount,
    colors,
    ...(drop ? { ungroupDropLine: drop } : {}),
  };
}

/** The current settings, read again whenever the user changes one of them. */
export class SettingsWatcher implements vscode.Disposable {
  private value = SettingsWatcher.read();
  private readonly emitter = new vscode.EventEmitter<Settings>();
  /** A setting changed (fired only when the checked values differ). */
  readonly onDidChange = this.emitter.event;
  private readonly subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(SETTINGS_SECTION)) {
      return;
    }
    const next = SettingsWatcher.read();
    if (JSON.stringify(next) !== JSON.stringify(this.value)) {
      this.value = next;
      this.emitter.fire(next);
    }
  });

  get current(): Settings {
    return this.value;
  }

  /**
   * Only the values the user set count. A color's default in package.json is the dark theme's
   * color, shown in the Settings field; left as it is, the theme color is used, which differs
   * for light themes.
   */
  private static read(): Settings {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    return parseSettings((key) => {
      const values = config.inspect(key);
      return values?.workspaceFolderValue ?? values?.workspaceValue ?? values?.globalValue;
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
