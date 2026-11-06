import * as vscode from 'vscode';
import { GroupStore } from './store';

/** Keeps group members in step with file renames and deletes. */
export function registerFileSync(store: GroupStore): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.workspace.onDidRenameFiles((e) => {
      for (const f of e.files) {
        store.renameUri(f.oldUri.toString(), f.newUri.toString());
      }
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) {
        store.removeUriTree(uri.toString());
      }
      store.pruneEmpty();
    }),
  );
}
