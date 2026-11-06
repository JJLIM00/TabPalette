import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { registerCommands } from './commands';
import { registerContextKeys } from './contextKeys';
import { Layout } from './layout';
import { MembershipTracker } from './membership';
import { registerPatchCommands } from './patchCommands';
import { GroupStore } from './store';
import { registerFileSync } from './tabSync';
import { CloseGuard } from './tabs';

/** Returned from activate() so the integration tests can reach the extension's state. */
export interface TabGroupsApi {
  store: GroupStore;
  layout: Layout;
  /** Starts the bridge to the tab bar UI (normally started when the patch is enabled). */
  startBridge: () => Promise<Bridge>;
}

export function activate(context: vscode.ExtensionContext): TabGroupsApi {
  const store = new GroupStore(context.workspaceState);
  const guard = new CloseGuard();
  const tracker = new MembershipTracker(store, guard);
  const layout = new Layout(store, tracker, guard);

  let bridge: Bridge | undefined;
  const handleUiAction = registerCommands(context, { store, guard, layout, bridge: () => bridge });
  const startBridge = async () => {
    if (!bridge) {
      bridge = new Bridge(store, handleUiAction);
      await bridge.start();
    }
    return bridge;
  };
  const stopBridge = () => {
    bridge?.dispose();
    bridge = undefined;
  };

  context.subscriptions.push(store, tracker, registerFileSync(store), registerContextKeys(store), { dispose: stopBridge });
  registerPatchCommands(context, {
    onEnabled: async () => {
      await startBridge();
    },
    onDisabled: stopBridge,
  });

  return { store, layout, startBridge };
}

export function deactivate(): void {}
