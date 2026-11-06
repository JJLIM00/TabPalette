import * as vscode from 'vscode';
import { GroupStore } from './store';

/**
 * `tabPalette.groupedUris`: every grouped file, for menu `when` clauses
 * (`resource in tabPalette.groupedUris` works because `resource` holds `Uri.toString()`).
 */
export function registerContextKeys(store: GroupStore): vscode.Disposable {
  let last: string | undefined;
  const update = () => {
    const grouped = store.all().flatMap((g) => g.uris);
    const key = grouped.join('\n');
    if (key !== last) {
      last = key;
      void vscode.commands.executeCommand('setContext', 'tabPalette.groupedUris', grouped);
    }
  };
  update();
  return store.onDidChange(update);
}
