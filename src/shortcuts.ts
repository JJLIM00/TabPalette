import * as path from 'path';
import * as vscode from 'vscode';

/** "Go to Group 1" … "Go to Group 9": one command per group, so each has its own key. */
export const GO_TO_GROUP_COMMANDS = Array.from({ length: 9 }, (_, i) => `tabPalette.goToGroup${i + 1}`);

export type Platform = 'win32' | 'darwin' | 'linux';

/**
 * The default keys of "Go to Group N" (as in package.json): Alt+N on Windows; Ctrl+N on macOS
 * (Alt+N types a character there, Cmd+N focuses an editor group); Ctrl+Alt+N on Linux (VS Code
 * uses Alt+N to switch tabs there).
 */
export function defaultGoToKey(platform: Platform, n: number): string {
  return platform === 'darwin' ? `ctrl+${n}` : platform === 'linux' ? `ctrl+alt+${n}` : `alt+${n}`;
}

/** Modifier keys held for a shortcut (its first part, for a chord like "ctrl+k 1"). */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** What the tab bar shows on the chips while the shortcut's modifier keys are held. */
export interface ChipShortcuts {
  /** The key of "Go to Group N" at index N-1, as VS Code writes it; null when it has none. */
  labels: (string | null)[];
  /** The modifier keys that show the labels: those of the first group's key that has some. */
  modifiers: Modifiers;
}

interface KeybindingEntry {
  key?: unknown;
  command?: unknown;
}

/**
 * The keys of "Go to Group 1" … "9": the defaults, changed by the user's keybindings.json
 * (VS Code's rules: an entry for the command adds a key and the last one counts here; "-command"
 * removes the default key, or every key when it names none).
 */
export function resolveGoToKeys(platform: Platform, userEntries: readonly KeybindingEntry[]): (string | null)[] {
  return GO_TO_GROUP_COMMANDS.map((command, i) => {
    let key: string | null = defaultGoToKey(platform, i + 1);
    for (const entry of userEntries) {
      const entryKey = typeof entry.key === 'string' ? normalizeKey(entry.key) : undefined;
      if (entry.command === command && entryKey) {
        key = entryKey;
      } else if (entry.command === `-${command}` && (!entryKey || entryKey === key)) {
        key = null;
      }
    }
    return key;
  });
}

/** A key as VS Code writes it: lower case, single spaces between the parts of a chord. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().split(/\s+/).join(' ');
}

const MAC_SYMBOLS: Record<string, string> = { ctrl: '⌃', shift: '⇧', alt: '⌥', cmd: '⌘', meta: '⌘' };
const NAMES: Record<string, string> = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };

/** A key the way VS Code shows it: "Ctrl+Alt+1" on Windows and Linux, "⌃⌥1" on macOS. */
export function formatKey(key: string, platform: Platform): string {
  return normalizeKey(key)
    .split(' ')
    .map((chord) => {
      // Modifiers in VS Code's order (⌃⌥⇧⌘ on macOS; Ctrl, Shift, Alt, Win elsewhere), then the key.
      const rank = (p: string) => {
        const i = (platform === 'darwin' ? ['ctrl', 'alt', 'shift', 'cmd', 'meta'] : ['ctrl', 'shift', 'alt', 'meta', 'win', 'cmd']).indexOf(p);
        return i < 0 ? 99 : i;
      };
      const parts = chord
        .split('+')
        .filter(Boolean)
        .sort((a, b) => rank(a) - rank(b));
      const name = (part: string) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1));
      if (platform === 'darwin') {
        return parts.map((p) => MAC_SYMBOLS[p] ?? name(p)).join('');
      }
      const meta = platform === 'linux' ? 'Super' : 'Win';
      return parts.map((p) => NAMES[p] ?? (['meta', 'win', 'cmd'].includes(p) ? meta : name(p))).join('+');
    })
    .join(' ');
}

/** The modifier keys of a key's first part. */
export function modifiersOf(key: string): Modifiers {
  const parts = normalizeKey(key).split(' ')[0].split('+');
  const has = (...names: string[]) => names.some((n) => parts.includes(n));
  return { ctrl: has('ctrl'), alt: has('alt'), shift: has('shift'), meta: has('meta', 'cmd', 'win') };
}

/** The chip labels for these keys; null when no group has a key with a modifier. */
export function chipShortcuts(keys: readonly (string | null)[], platform: Platform): ChipShortcuts | null {
  const held = keys.map((k) => (k ? modifiersOf(k) : null)).find((m) => !!m && (m.ctrl || m.alt || m.shift || m.meta));
  return held ? { labels: keys.map((k) => (k ? formatKey(k, platform) : null)), modifiers: held } : null;
}

/** Reads keybindings.json, which may have comments and trailing commas. Anything wrong: no entries. */
export function parseKeybindings(text: string): KeybindingEntry[] {
  // Drop comments outside strings, then trailing commas.
  const code = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '');
  try {
    const value: unknown = JSON.parse(code.replace(/,(\s*[\]}])/g, '$1'));
    return Array.isArray(value) ? value.filter((e): e is KeybindingEntry => !!e && typeof e === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * The keys of "Go to Group N", kept up to date: VS Code does not tell extensions their keys, so
 * they are read from the user's keybindings.json (next to settings.json in the user folder).
 */
export class ShortcutWatcher implements vscode.Disposable {
  private keys: (string | null)[];
  private readonly emitter = new vscode.EventEmitter<void>();
  /** The keys changed. */
  readonly onDidChange = this.emitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly platform: Platform;

  constructor(context: vscode.ExtensionContext) {
    this.platform = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32';
    // globalStorage/<extension> is in the user folder.
    const user = vscode.Uri.file(path.resolve(context.globalStorageUri.fsPath, '..', '..'));
    const file = vscode.Uri.joinPath(user, 'keybindings.json');
    this.keys = resolveGoToKeys(this.platform, []);
    const reload = () => void this.load(file);
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(user, 'keybindings.json'));
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
    reload();
  }

  /** The labels for the chips. */
  get current(): ChipShortcuts | null {
    return chipShortcuts(this.keys, this.platform);
  }

  private async load(file: vscode.Uri): Promise<void> {
    let entries: KeybindingEntry[] = [];
    try {
      entries = parseKeybindings(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
    } catch {
      // No keybindings.json: the default keys.
    }
    const keys = resolveGoToKeys(this.platform, entries);
    if (keys.join() !== this.keys.join()) {
      this.keys = keys;
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
