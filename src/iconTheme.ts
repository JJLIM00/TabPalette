import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** A tab's file icon, as the side bar draws it: a picture, or a character of an icon font. */
export type FileIcon = { src: string } | { char: string; font: string; color?: string; size?: string };

/** Where VS Code keeps its icon font (codicon.ttf). */
const CODICON_FOLDER = () => vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), 'out', 'media');
/** The name the side bar gives VS Code's icon font (not "codicon", so no theme's font can clash). */
const CODICON_FAMILY = 'tabpalette-codicon';

/** An icon font the page loads (with the FontFace API, so no inline style is needed). */
export interface IconFont {
  family: string;
  src: string;
  weight?: string;
  style?: string;
}

interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

interface Associations {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
}

interface ThemeDocument extends Associations {
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  iconDefinitions?: Record<string, IconDefinition>;
  light?: Associations;
  highContrast?: Associations;
}

/** A loaded file icon theme: its file and what it says. */
interface LoadedTheme {
  id: string;
  folder: vscode.Uri;
  doc: ThemeDocument;
}

/**
 * The file icons of the current file icon theme (`workbench.iconTheme`), so the side bar shows
 * the same icons as the Explorer and the tab bar. A webview can't use the theme directly, so
 * the theme's file is read here and each tab gets the icon VS Code would pick for it.
 */
export class FileIconTheme implements vscode.Disposable {
  private theme: LoadedTheme | undefined | null = null; // null: not loaded yet
  /** Icons already worked out, by file name and language, for one webview and color theme. */
  private readonly icons = new Map<string, FileIcon | undefined>();
  private iconsFor: { webview: vscode.Webview; variant: ThemeVariant } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.iconTheme')) {
          this.reload();
        }
      }),
      vscode.extensions.onDidChange(() => this.reload()),
      // Themes can have other icons for light and high contrast themes.
      vscode.window.onDidChangeActiveColorTheme(() => this.changed.fire()),
    ];
  }

  /** Folders the page must be allowed to load icons from: every extension with a file icon theme. */
  static resourceRoots(): vscode.Uri[] {
    return [CODICON_FOLDER(), ...vscode.extensions.all.filter((e) => themesOf(e).length > 0).map((e) => e.extensionUri)];
  }

  /**
   * A symbol of VS Code's own icon font (the icons of Settings, Extension pages…), drawn with
   * that font, which VS Code ships in its app folder.
   */
  static codicon(char: string, webview: vscode.Webview): { icon: FileIcon; font: IconFont } {
    const src = webview.asWebviewUri(vscode.Uri.joinPath(CODICON_FOLDER(), 'codicon.ttf'));
    return { icon: { char, font: CODICON_FAMILY }, font: { family: CODICON_FAMILY, src: `url("${src}") format("truetype")` } };
  }

  private reload(): void {
    this.theme = null;
    this.icons.clear();
    this.changed.fire();
  }

  /** The icon VS Code shows for a file, or undefined (no theme, or nothing in it for this file). */
  iconFor(uri: vscode.Uri, languageId: string | undefined, webview: vscode.Webview): FileIcon | undefined {
    const variant = colorThemeVariant();
    if (this.iconsFor?.webview !== webview || this.iconsFor.variant !== variant) {
      this.icons.clear();
      this.iconsFor = { webview, variant };
    }
    const name = path.posix.basename(uri.path);
    const key = name.toLowerCase() + '|' + (languageId ?? '');
    if (!this.icons.has(key)) {
      this.icons.set(key, this.resolveIcon(name, languageId, variant, webview));
    }
    return this.icons.get(key);
  }

  private resolveIcon(name: string, languageId: string | undefined, variant: ThemeVariant, webview: vscode.Webview): FileIcon | undefined {
    const theme = this.current();
    if (!theme) {
      return undefined;
    }
    const id = pickIcon(theme.doc, name, languageId, variant);
    const def = id ? theme.doc.iconDefinitions?.[id] : undefined;
    if (!def) {
      return undefined;
    }
    if (def.iconPath) {
      return { src: webview.asWebviewUri(vscode.Uri.joinPath(theme.folder, def.iconPath)).toString() };
    }
    if (def.fontCharacter) {
      const font = def.fontId ?? theme.doc.fonts?.[0]?.id;
      if (!font) {
        return undefined;
      }
      const size = def.fontSize ?? theme.doc.fonts?.find((f) => f.id === font)?.size;
      return { char: fontCharacter(def.fontCharacter), font: fontFamily(theme.id, font), color: def.fontColor, size };
    }
    return undefined;
  }

  /** The theme's icon fonts. */
  fonts(webview: vscode.Webview): IconFont[] {
    const theme = this.current();
    return (theme?.doc.fonts ?? []).flatMap((f) => {
      const src = f.src
        .map((s) => `url("${webview.asWebviewUri(vscode.Uri.joinPath(theme!.folder, s.path))}")${s.format ? ` format("${s.format}")` : ''}`)
        .join(', ');
      return src ? [{ family: fontFamily(theme!.id, f.id), src, weight: f.weight, style: f.style }] : [];
    });
  }

  private current(): LoadedTheme | undefined {
    if (this.theme === null) {
      this.theme = loadTheme(vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme'));
    }
    return this.theme;
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
  }
}

