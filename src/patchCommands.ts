import * as fs from 'fs';
import * as vscode from 'vscode';
import { applyPatch, findWorkbenchHtml, isPermissionError, patchStatus, removePatch } from './patch';

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
        `TabPalette: couldn't find VS Code's workbench.html under ${vscode.env.appRoot}. This VS Code build isn't supported.`,
      );
    }
    return found;
  };

  const promptReload = async (message: string) => {
    if (await vscode.window.showInformationMessage(message, 'Reload Window')) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  const reportWriteError = (err: unknown) => {
    const detail = isPermissionError(err)
      ? 'VS Code is installed in a folder you cannot write to. Run VS Code as administrator once, run the command again, then restart normally.'
      : String(err);
    void vscode.window.showErrorMessage(`TabPalette: could not change VS Code's files. ${detail}`);
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
      'Enable Chrome-style tab groups in the tab bar?',
      {
        modal: true,
        detail:
          "TabPalette draws group chips and colored group lines on VS Code's tab bar. VS Code has no API for that, so this adds a small script to VS Code's installation (workbench.html).\n\n" +
          '• VS Code may then say "Your Code installation appears to be corrupt". This is expected; choose "Don\'t Show Again".\n' +
          '• VS Code updates replace the file; the extension offers to re-apply it.\n' +
          '• Run "Tab Groups: Disable Chrome-style Tab Groups" to undo it completely.',
      },
      'Enable',
    );
    if (ok && (await install())) {
      await promptReload('TabPalette: enabled. Reload the window to see group chips in the tab bar.');
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
      await promptReload("TabPalette: tab bar patch removed and VS Code's files restored. Reload the window to apply.");
    }),
  );

  void checkOnStartup();

  async function checkOnStartup(): Promise<void> {
    if (!isPatchEnabled(ctx)) {
      if (!ctx.globalState.get<boolean>(DONT_ASK_KEY) && ctx.extensionMode !== vscode.ExtensionMode.Test) {
        const choice = await vscode.window.showInformationMessage(
          'TabPalette shows Chrome-style group chips in the tab bar after a one-time patch of VS Code. Enable it?',
          'Enable…',
          "Don't Ask Again",
        );
        if (choice === 'Enable…') {
          await enableWithConfirm();
        } else if (choice === "Don't Ask Again") {
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
        await promptReload('TabPalette: tab bar script updated. Reload the window to apply.');
      }
    } else if (status === 'unpatched') {
      const choice = await vscode.window.showInformationMessage(
        'TabPalette: a VS Code update removed the tab bar patch. Re-apply it?',
        'Re-apply',
        'Turn Off',
      );
      if (choice === 'Re-apply' && (await install())) {
        await promptReload('TabPalette: re-applied. Reload the window to apply.');
      } else if (choice === 'Turn Off') {
        await ctx.globalState.update(ENABLED_KEY, false);
        hooks.onDisabled();
      }
    }
  }
}
