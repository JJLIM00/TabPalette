/*
 * End-to-end tests: run inside a real VS Code window with the `test-fixtures` folder open
 * (a.txt, b.txt, c.txt, d.txt). Every test starts with those four tabs open, in that order.
 *
 * Tabs are referred to by file name, and the tab bar is checked as a list of names,
 * e.g. assert.deepStrictEqual(tabBar(), ['a.txt', 'd.txt', 'b.txt', 'c.txt']).
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { WebSocket } from 'ws';
import { BRIDGE_LABEL_PREFIX, WORKBENCH_ORIGIN } from '../bridge';
import type { TabGroupsApi } from '../extension';
import { GroupColor, TabGroup } from '../model';
import { matchCopiedPaths, openUris, selectedTabUris, tabUri } from '../tabs';

// ---------------------------------------------------------------- helpers

const workspaceRoot = () => vscode.workspace.workspaceFolders![0].uri;
const fileUri = (name: string) => vscode.Uri.joinPath(workspaceRoot(), name);
const id = (name: string) => fileUri(name).toString();
const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

let api: TabGroupsApi;

/** Opens a file as a normal (pinned) tab and makes it active. */
async function open(name: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', fileUri(name), { preview: false });
  await waitFor(`${name} is the active tab`, () => activeTab() === name);
}

/** File names of the tabs in the active tab row, left to right. */
function tabBar(): string[] {
  return vscode.window.tabGroups.activeTabGroup.tabs.map((t) => nameOf(tabUri(t)?.toString() ?? '?'));
}

function activeTab(): string | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab ? nameOf(tabUri(tab)?.toString() ?? '?') : undefined;
}

const isOpen = (name: string) => openUris().has(id(name));

/** Creates a group directly in the store (the tabs are not moved). */
function makeGroup(name: string, color: GroupColor, files: string[]): TabGroup {
  return api.store.create(name, color, files.map(id));
}

const group = (g: TabGroup) => api.store.get(g.id);
const members = (g: TabGroup) => group(g)?.uris.map(nameOf);
const groupNameOf = (file: string) => api.store.groupOf(id(file))?.name;
const groupByName = (name: string) => api.store.all().find((g) => g.name === name);

/** Drags the active tab to a 1-based position in its row, like a mouse drag in the tab bar. */
async function dragActiveTabTo(position: number): Promise<void> {
  const name = activeTab();
  await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position });
  await waitFor(`${name} is at position ${position}`, () => tabBar()[position - 1] === name);
}

function run(command: string, ...args: unknown[]): Thenable<unknown> {
  return vscode.commands.executeCommand(command, ...args);
}

async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error(`Timed out waiting until ${what}`);
    }
    await settle(10);
  }
}

/**
 * Answers VS Code's prompts the way a user would: the text typed into an input box,
 * and the label of the item picked from a quick pick (matched without codicons, e.g. "New group").
 */
const prompts = {
  typed: undefined as string | undefined,
  picks: [] as string[],
  shownPicks: [] as string[][],
};
const original = { showInputBox: vscode.window.showInputBox, showQuickPick: vscode.window.showQuickPick };
function answerPrompts(answers: { type?: string; pick?: string[] }): void {
  prompts.typed = answers.type;
  prompts.picks = [...(answers.pick ?? [])];
  prompts.shownPicks = [];
  const w = vscode.window as { -readonly [K in keyof typeof vscode.window]: (typeof vscode.window)[K] };
  w.showInputBox = (async () => prompts.typed) as typeof vscode.window.showInputBox;
  w.showQuickPick = (async (items: readonly (string | vscode.QuickPickItem)[] | Thenable<readonly (string | vscode.QuickPickItem)[]>) => {
    const list = await items;
    const label = (i: string | vscode.QuickPickItem) => (typeof i === 'string' ? i : i.label).replace(/\$\([^)]*\)\s*/g, '');
    prompts.shownPicks.push(list.filter((i) => typeof i === 'string' || i.kind !== vscode.QuickPickItemKind.Separator).map(label));
    const want = prompts.picks.shift();
    return list.find((i) => label(i) === want);
  }) as typeof vscode.window.showQuickPick;
}
function restorePrompts(): void {
  const w = vscode.window as { -readonly [K in keyof typeof vscode.window]: (typeof vscode.window)[K] };
  w.showInputBox = original.showInputBox;
  w.showQuickPick = original.showQuickPick;
}