// ---------- pure rules (unit-tested) ----------

export type ThemeVariant = 'dark' | 'light' | 'highContrast';

/**
 * The icon id VS Code picks for a file, by its rules: a file name match, then the longest
 * file extension match ("d.ts" before "ts"), then the language, then the theme's default.
 * Light and high contrast themes look in their own section first.
 */
export function pickIcon(
  doc: ThemeDocument,
  fileName: string,
  languageId: string | undefined,
  variant: ThemeVariant = 'dark',
): string | undefined {
  const sections = [variant === 'light' ? doc.light : variant === 'highContrast' ? doc.highContrast : undefined, doc].filter(
    (s): s is Associations => !!s,
  );
  const lookup = (pick: (s: Associations) => Record<string, string> | undefined, key: string) => {
    for (const s of sections) {
      const map = pick(s);
      if (map) {
        const hit = map[key] ?? caseless(map, key);
        if (hit) {
          return hit;
        }
      }
    }
    return undefined;
  };
  const name = fileName.toLowerCase();
  const byName = lookup((s) => s.fileNames, name);
  if (byName) {
    return byName;
  }
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    const byExtension = lookup((s) => s.fileExtensions, name.slice(dot + 1));
    if (byExtension) {
      return byExtension;
    }
  }
  const byLanguage = languageId ? lookup((s) => s.languageIds, languageId) : undefined;
  return byLanguage ?? sections.map((s) => s.file).find((f) => !!f);
}

/** Theme files are JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          i++;
        }
      }
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j++;
      }
      if (text[j] !== '}' && text[j] !== ']') {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/** `\E001` (the theme's notation) or a literal character, as the character itself. */
export function fontCharacter(value: string): string {
  const m = /^\\([0-9a-f]{1,6})$/i.exec(value);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : value;
}

function caseless(map: Record<string, string>, key: string): string | undefined {
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === key) {
      return map[k];
    }
  }
  return undefined;
}

// ---------- loading ----------

function themesOf(e: vscode.Extension<unknown>): { id: string; path: string }[] {
  const themes = (e.packageJSON as { contributes?: { iconThemes?: unknown } })?.contributes?.iconThemes;
  return Array.isArray(themes) ? themes.filter((t) => typeof t?.id === 'string' && typeof t?.path === 'string') : [];
}

function loadTheme(id: string | null | undefined): LoadedTheme | undefined {
  if (!id) {
    return undefined; // "None": VS Code shows no file icons
  }
  for (const e of vscode.extensions.all) {
    const entry = themesOf(e).find((t) => t.id === id);
    if (entry) {
      try {
        const file = vscode.Uri.joinPath(e.extensionUri, entry.path);
        const doc = parseJsonc(fs.readFileSync(file.fsPath, 'utf8')) as ThemeDocument;
        return { id, folder: vscode.Uri.joinPath(file, '..'), doc };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function colorThemeVariant(): ThemeVariant {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return 'highContrast';
    default:
      return 'dark';
  }
}

function fontFamily(themeId: string, fontId: string): string {
  return `tp-icons-${(themeId + '-' + fontId).replace(/[^\w-]/g, '_')}`;
}
