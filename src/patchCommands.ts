import * as fs from 'fs';
import * as vscode from 'vscode';
import { applyPatch, findWorkbenchHtml, isPermissionError, patchStatus, removePatch } from './patch';
import { t } from './text';

/** globalState flag: the user turned the tab bar patch on. */
const ENABLED_KEY = 'tabPalette.patchEnabled';
const DONT_ASK_KEY = 'tabPalette.dontOfferPatch';

export interface PatchHooks {
  /** The patch is (or stays) on: start talking to the tab bar UI. */
  onEnabled: () => Promise<void> | void;
  onDisabled: () => void;
}

function isPatchEnabled(ctx: vscode.ExtensionContext): boolean {
  return ctx.globalState.get<boolean>(ENABLED_KEY) === true;
}

export function registerPatchCommands(ctx: vscode.ExtensionContext, hooks: PatchHooks): void {
  const scriptSource = () =>
    fs.readFileSync(vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'patch', 'tab-groups-patch.js').fsPath, 'utf8');

  const htmlPath = (quiet = false) => {
    const found = findWorkbenchHtml(vscode.env.appRoot);
    if (!found && !quiet) {
      void vscode.window.showErrorMessage(
        t('patch.noWorkbench', vscode.env.appRoot),
      );
    }
    return found;
  };

  const promptReload = async (message: string) => {
    if (await vscode.window.showInformationMessage(message, t('patch.reloadWindow'))) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  const reportWriteError = (err: unknown) => {
    const detail = isPermissionError(err)
      ? t('patch.noWriteAccess')
      : String(err);
    void vscode.window.showErrorMessage(t('patch.writeFailed', detail));
  };

  const install = async (): Promise<boolean> => {
    const html = htmlPath();
    if (!html) {
      return false;
    }
    try {
      applyPatch(html, scriptSource());
    } catch (err) {
      reportWriteError(err);
      return false;
    }
    await ctx.globalState.update(ENABLED_KEY, true);
    await hooks.onEnabled();
    return true;
  };

  const enableWithConfirm = async () => {
    const ok = await vscode.window.showWarningMessage(
      t('patch.confirm'),
      {
        modal: true,
        detail: [
          t('patch.confirmWhy'),
          '',
          t('patch.confirmCorrupt'),
          t('patch.confirmUpdates'),
          t('patch.confirmUndo'),
        ].join('\n'),
      },
      t('patch.confirmEnable'),
    );
    if (ok && (await install())) {
      await promptReload(t('patch.enabled'));
    }
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('tabPalette.enablePatch', enableWithConfirm),
    vscode.commands.registerCommand('tabPalette.disablePatch', async () => {
      const html = htmlPath();
      if (!html) {
        return;
      }
      try {
        removePatch(html);
      } catch (err) {
        reportWriteError(err);
        return;
      }
      await ctx.globalState.update(ENABLED_KEY, false);
      hooks.onDisabled();
      await promptReload(t('patch.disabled'));
    }),
    // For when the tab bar doesn't show the latest changes: write the script again, then reload.
    vscode.commands.registerCommand('tabPalette.reloadPatch', async () => {
      if (!isPatchEnabled(ctx)) {
        return enableWithConfirm();
      }
      if (await install()) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );

  void checkOnStartup();

  async function checkOnStartup(): Promise<void> {
    if (!isPatchEnabled(ctx)) {
      if (!ctx.globalState.get<boolean>(DONT_ASK_KEY) && ctx.extensionMode !== vscode.ExtensionMode.Test) {
        const enable = t('patch.offerEnable');
        const dontAsk = t('patch.offerDontAsk');
        const choice = await vscode.window.showInformationMessage(
          t('patch.offer'),
          enable,
          dontAsk,
        );
        if (choice === enable) {
          await enableWithConfirm();
        } else if (choice === dontAsk) {
          await ctx.globalState.update(DONT_ASK_KEY, true);
        }
      }
      return;
    }
    await hooks.onEnabled();
    const html = htmlPath(true);
    if (!html) {
      return;
    }
    let status;
    try {
      status = patchStatus(html, scriptSource());
    } catch {
      return;
    }
    if (status === 'outdated') {
      if (await install()) {
        await promptReload(t('patch.updated'));
      }
    } else if (status === 'unpatched') {
      const reapply = t('patch.reapply');
      const turnOff = t('patch.turnOff');
      const choice = await vscode.window.showInformationMessage(
        t('patch.removedByUpdate'),
        reapply,
        turnOff,
      );
      if (choice === reapply && (await install())) {
        await promptReload(t('patch.reapplied'));
      } else if (choice === turnOff) {
        await ctx.globalState.update(ENABLED_KEY, false);
        hooks.onDisabled();
      }
    }
  }
}
