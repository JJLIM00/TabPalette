import * as vscode from 'vscode';

/** The file a tab shows, or undefined for tabs that are not file-backed (settings, webviews, terminals…). */
export function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
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
  return undefined;
}

export function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs);
}

/** URI strings of every file currently open in a tab. */
export function openUris(): Set<string> {
  const set = new Set<string>();
  for (const tab of allTabs()) {
    const uri = tabUri(tab);
    if (uri) {
      set.add(uri.toString());
    }
  }
  return set;
}

export function activeTabUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab ? tabUri(tab) : undefined;
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
  const matched = matchCopiedPaths(copied, allTabs().map(tabUri).filter((u): u is vscode.Uri => !!u));
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
    const tabs = allTabs().filter((t) => {
      const uri = tabUri(t);
      return uri !== undefined && wanted.has(uri.toString());
    });
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
