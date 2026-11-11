import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { registerCommands } from './commands';
import { registerContextKeys } from './contextKeys';
import { Layout } from './layout';
import { MembershipTracker } from './membership';
import { registerPatchCommands } from './patchCommands';
import { GroupStore } from './store';
import { registerFileSync } from './fileSync';
import { SIDEBAR_VIEW_ID, SidebarProvider } from './sidebar';
import { CloseGuard } from './tabs';

/** Returned from activate() so the integration tests can reach the extension's state. */
export interface TabGroupsApi {
  store: GroupStore;
  layout: Layout;
  /** The Tab Groups view in the side bar. */
  sidebar: SidebarProvider;
  /** Starts the bridge to the tab bar UI (normally started when the patch is enabled). */
  startBridge: () => Promise<Bridge>;
}

export function activate(context: vscode.ExtensionContext): TabGroupsApi {
  const store = new GroupStore(context.workspaceState);
  const guard = new CloseGuard();
  const tracker = new MembershipTracker(store, guard);
  const layout = new Layout(store, tracker, guard);

  let bridge: Bridge | undefined;
  const handleUiAction = registerCommands(context, { store, guard, layout, bridge: () => bridge, editInSidebar: (id) => sidebar.editGroup(id) });
  const sidebar = new SidebarProvider(context.extensionUri, store, layout, handleUiAction, () => bridge);
  const startBridge = async () => {
    if (!bridge) {
      bridge = new Bridge(store, handleUiAction);
      // The side bar shows the tab bar's selection.
      bridge.onDidChangeSelection(() => sidebar.refresh());
      await bridge.start();
    }
    return bridge;
  };
  const stopBridge = () => {
    bridge?.dispose();
    bridge = undefined;
    sidebar.refresh();
  };

  context.subscriptions.push(store, tracker, registerFileSync(store), registerContextKeys(store), { dispose: stopBridge });
  context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar));

  registerPatchCommands(context, {
    onEnabled: async () => {
      await startBridge();
    },
    onDisabled: stopBridge,
  });

  return { store, layout, sidebar, startBridge };
}
