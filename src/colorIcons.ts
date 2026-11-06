import * as vscode from 'vscode';
import { GroupColor, themeColorId } from './model';

type Defaults = { dark: string; light: string; highContrast?: string; highContrastLight?: string };
type ThemeKind = 'dark' | 'light' | 'highContrast' | 'highContrastLight';

/**
 * The color a theme color id resolves to, as far as an extension can tell: the user's
 * `workbench.colorCustomizations` (a block for the current theme, `"[Theme Name]": {…}`,
 * wins over the general value), else the contributed default for the theme kind.
 * Only plain hex values are used from the settings; anything else falls back to the default.
 */
export function resolveThemeColor(
  id: string,
  customizations: Record<string, unknown>,
  themeName: string | undefined,
  kind: ThemeKind,
  defaults: Defaults,
): string {
  const themed = themeName ? customizations[`[${themeName}]`] : undefined;
  const candidates = [typeof themed === 'object' && themed ? (themed as Record<string, unknown>)[id] : undefined, customizations[id]];
  for (const value of candidates) {
    if (typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
      return value;
    }
  }
  return defaults[kind] ?? (kind === 'highContrastLight' ? defaults.light : defaults.dark);
}

/**
 * Colored dots for the Command Palette pickers. VS Code's quick pick ignores the color of a
 * ThemeIcon from an extension, so each dot is a small SVG image in the slot's current color
 * (following the user's color settings, see resolveThemeColor).
 */
export function colorIconFactory(ctx: vscode.ExtensionContext): (color: GroupColor) => vscode.Uri {
  const contributed = (ctx.extension.packageJSON.contributes?.colors ?? []) as { id: string; defaults: Defaults }[];
  return (color) => {
    const id = themeColorId(color);
    const defaults = contributed.find((c) => c.id === id)?.defaults ?? { dark: '#888888', light: '#888888' };
    const workbench = vscode.workspace.getConfiguration('workbench');
    const hex = resolveThemeColor(
      id,
      workbench.get<Record<string, unknown>>('colorCustomizations') ?? {},
      workbench.get<string>('colorTheme'),
      themeKind(vscode.window.activeColorTheme.kind),
      defaults,
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${hex}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  };
}

function themeKind(kind: vscode.ColorThemeKind): ThemeKind {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'highContrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'highContrastLight';
    default:
      return 'dark';
  }
}
