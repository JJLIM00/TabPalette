import * as vscode from 'vscode';

/** Scheme of the keys of tabs that show no file (webviews like Git Graph, terminals, settings…). */
const OTHER_TAB_SCHEME = 'tabpalette-tab';

/** The key each tab that shows no file got when first seen (see otherTabUri). */
const otherKeys = new WeakMap<vscode.Tab, vscode.Uri>();

/**
 * The tab's key, which groups store: the file it shows, or for any other tab (a webview like
 * Git Graph, a terminal, the settings…) a `tabpalette-tab:` URI made of its kind and title.
 */
export function tabUri(tab: vscode.Tab): vscode.Uri {
  const input = tab.input;
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputNotebook
  ) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
    return input.modified;
  }
  return otherTabUri(tab);
}

/** True for the key of a tab that shows no file: it can only be shown, not opened again. */
export function isOtherTab(key: string | vscode.Uri): boolean {
  return typeof key === 'string' ? key.startsWith(`${OTHER_TAB_SCHEME}:`) : key.scheme === OTHER_TAB_SCHEME;
}

/**
 * Tabs that show no file have no URI, so their key is their kind and title, which stays the
 * same after a reload. A tab keeps the key it got first while it is open (its title may
 * change). Two tabs with the same kind and title in one tab row (two "Claude Code" tabs) are
 * told apart by a number; in different rows they share the key, like one file open in two
 * rows (and a tab moved to another row keeps its key, though VS Code reports it opened there
 * before it closed here).
 */
function otherTabUri(tab: vscode.Tab): vscode.Uri {
  const known = otherKeys.get(tab);
  if (known) {
    return known;
  }
  const input = tab.input;
  const kind =
    input instanceof vscode.TabInputWebview ? input.viewType : input instanceof vscode.TabInputTerminal ? 'terminal' : 'editor';
  const base = vscode.Uri.from({ scheme: OTHER_TAB_SCHEME, path: `/${kind}/${tab.label}` });
  const taken = new Set(tab.group.tabs.map((t) => otherKeys.get(t)?.toString()));
  let key = base;
  for (let n = 2; taken.has(key.toString()); n++) {
    key = base.with({ query: String(n) });
  }
  otherKeys.set(tab, key);
  return key;
}

export function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

/** URI strings of every file currently open in a tab. */
export function openUris(): Set<string> {
  const set = new Set<string>();
  for (const tab of allTabs()) {
    set.add(tabUri(tab).toString());
  }
  return set;
}

export function activeTabUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab ? tabUri(tab) : undefined;
}

/**
 * The key of the tab a tab context-menu command was run on. VS Code passes the tab's resource
 * and `{ editorIndex }`. A tab that shows no file has a resource no tab key matches (a webview
 * gets a new `webview-panel:` URI each time it opens), so find it by its position, in the
 * active row first.
 */
export function menuTabUri(resource: vscode.Uri | undefined, context: unknown): vscode.Uri | undefined {
  const index = (context as { editorIndex?: unknown } | undefined)?.editorIndex;
  if ((resource && openUris().has(resource.toString())) || typeof index !== 'number') {
    return resource;
  }
  const rows = [vscode.window.tabGroups.activeTabGroup, ...vscode.window.tabGroups.all];
  const tab = rows.map((row) => row.tabs[index]).find((t) => t && isOtherTab(tabUri(t)));
  return tab ? tabUri(tab) : resource;
}

/**
 * URIs of the tabs multi-selected (Ctrl/Shift+click) in the tab bar.
 *
 * The extension API does not expose tab selection. The reliable source is the tab bar
 * itself: with the tab bar patch on, it reports the selection when a tab is right-clicked
 * (`fromTabBar`). Without it, fall back to VS Code's `copyFilePath` command, which copies
 * the paths of all selected tabs when called with one of them: run it, read the clipboard,
 * put the user's clipboard text back, and map the paths to open tabs. That depends on the
 * clipboard, so it is only the fallback. Returns just `anchor` when nothing else is selected.
 */
export async function selectedTabUris(
  anchor: vscode.Uri | undefined = activeTabUri(),
  fromTabBar?: (anchor: string) => string[] | undefined,
): Promise<string[]> {
  if (!anchor) {
    return [];
  }
  const reported = fromTabBar?.(anchor.toString());
  if (reported && reported.length > 0) {
    return reported;
  }
  let copied = '';
  const saved = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand('copyFilePath', anchor);
    copied = await vscode.env.clipboard.readText();
  } catch {
    // Command unavailable: treat as single selection.
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
  const matched = matchCopiedPaths(copied, allTabs().map(tabUri));
  return matched.length > 0 ? matched : [anchor.toString()];
}

/** Maps copied path lines back to the URIs of open tabs (exported for tests). */
export function matchCopiedPaths(copied: string, openTabUris: vscode.Uri[]): string[] {
  const norm = (p: string) => {
    const unified = p.trim().replace(/[\\/]+/g, '/');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
  };
  const byPath = new Map<string, string>();
  for (const uri of openTabUris) {
    if (uri.scheme === 'file') {
      byPath.set(norm(uri.fsPath), uri.toString());
    }
  }
  const result: string[] = [];
  for (const line of copied.split(/\r?\n/)) {
    const uri = line.trim() ? byPath.get(norm(line)) : undefined;
    if (uri && !result.includes(uri)) {
      result.push(uri);
    }
  }
  return result;
}

/**
 * Tracks the tabs this extension closes itself (Close group, Delete group), so the
 * tab-close listener can tell them apart from tabs the user closed. A tab the user
 * closes leaves its group; a tab closed by "Close group" stays in it.
 */
export class CloseGuard {
  private readonly expected = new Set<string>();

  /** True (once) when this close was ours; later closes of the same file count as the user's. */
  consume(uri: string): boolean {
    return this.expected.delete(uri);
  }

  async closeTabsFor(uris: Iterable<string>): Promise<boolean> {
    const wanted = new Set(uris);
    const tabs = allTabs().filter((t) => wanted.has(tabUri(t).toString()));
    if (tabs.length === 0) {
      return true;
    }
    wanted.forEach((u) => this.expected.add(u));
    try {
      return await vscode.window.tabGroups.close(tabs);
    } finally {
      // Tab-change events can arrive slightly after close() resolves.
      setTimeout(() => wanted.forEach((u) => this.expected.delete(u)), 1000);
    }
  }
}

/** Opens files as pinned (non-preview) tabs. Returns the URIs that failed to open. */
export async function openFiles(uris: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const [i, u] of uris.entries()) {
    try {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(u), {
        preview: false,
        preserveFocus: i < uris.length - 1,
      });
    } catch {
      failed.push(u);
    }
  }
  return failed;
}