// ---------------------------------------------------------------- tests

suite('TabPalette in a real VS Code window', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'tabpalette');
    assert.ok(ext, 'the extension is installed');
    api = (await ext.activate()) as TabGroupsApi;
  });

  setup(async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      await open(name);
    }
    answerPrompts({});
  });

  teardown(async () => {
    restorePrompts();
    await run('workbench.action.closeAllEditors');
    await waitFor('all tabs are closed', () => openUris().size === 0);
    for (const g of [...api.store.all()]) {
      api.store.remove(g.id);
    }
  });

  test('all commands are registered', async () => {
    const pkg = vscode.extensions.all.find((e) => e.packageJSON.name === 'tabpalette')!.packageJSON;
    const declared: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    const registered = await vscode.commands.getCommands(true);
    assert.deepStrictEqual(declared.filter((c) => !registered.includes(c)), [], 'declared in package.json but not registered');
  });

  suite('creating groups and adding tabs', () => {
    test('"Add Tab to New Group" makes a group with the typed name and the next free color', async () => {
      answerPrompts({ type: 'Docs' });
      await run('tabPalette.addToNewGroup', fileUri('b.txt'));
      assert.strictEqual(groupNameOf('b.txt'), 'Docs');
      assert.strictEqual(groupByName('Docs')!.color, 'color1');
    });

    test('a group may stay unnamed (Esc on the name prompt)', async () => {
      answerPrompts({ type: undefined });
      await run('tabPalette.addToNewGroup', fileUri('b.txt'));
      assert.strictEqual(groupNameOf('b.txt'), '');
    });

    test('"Add Tab to Group…" with no groups yet goes straight to making a new group', async () => {
      answerPrompts({ type: 'Main' });
      await run('tabPalette.addToGroup', fileUri('a.txt'));
      assert.strictEqual(groupNameOf('a.txt'), 'Main');
      assert.strictEqual(prompts.shownPicks.length, 0, 'no group list was shown');
    });

    test('"Add Tab to Group…" lists New group and the open groups; picking one adds the tab next to that group', async () => {
      const main = makeGroup('Main', 'color2', ['a.txt']);
      answerPrompts({ pick: ['Main'] });
      await run('tabPalette.addToGroup', fileUri('d.txt'));
      await settle();
      assert.deepStrictEqual(prompts.shownPicks[0], ['New group', 'Main']);
      assert.deepStrictEqual(members(main), ['a.txt', 'd.txt']);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'd.txt', 'b.txt', 'c.txt'], 'd moved next to its group');
    });

    test('several selected files go into one new group, side by side', async () => {
      answerPrompts({ type: 'Pair' });
      await run('tabPalette.addToNewGroup', fileUri('a.txt'), [fileUri('a.txt'), fileUri('c.txt')]);
      await settle();
      assert.deepStrictEqual(members(groupByName('Pair')!), ['a.txt', 'c.txt']);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'c.txt', 'b.txt', 'd.txt']);
    });

    test('several selected tabs next to each other, added to an existing group, all move next to the group (no split-off piece)', async () => {
      const main = makeGroup('Main', 'color2', ['a.txt']);
      answerPrompts({ pick: ['Main'] });
      await run('tabPalette.addToGroup', fileUri('c.txt'), [fileUri('c.txt'), fileUri('d.txt')]);
      await settle();
      assert.deepStrictEqual(members(main), ['a.txt', 'c.txt', 'd.txt']);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
    });

    test('adding a tab to another group moves it out of its old group (one group per tab)', async () => {
      const main = makeGroup('Main', 'color2', ['a.txt', 'b.txt']);
      const work = makeGroup('Work', 'color3', ['d.txt']);
      answerPrompts({ pick: ['Work'] });
      await run('tabPalette.moveToGroup', fileUri('b.txt'));
      assert.deepStrictEqual(members(main), ['a.txt']);
      assert.deepStrictEqual(members(work), ['d.txt', 'b.txt']);
    });

    test('"Add Selected Tabs" with a single selected tab uses that tab and leaves the clipboard alone', async () => {
      await vscode.env.clipboard.writeText('user clipboard');
      await open('c.txt');
      assert.deepStrictEqual((await selectedTabUris()).map(nameOf), ['c.txt']);
      assert.strictEqual(await vscode.env.clipboard.readText(), 'user clipboard');
    });

    test('copied tab paths are matched back to open tabs (how multi-selection is read)', () => {
      const [a, b] = [fileUri('a.txt'), fileUri('b.txt')];
      const otherCase = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toUpperCase() : p);
      const copied = [b.fsPath, otherCase(a.fsPath), 'not a tab'].join('\n');
      assert.deepStrictEqual(matchCopiedPaths(copied, [a, b]).map(nameOf), ['b.txt', 'a.txt']);
    });
  });

  suite('dragging tabs in the tab bar', () => {
    test('dropping a tab between two tabs of a group adds it to the group', async () => {
      makeGroup('Main', 'color2', ['a.txt', 'b.txt']);
      await open('d.txt');
      await dragActiveTabTo(2);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'd.txt', 'b.txt', 'c.txt']);
      assert.strictEqual(groupNameOf('d.txt'), 'Main');
    });

    test('dragging a tab away from its group removes it from the group', async () => {
      const main = makeGroup('Main', 'color2', ['a.txt', 'b.txt', 'c.txt']);
      await open('b.txt');
      await dragActiveTabTo(4);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
      assert.strictEqual(groupNameOf('b.txt'), undefined);
      assert.deepStrictEqual(members(main), ['a.txt', 'c.txt']);
    });

    test('moving a tab around inside its group keeps it in the group', async () => {
      makeGroup('Main', 'color2', ['a.txt', 'b.txt', 'c.txt']);
      await open('c.txt');
      await dragActiveTabTo(1);
      assert.deepStrictEqual(tabBar(), ['c.txt', 'a.txt', 'b.txt', 'd.txt']);
      assert.strictEqual(groupNameOf('c.txt'), 'Main');
    });

    test('the only tab of a group keeps its group wherever it is dragged', async () => {
      makeGroup('Solo', 'color5', ['b.txt']);
      await open('b.txt');
      await dragActiveTabTo(4);
      assert.strictEqual(groupNameOf('b.txt'), 'Solo');
    });

    test('dragging the last tab of a group into another group deletes the emptied group', async () => {
      const solo = makeGroup('Solo', 'color5', ['a.txt']);
      makeGroup('Main', 'color2', ['c.txt', 'd.txt']);
      await open('a.txt');
      await dragActiveTabTo(3); // b c a d: between c and d
      assert.deepStrictEqual(tabBar(), ['b.txt', 'c.txt', 'a.txt', 'd.txt']);
      assert.strictEqual(groupNameOf('a.txt'), 'Main');
      assert.strictEqual(group(solo), undefined, 'Solo had no tabs left');
    });

    test('dragging one of several tabs into another group keeps the old group', async () => {
      const main = makeGroup('Main', 'color1', ['a.txt', 'b.txt']);
      makeGroup('Work', 'color2', ['c.txt', 'd.txt']);
      await open('b.txt');
      await dragActiveTabTo(3); // a c b d: between c and d
      assert.strictEqual(groupNameOf('b.txt'), 'Work');
      assert.deepStrictEqual(members(main), ['a.txt']);
    });

    test('a file opened from inside a group opens in the group', async () => {
      makeGroup('Main', 'color2', ['a.txt', 'b.txt']);
      await open('d.txt');
      await run('workbench.action.closeActiveEditor');
      await open('a.txt');
      await open('d.txt'); // VS Code opens it right after the active tab: between a and b
      assert.deepStrictEqual(tabBar(), ['a.txt', 'd.txt', 'b.txt', 'c.txt']);
      assert.strictEqual(groupNameOf('d.txt'), 'Main');
    });
  });

  suite('removing and closing tabs', () => {
    test('a tab removed from the middle of a group moves just past it, so the group stays in one piece', async () => {
      const main = makeGroup('Main', 'color1', ['a.txt', 'b.txt', 'c.txt']);
      await run('tabPalette.removeFromGroup', fileUri('b.txt'));
      await settle();
      assert.deepStrictEqual(tabBar(), ['a.txt', 'c.txt', 'b.txt', 'd.txt']);
      assert.deepStrictEqual(members(main), ['a.txt', 'c.txt']);
    });

    test('removing the last tab of a group removes the group', async () => {
      const g = makeGroup('Main', 'color3', ['b.txt']);
      await open('b.txt');
      await run('tabPalette.removeFromGroup');
      assert.strictEqual(groupNameOf('b.txt'), undefined);
      assert.strictEqual(group(g), undefined);
    });

    test('closing a tab takes it out of its group; closing the last one removes the group', async () => {
      const g = makeGroup('Main', 'color6', ['a.txt', 'b.txt']);
      await open('a.txt');
      await run('workbench.action.closeActiveEditor');
      await settle();
      assert.deepStrictEqual(members(g), ['b.txt']);
      await open('b.txt');
      await run('workbench.action.closeActiveEditor');
      await settle();
      assert.strictEqual(group(g), undefined);
    });

    test('a tab right-click acts on the clicked tab, not on the active tab', async () => {
      const groupA = makeGroup('A', 'color5', ['a.txt']);
      const groupD = makeGroup('D', 'color6', ['d.txt']);
      await open('d.txt');
      await run('tabPalette.ungroup', fileUri('a.txt'), { groupId: 1 });
      assert.strictEqual(group(groupA), undefined);
      assert.ok(group(groupD));
    });
  });

  suite('group actions', () => {
    test('collapsing hides the group (its tabs stay open) and switches to a tab outside it; expanding shows it again', async () => {
      const g = makeGroup('Main', 'color3', ['a.txt', 'b.txt']);
      await open('b.txt');
      await run('tabPalette.toggleCollapse', g.id);
      await settle();
      assert.strictEqual(group(g)!.collapsed, true);
      assert.ok(!['a.txt', 'b.txt'].includes(activeTab()!), 'the active tab moved out of the collapsed group');
      assert.ok(isOpen('a.txt') && isOpen('b.txt'), 'collapsed tabs are only hidden, not closed');

      await run('tabPalette.toggleCollapse', g.id);
      assert.strictEqual(group(g)!.collapsed, false);
    });

    test('opening a hidden tab (Quick Open, Explorer…) expands its collapsed group', async () => {
      const g = makeGroup('Main', 'color3', ['a.txt', 'b.txt']);
      await run('tabPalette.toggleCollapse', g.id);
      await settle();
      await open('a.txt');
      await waitFor('the group is expanded', () => !group(g)!.collapsed);
    });

    test('"Close group" closes its tabs but keeps the group; reopening brings the tabs back', async () => {
      const g = makeGroup('Main', 'color8', ['a.txt', 'b.txt']);
      await run('tabPalette.closeGroup', g.id);
      await waitFor('the tabs are closed', () => !isOpen('a.txt') && !isOpen('b.txt'));
      assert.strictEqual(group(g)!.closed, true);
      assert.deepStrictEqual(members(g), ['a.txt', 'b.txt']);

      await run('tabPalette.openGroup', g.id);
      await waitFor('the tabs are open again', () => isOpen('a.txt') && isOpen('b.txt'));
      assert.strictEqual(group(g)!.closed, false);
    });

    test('"Show Tab Groups" lists closed groups, and picking one reopens it', async () => {
      const g = makeGroup('Later', 'color4', ['c.txt']);
      await run('tabPalette.closeGroup', g.id);
      await waitFor('the tab is closed', () => !isOpen('c.txt'));
      answerPrompts({ pick: ['Later'] });
      await run('tabPalette.showMenu');
      await waitFor('the group is reopened', () => isOpen('c.txt') && !group(g)!.closed);
    });

    test('"Ungroup" keeps the tabs open; "Delete group" closes them', async () => {
      const one = makeGroup('One', 'color1', ['a.txt']);
      await run('tabPalette.ungroup', one.id);
      assert.strictEqual(group(one), undefined);
      assert.ok(isOpen('a.txt'));

      const two = makeGroup('Two', 'color1', ['b.txt']);
      await run('tabPalette.deleteGroup', two.id);
      await waitFor('the tab is closed', () => !isOpen('b.txt'));
      assert.strictEqual(group(two), undefined);
    });

    test('rename and color can be changed from the Command Palette', async () => {
      const g = makeGroup('Main', 'color1', ['a.txt']);
      answerPrompts({ type: 'Renamed' });
      await run('tabPalette.renameGroup', g.id);
      answerPrompts({ pick: ['Color 7'] });
      await run('tabPalette.changeColor', g.id);
      assert.strictEqual(group(g)!.name, 'Renamed');
      assert.strictEqual(group(g)!.color, 'color7');
    });

    test('"Edit Group…" asks for a name, then a color', async () => {
      const g = makeGroup('Main', 'color1', ['a.txt']);
      answerPrompts({ type: 'Edited', pick: ['Color 5'] });
      await run('tabPalette.editGroup', g.id);
      assert.strictEqual(group(g)!.name, 'Edited');
      assert.strictEqual(group(g)!.color, 'color5');
    });

    test('"New tab in group" opens the picked file inside the group', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt']);
      await open('d.txt');
      await run('workbench.action.closeActiveEditor');
      answerPrompts({ pick: ['d.txt'] });
      await run('tabPalette.newTabInGroup', g.id);
      await settle();
      assert.deepStrictEqual(members(g), ['a.txt', 'd.txt']);
      assert.deepStrictEqual(tabBar().slice(0, 2), ['a.txt', 'd.txt']);
    });

    test('dragging a group chip moves the whole group, so groups can swap places', async () => {
      const main = makeGroup('Main', 'color1', ['a.txt', 'b.txt']);
      const work = makeGroup('Work', 'color2', ['c.txt', 'd.txt']);
      const row = vscode.window.tabGroups.all.indexOf(vscode.window.tabGroups.activeTabGroup);

      await api.layout.moveGroupTo(work.id, row, 0); // drop Work before the first tab
      await settle();
      assert.deepStrictEqual(tabBar(), ['c.txt', 'd.txt', 'a.txt', 'b.txt']);
      assert.deepStrictEqual(members(main), ['a.txt', 'b.txt'], 'moving a group does not change who is in it');
      assert.deepStrictEqual(members(work), ['c.txt', 'd.txt']);

      await api.layout.moveGroupTo(work.id, row, 4); // and back to the end
      await settle();
      assert.deepStrictEqual(tabBar(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    });
  });

  suite('renaming and deleting files', () => {
    const tempName = 'temp-tab-groups-test.txt';
    const renamedName = 'temp-tab-groups-renamed.txt';

    teardown(async () => {
      for (const name of [tempName, renamedName]) {
        await vscode.workspace.fs.delete(fileUri(name)).then(undefined, () => undefined);
      }
    });

    test('a renamed file stays in its group under its new name', async () => {
      await vscode.workspace.fs.writeFile(fileUri(tempName), Buffer.from('temp'));
      const g = makeGroup('Main', 'color2', ['a.txt', tempName]);
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(fileUri(tempName), fileUri(renamedName));
      assert.ok(await vscode.workspace.applyEdit(edit));
      await waitFor('the group follows the rename', () => members(g)?.includes(renamedName) ?? false);
      assert.deepStrictEqual(members(g), ['a.txt', renamedName]);
    });

    test('a deleted file leaves its group', async () => {
      await vscode.workspace.fs.writeFile(fileUri(tempName), Buffer.from('temp'));
      const g = makeGroup('Main', 'color2', ['a.txt', tempName]);
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(fileUri(tempName));
      assert.ok(await vscode.workspace.applyEdit(edit));
      await waitFor('the file leaves the group', () => members(g)?.length === 1);
      assert.deepStrictEqual(members(g), ['a.txt']);
    });
  });

  // Runs last: once the tab bar UI is connected, new groups open the chip editor instead of a prompt.
  suite('connection to the tab bar UI (the patched workbench)', () => {
    type Message = { type: string; [key: string]: unknown };
    type State = { groups: { id: string; name: string; color: string; collapsed: boolean }[]; rows: { tabs: { label: string; group: string | null }[] }[] };
    let port: number;
    let token: string;
    let ui: WebSocket | undefined;

    suiteSetup(async () => {
      const bridge = await api.startBridge();
      port = bridge.port!;
      token = bridge.token;
    });

    teardown(() => {
      ui?.close();
      ui = undefined;
    });

    function connect(origin = WORKBENCH_ORIGIN): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', () => reject(new Error('connection refused')));
      });
    }

    function nextMessage(ws: WebSocket, type: string): Promise<Message> {
      return new Promise((resolve) => {
        const onMessage = (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as Message;
          if (msg.type === type) {
            ws.off('message', onMessage);
            resolve(msg);
          }
        };
        ws.on('message', onMessage);
      });
    }

    /** Connects like the patched tab bar does, and returns the first state it receives. */
    async function connectAsTabBar(): Promise<State> {
      ui = await connect();
      const first = nextMessage(ui, 'state');
      ui.send(JSON.stringify({ type: 'hello', token }));
      return (await first) as unknown as State;
    }

    /** Sends a chip / group editor action, as the tab bar does on a click. */
    function chipAction(action: string, groupId: string, value?: unknown): void {
      ui!.send(JSON.stringify({ type: 'action', action, groupId, value }));
    }

    test('listens on a random local port and publishes it with a secret token', () => {
      assert.ok(BRIDGE_LABEL_PREFIX.length > 0);
      assert.ok(port > 0);
      assert.strictEqual(token.length, 48);
    });

    test('refuses connections from any other web page', async () => {
      await assert.rejects(connect('https://evil.example'));
    });

    test('drops a client that sends the wrong token', async () => {
      const ws = await connect();
      const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
      ws.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(48) }));
      assert.strictEqual(await closed, 1008, 'closed as a policy violation');
    });

    test('tells the tab bar which group each tab is in', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt', 'b.txt']);
      const state = await connectAsTabBar();
      assert.deepStrictEqual(state.groups, [{ id: g.id, name: 'Main', color: 'color2', collapsed: false }]);
      const row = state.rows.find((r) => r.tabs.some((t) => t.label === 'a.txt'))!;
      assert.deepStrictEqual(
        row.tabs.map((t) => [t.label, t.group && 'Main']),
        [['a.txt', 'Main'], ['b.txt', 'Main'], ['c.txt', null], ['d.txt', null]],
      );
    });

    test('sends a fresh state when a group changes', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt']);
      await connectAsTabBar();
      const update = nextMessage(ui!, 'state');
      api.store.rename(g.id, 'Work');
      assert.strictEqual(((await update) as unknown as State).groups[0].name, 'Work');
    });

    test('closed groups are not drawn on the tab bar', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt']);
      await run('tabPalette.closeGroup', g.id);
      await waitFor('the group is closed', () => group(g)!.closed);
      const state = await connectAsTabBar();
      assert.deepStrictEqual(state.groups, []);
    });

    test('the group editor renames and recolors; unknown colors are ignored', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt']);
      await connectAsTabBar();
      chipAction('rename', g.id, 'Work');
      chipAction('setColor', g.id, 'color9');
      await waitFor('rename and color are applied', () => group(g)!.name === 'Work' && group(g)!.color === 'color9');
      chipAction('setColor', g.id, 'not-a-color');
      await settle();
      assert.strictEqual(group(g)!.color, 'color9');
    });

    test('clicking a chip collapses the group; clicking again expands it', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt', 'b.txt']);
      await connectAsTabBar();
      chipAction('toggleCollapse', g.id);
      await waitFor('the group is collapsed', () => group(g)!.collapsed);
      chipAction('toggleCollapse', g.id);
      await waitFor('the group is expanded', () => !group(g)!.collapsed);
    });

    test('a tab dropped onto a group of one tab joins it (the tab bar reports the drop after the move)', async () => {
      const solo = makeGroup('Solo', 'color5', ['b.txt']);
      await connectAsTabBar();
      await open('d.txt');
      await dragActiveTabTo(3); // a b d c: d right after the group's only tab
      chipAction('joinOnDrop', solo.id, { row: 0, labels: ['d.txt'] });
      await waitFor('d.txt joined Solo', () => groupNameOf('d.txt') === 'Solo');
      assert.deepStrictEqual(members(solo), ['b.txt', 'd.txt']);
    });

    test('the drop report may arrive before VS Code moves the tab; it still joins, at the start of the group', async () => {
      const solo = makeGroup('Solo', 'color5', ['c.txt']);
      await connectAsTabBar();
      await open('a.txt');
      chipAction('joinOnDrop', solo.id, { row: 0, labels: ['a.txt'] });
      await dragActiveTabTo(2); // b a c d: a right in front of the group's only tab
      await waitFor('a.txt joined Solo', () => groupNameOf('a.txt') === 'Solo');
      assert.deepStrictEqual(members(solo), ['a.txt', 'c.txt']);
    });

    test('a drop report for a tab that never lands next to the group is ignored', async () => {
      const solo = makeGroup('Solo', 'color5', ['d.txt']);
      await connectAsTabBar();
      chipAction('joinOnDrop', solo.id, { row: 'first', labels: ['c.txt'] });
      // The extension waits a little for VS Code to move the tab, then gives up.
      assert.strictEqual(await api.layout.joinDroppedTabs(solo.id, 0, ['a.txt'], 200), 0);
      assert.strictEqual(groupNameOf('a.txt'), undefined);
      assert.deepStrictEqual(members(solo), ['d.txt'], 'c.txt is next to the group, but the report was malformed');
    });

    test("a group's last tab dropped outside the group leaves it, even though the tab order did not change", async () => {
      const main = makeGroup('Main', 'color2', ['c.txt', 'd.txt']);
      await connectAsTabBar();
      chipAction('leaveOnDrop', main.id, { row: 0, labels: ['d.txt'] });
      await waitFor('d.txt left Main', () => groupNameOf('d.txt') === undefined);
      assert.deepStrictEqual(members(main), ['c.txt']);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    });

    test("a group's only tab dropped outside the group keeps its group", async () => {
      const solo = makeGroup('Solo', 'color5', ['d.txt']);
      assert.strictEqual(await api.layout.leaveDroppedTabs(solo.id, 0, ['d.txt'], 0), 0, 'no tab leaves');
      assert.deepStrictEqual(members(solo), ['d.txt']);
    });

    test('several selected tabs dropped onto a group all join it', async () => {
      const solo = makeGroup('Solo', 'color5', ['b.txt']);
      await connectAsTabBar();
      chipAction('joinOnDrop', solo.id, { row: 0, labels: ['c.txt', 'd.txt'] }); // a b c d: c and d right after the group
      await waitFor('c.txt and d.txt joined Solo', () => groupNameOf('c.txt') === 'Solo' && groupNameOf('d.txt') === 'Solo');
      assert.deepStrictEqual(members(solo), ['b.txt', 'c.txt', 'd.txt']);
    });

    test('several selected tabs dropped outside their group all leave it', async () => {
      const main = makeGroup('Main', 'color2', ['a.txt', 'b.txt', 'c.txt']);
      await connectAsTabBar();
      chipAction('leaveOnDrop', main.id, { row: 0, labels: ['b.txt', 'c.txt'] });
      await waitFor('b.txt and c.txt left Main', () => groupNameOf('b.txt') === undefined && groupNameOf('c.txt') === undefined);
      assert.deepStrictEqual(members(main), ['a.txt']);
    });

    test('right-click on a selected tab: the tab bar reports the selection, and "Add Selected Tabs" uses all of it', async () => {
      await connectAsTabBar();
      ui!.send(JSON.stringify({ type: 'selection', row: 0, indexes: [1, 3] })); // b.txt and d.txt are selected
      await settle(100);
      await run('tabPalette.addSelectedToNewGroup', fileUri('d.txt'));
      await waitFor('b.txt is grouped', () => !!api.store.groupOf(id('b.txt')));
      const g = api.store.groupOf(id('b.txt'))!;
      assert.deepStrictEqual(g.uris.map(nameOf), ['b.txt', 'd.txt']);
    });

    test('right-click on a tab outside the reported selection: only that tab is used', async () => {
      await connectAsTabBar();
      ui!.send(JSON.stringify({ type: 'selection', row: 0, indexes: [0, 1] })); // a.txt and b.txt are selected
      await settle(100);
      await run('tabPalette.addSelectedToNewGroup', fileUri('d.txt'));
      await waitFor('d.txt is grouped', () => !!api.store.groupOf(id('d.txt')));
      assert.deepStrictEqual(api.store.groupOf(id('d.txt'))!.uris.map(nameOf), ['d.txt']);
    });

    test('dropping a dragged chip moves the group; a malformed drop is ignored', async () => {
      makeGroup('Main', 'color1', ['a.txt', 'b.txt']);
      const work = makeGroup('Work', 'color2', ['c.txt', 'd.txt']);
      await connectAsTabBar();
      chipAction('moveGroup', work.id, { row: 0, index: 'first' });
      await settle(300);
      assert.deepStrictEqual(tabBar(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
      chipAction('moveGroup', work.id, { row: 0, index: 0 });
      // The group's tabs move one at a time, so wait for the finished order, not just the first tab.
      await waitFor('Work has moved in front of Main', () => tabBar().join(' ') === 'c.txt d.txt a.txt b.txt');
    });

    test('the group editor menu: Close group, Ungroup and Delete group', async () => {
      const closing = makeGroup('Closing', 'color1', ['a.txt']);
      const ungrouping = makeGroup('Ungrouping', 'color2', ['b.txt']);
      const deleting = makeGroup('Deleting', 'color3', ['c.txt']);
      await connectAsTabBar();
      chipAction('close', closing.id);
      chipAction('ungroup', ungrouping.id);
      chipAction('delete', deleting.id);
      await waitFor('all three actions are done', () => group(closing)?.closed === true && !group(ungrouping) && !group(deleting) && !isOpen('c.txt'));
      assert.ok(!isOpen('a.txt'), 'Close group closed its tab');
      assert.ok(isOpen('b.txt'), 'Ungroup kept its tab open');
    });

    test('a new group opens the group editor on its chip (like Chrome) instead of a name prompt', async () => {
      await connectAsTabBar();
      const edit = nextMessage(ui!, 'edit');
      answerPrompts({ type: 'should not be asked' });
      await run('tabPalette.addToNewGroup', fileUri('a.txt'));
      const message = await edit;
      assert.strictEqual(message.groupId, api.store.groupOf(id('a.txt'))!.id);
      assert.strictEqual(groupNameOf('a.txt'), '', 'the name is typed in the chip editor, not in a prompt');
    });

    test('"Edit Group…" opens the chip editor when the tab bar is connected', async () => {
      const g = makeGroup('Main', 'color2', ['a.txt']);
      await connectAsTabBar();
      const edit = nextMessage(ui!, 'edit');
      await run('tabPalette.editGroup', g.id);
      assert.strictEqual((await edit).groupId, g.id);
    });
  });
});
