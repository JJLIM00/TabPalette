import * as vscode from 'vscode';
import { Layout } from './layout';
import { order } from './membership';

/**
 * The side bar's tab menu, like the Open Editors view's: open, reveal, copy the path, save,
 * compare and close. A menu item gets the tab's `data-vscode-context` (row, index, key) instead
 * of the URI that VS Code's own commands need, so each item is a small command here that finds
 * the tab and then does what VS Code's item does.
 */
export function registerSidebarTabCommands(context: vscode.ExtensionContext, layout: Layout): void {
  /** The right-clicked tab, found again by its key (the page may be a little behind). */
  const tabOf = (arg: unknown): { row: vscode.TabGroup; tab: vscode.Tab; uri?: vscode.Uri } | undefined => {
    const a = arg as { row?: unknown; index?: unknown; key?: unknown; uri?: unknown } | undefined;
    if (!a || typeof a !== 'object' || typeof a.key !== 'string') {
      return undefined;
    }
    const rows = vscode.window.tabGroups.all;
    const preferred = Number.isInteger(a.row) ? rows[a.row as number] : undefined;
    for (const row of preferred ? [preferred, ...rows.filter((r) => r !== preferred)] : rows) {
      const keys = order(row);
      const index = Number.isInteger(a.index) && keys[a.index as number] === a.key ? (a.index as number) : keys.indexOf(a.key);
      if (index >= 0) {
        const uri = typeof a.uri === 'string' ? vscode.Uri.parse(a.uri) : undefined;
        return { row, tab: row.tabs[index], uri };
      }
    }
    return undefined;
  };

  /** Commands that only act on the active editor: make the tab active first. */
  const onActive = (command: string) => async (arg: unknown) => {
    const found = tabOf(arg);
    if (found) {
      await layout.showTab(found.row, found.tab);
      await vscode.commands.executeCommand(command);
    }
  };
  /** VS Code's file commands that take the file's URI. */
  const withUri = (command: string) => async (arg: unknown) => {
    const uri = tabOf(arg)?.uri;
    if (uri) {
      await vscode.commands.executeCommand(command, uri);
    }
  };
  /** Closes tabs of the right-clicked tab's row. Like VS Code, only Close closes a pinned tab. */
  const closeIn = (which: (tab: vscode.Tab, clicked: vscode.Tab) => boolean) => async (arg: unknown) => {
    const found = tabOf(arg);
    if (found) {
      await vscode.window.tabGroups.close(found.row.tabs.filter((t) => which(t, found.tab)));
    }
  };
  const revealInOS = withUri('revealFileInOS');

  const commands: Record<string, (arg: unknown) => Promise<void>> = {
    'tabPalette.tab.openToSide': async (arg) => {
      const uri = tabOf(arg)?.uri;
      if (uri) {
        await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      }
    },
    // Named after each system's file manager, as in VS Code.
    'tabPalette.tab.revealInExplorer': revealInOS,
    'tabPalette.tab.revealInFinder': revealInOS,
    'tabPalette.tab.openContainingFolder': revealInOS,
    'tabPalette.tab.copyPath': withUri('copyFilePath'),
    'tabPalette.tab.copyRelativePath': withUri('copyRelativeFilePath'),
    'tabPalette.tab.reopenWith': onActive('workbench.action.reopenWithEditor'),
    'tabPalette.tab.save': onActive('workbench.action.files.save'),
    'tabPalette.tab.revert': onActive('workbench.action.files.revert'),
    'tabPalette.tab.compareWithSaved': withUri('workbench.files.action.compareWithSaved'),
    'tabPalette.tab.compareWithSelected': withUri('compareFiles'),
    'tabPalette.tab.selectForCompare': withUri('selectForCompare'),
    'tabPalette.tab.close': closeIn((t, clicked) => t === clicked),
    'tabPalette.tab.closeOthers': closeIn((t, clicked) => t !== clicked && !t.isPinned),
    'tabPalette.tab.closeSaved': closeIn((t) => !t.isDirty && !t.isPinned),
    'tabPalette.tab.closeAll': closeIn((t) => !t.isPinned),
  };
  for (const [id, run] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, run));
  }
}
