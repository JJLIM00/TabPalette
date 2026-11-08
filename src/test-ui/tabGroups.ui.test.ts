/*
 * UI tests: every feature is used the way a person uses it — right-click menus, the group
 * editor, mouse drags, clicks on chips, keyboard shortcuts — in a real VS Code window, and
 * the result is checked on screen (chips, colors, group lines, hidden tabs, tab order).
 *
 * Run with `pnpm run test:ui`. Every test starts with four tabs open: a.txt b.txt c.txt d.txt.
 * When a test fails, a screenshot of the window is saved to out/ui-failures/.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { COLORS, VSCodeWindow } from './vscodeWindow';

const FAILURE_SHOTS = path.resolve(__dirname, '..', 'ui-failures');

suite('TabPalette — used like a person would', function () {
  this.timeout(60_000);
  let vscode: VSCodeWindow;

  suiteSetup(async function () {
    this.timeout(180_000);
    vscode = await VSCodeWindow.launch();
  });

  suiteTeardown(async () => {
    await vscode?.close();
  });

  teardown(async function () {
    if (this.currentTest?.state === 'failed') {
      fs.mkdirSync(FAILURE_SHOTS, { recursive: true });
      const name = this.currentTest.title.replace(/[^\w]+/g, '-').slice(0, 80);
      await vscode.page.screenshot({ path: path.join(FAILURE_SHOTS, `${name}.png`) }).catch(() => undefined);
    }
  });

  setup(async () => {
    await vscode.focus();
    await vscode.closeAllTabs();
    for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      await vscode.open(file);
    }
  });

  /** Makes a group through the UI: right-click the first tab → Add Tab to New Group, name it, then add the rest. */
  async function makeGroup(name: string, files: string[], color?: string): Promise<void> {
    await vscode.tabMenu(files[0], 'Add Tab to New Group');
    await vscode.waitUntil('the group editor opens', () => vscode.editorIsOpen());
    await vscode.type(name);
    if (color) {
      await vscode.pickColor(color);
    }
    await vscode.press('Escape');
    for (const file of files.slice(1)) {
      await addToGroup(file, name);
    }
  }

  /** Right-click a tab → Add Tab to Group… → pick the group. */
  async function addToGroup(file: string, group: string): Promise<void> {
    await vscode.tabMenu(file, 'Add Tab to Group…');
    await vscode.pickFromList(group);
    await vscode.waitUntil(`${file} is in ${group}`, async () => (await vscode.tab(file)).group === group);
  }

  const groupOf = async (file: string) => (await vscode.tab(file)).group;

  // ------------------------------------------------------------------ grouping

  suite('grouping tabs', () => {
    test('right-click a tab → "Add Tab to New Group" shows a chip with the typed name and a line under the tab', async () => {
      await vscode.tabMenu('b.txt', 'Add Tab to New Group');
      assert.ok(await vscode.editorIsOpen(), 'the group editor opens right away, like Chrome');
      await vscode.type('Docs');
      await vscode.press('Enter');

      assert.ok(!(await vscode.editorIsOpen()), 'Enter closes the editor');
      assert.deepStrictEqual(await vscode.chips(), [{ name: 'Docs', color: COLORS.Grey, collapsed: false, isDot: false }]);
      assert.strictEqual(await groupOf('b.txt'), 'Docs');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'c.txt', 'd.txt'], 'tab stays where it was');
    });

    test('a group without a name shows a colored dot', async () => {
      await vscode.tabMenu('a.txt', 'Add Tab to New Group');
      await vscode.press('Escape');
      const [chip] = await vscode.chips();
      assert.strictEqual(chip.isDot, true);
      assert.strictEqual(chip.color, COLORS.Grey);
    });

    test('each new group gets the next Chrome color: grey, blue, red…', async () => {
      await makeGroup('One', ['a.txt']);
      await makeGroup('Two', ['b.txt']);
      await makeGroup('Three', ['c.txt']);
      assert.deepStrictEqual((await vscode.chips()).map((c) => [c.name, c.color]), [
        ['One', COLORS.Grey],
        ['Two', COLORS.Blue],
        ['Three', COLORS.Red],
      ]);
    });

    test('"Add Tab to Group…" moves the tab next to its group, so a group always stays together', async () => {
      await makeGroup('Main', ['a.txt']);
      await addToGroup('d.txt', 'Main');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'd.txt', 'b.txt', 'c.txt']);
      assert.strictEqual(await groupOf('d.txt'), 'Main');
    });

    test('a tab moved to another group leaves its old group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await makeGroup('Work', ['d.txt']);
      await vscode.tabMenu('b.txt', 'Tab Group > Move Tab to Another Group…');
      await vscode.pickFromList('Work');
      await vscode.waitUntil('b.txt is in Work', async () => (await groupOf('b.txt')) === 'Work');
      assert.strictEqual(await groupOf('a.txt'), 'Main');
    });

    test('Ctrl+click several tabs, right-click → "Add Selected Tabs to New Group" groups them side by side', async () => {
      await vscode.clickTab('a.txt');
      await vscode.clickTab('c.txt', ['Control']);
      await vscode.tabMenu('c.txt', 'Add Selected Tabs to New Group');
      await vscode.type('Pair');
      await vscode.press('Enter');
      assert.strictEqual(await groupOf('a.txt'), 'Pair');
      assert.strictEqual(await groupOf('c.txt'), 'Pair');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'b.txt', 'd.txt']);
    });

    test('Ctrl+click several tabs, right-click → "Add Selected Tabs to Group…" adds all of them to an existing group', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.clickTab('c.txt');
      await vscode.clickTab('d.txt', ['Control']);
      await vscode.tabMenu('d.txt', 'Add Selected Tabs to Group…');
      await vscode.pickFromList('Main');
      await vscode.waitUntil('c.txt and d.txt are in Main', async () => (await groupOf('c.txt')) === 'Main' && (await groupOf('d.txt')) === 'Main');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
    });

    test('several selected tabs are all added, also after clicking a file in the Explorer', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.clickExplorerItem('b.txt');
      await vscode.clickTab('c.txt');
      await vscode.clickTab('d.txt', ['Control']);
      await vscode.tabMenu('d.txt', 'Add Selected Tabs to Group…');
      await vscode.pickFromList('Main');
      await vscode.waitUntil('c.txt and d.txt are in Main', async () => (await groupOf('c.txt')) === 'Main' && (await groupOf('d.txt')) === 'Main');
    });

    test('Shift+click a range of tabs, right-click → "Add Selected Tabs to Group…" adds the whole range', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.clickTab('b.txt');
      await vscode.clickTab('d.txt', ['Shift']);
      await vscode.tabMenu('c.txt', 'Add Selected Tabs to Group…');
      await vscode.pickFromList('Main');
      await vscode.waitUntil('b, c and d are in Main', async () =>
        (await groupOf('b.txt')) === 'Main' && (await groupOf('c.txt')) === 'Main' && (await groupOf('d.txt')) === 'Main',
      );
    });

    test('several selected tabs, right-click a tab outside the selection: only that tab is added (like VS Code\'s own tab commands)', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.clickTab('c.txt');
      await vscode.clickTab('d.txt', ['Control']);
      await vscode.tabMenu('b.txt', 'Add Selected Tabs to Group…');
      await vscode.pickFromList('Main');
      await vscode.waitUntil('b.txt is in Main', async () => (await groupOf('b.txt')) === 'Main');
      assert.strictEqual(await groupOf('c.txt'), null);
      assert.strictEqual(await groupOf('d.txt'), null);
    });

    test('Ctrl+Alt+G adds the current tab to a group', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.clickTab('c.txt');
      await vscode.press('Control+Alt+G');
      await vscode.pickFromList('Main');
      await vscode.waitUntil('c.txt is in Main', async () => (await groupOf('c.txt')) === 'Main');
    });

    test('right-click a grouped tab → "Remove Tab from Group" moves it just past the group (the group does not split)', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt', 'c.txt']);
      await vscode.tabMenu('b.txt', 'Tab Group > Remove Tab from Group');
      await vscode.waitUntil('b.txt left the group', async () => (await groupOf('b.txt')) === null);
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'b.txt', 'd.txt']);
      assert.strictEqual(await groupOf('a.txt'), 'Main');
      assert.strictEqual(await groupOf('c.txt'), 'Main');
    });

    test('closing a tab takes it out of its group; closing its last tab removes the group and its chip', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.tabMenu('a.txt', 'Close');
      await vscode.settled();
      assert.ok(await vscode.chip('Main'), 'the group is still there with b.txt');
      await vscode.tabMenu('b.txt', 'Close');
      await vscode.waitUntil('the chip is gone', async () => (await vscode.chips()).length === 0);
    });
  });

  // ------------------------------------------------------------------ name and color

  suite('naming and coloring', () => {
    test('right-click the chip opens the editor; the name updates while typing', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.openGroupEditor('Main');
      await vscode.typeGroupName('Work');
      assert.ok(await vscode.chip('Work'), 'chip shows the new name before the editor is closed');
      await vscode.press('Enter');
      assert.strictEqual(await groupOf('a.txt'), 'Work');
    });

    test('clicking a color repaints the chip and the line under every tab of the group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt', 'c.txt']);
      await vscode.clickTab('d.txt'); // so no group tab is active (the active tab shows an outline instead of a line)
      await vscode.openGroupEditor('Main');
      await vscode.pickColor('Orange');
      await vscode.press('Escape');

      assert.strictEqual((await vscode.chip('Main'))!.color, COLORS.Orange);
      for (const file of ['a.txt', 'b.txt', 'c.txt']) {
        assert.strictEqual((await vscode.tab(file)).lineColor, COLORS.Orange, `line under ${file}`);
      }
      assert.strictEqual((await vscode.tab('d.txt')).lineColor, null, 'no line under a tab outside the group');
    });

    test('all nine colors can be picked; by default they are Chrome\'s colors', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.openGroupEditor('Main');
      for (const color of ['Grey', 'Blue', 'Red', 'Yellow', 'Green', 'Pink', 'Purple', 'Cyan', 'Orange']) {
        await vscode.pickColor(color);
        assert.strictEqual((await vscode.chip('Main'))!.color, COLORS[color], color);
      }
    });

    test('the swatches are named "Color 1" … "Color 9" (each can be set to any color)', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.openGroupEditor('Main');
      assert.deepStrictEqual(await vscode.swatchTitles(), ['Color 1', 'Color 2', 'Color 3', 'Color 4', 'Color 5', 'Color 6', 'Color 7', 'Color 8', 'Color 9']);
    });

    test('a color slot can be changed in settings (tabPalette.color2): chips, lines and swatch follow it', async () => {
      await vscode.setColorCustomizations({ 'tabPalette.color2': '#00ff00' });
      try {
        await makeGroup('Main', ['a.txt', 'b.txt'], 'Blue'); // slot 2
        await vscode.clickTab('d.txt');
        assert.strictEqual((await vscode.chip('Main'))!.color, 'rgb(0, 255, 0)', 'chip');
        assert.strictEqual((await vscode.tab('a.txt')).lineColor, 'rgb(0, 255, 0)', 'group line');

        await vscode.press('Control+Alt+T'); // Show Tab Groups: the dot in front of the group
        await vscode.waitUntil('the group list shows Main', async () => (await vscode.pickerDotColor('Main')) !== null);
        assert.strictEqual(await vscode.pickerDotColor('Main'), '#00ff00', 'picker dot');
        await vscode.press('Escape');
      } finally {
        await vscode.setColorCustomizations(undefined);
      }
    });

    test('the dots in the Command Palette pickers show each group\'s color', async () => {
      await makeGroup('Main', ['a.txt'], 'Grey');
      await makeGroup('Work', ['b.txt'], 'Blue');
      await vscode.press('Control+Alt+T');
      await vscode.waitUntil('the group list is shown', async () => (await vscode.pickerDotColor('Work')) !== null);
      assert.strictEqual((await vscode.pickerDotColor('Main'))?.toUpperCase(), '#DADCE0', 'Color 1 (grey by default)');
      assert.strictEqual((await vscode.pickerDotColor('Work'))?.toUpperCase(), '#8AB4F8', 'Color 2 (blue by default)');
      await vscode.press('Escape');
    });

    test('the selected color shows a ring only, with no dot in the middle', async () => {
      await makeGroup('Main', ['a.txt'], 'Purple');
      await vscode.openGroupEditor('Main');
      assert.deepStrictEqual(await vscode.selectedSwatch(), { color: 'Purple', hasCenterDot: false });
    });

    test('clicking a color shows no focus border around it, and typing still goes to the name', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.openGroupEditor('Main');
      await vscode.pickColor('Green');
      const after = await vscode.page.evaluate(() => {
        const swatch = document.querySelector('.tg-popup .tg-color.tg-selected') as HTMLElement;
        const style = getComputedStyle(swatch);
        return {
          outline: style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0 ? 'none' : `${style.outlineWidth} ${style.outlineStyle}`,
          focused: document.activeElement?.className ?? '',
        };
      });
      assert.strictEqual(after.outline, 'none', 'no focus ring on the clicked swatch');
      assert.strictEqual(after.focused, 'tg-name', 'the name box keeps the focus');
      await vscode.press('End'); // the name is selected when the editor opens
      await vscode.type(' 2');
      await vscode.press('Enter');
      assert.ok(await vscode.chip('Main 2'), 'typing after picking a color still renames the group');
    });

    test('the active tab of a group gets the rounded outline; other tabs do not', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.clickTab('b.txt');
      assert.strictEqual((await vscode.tab('b.txt')).outlined, true);
      assert.strictEqual((await vscode.tab('a.txt')).outlined, false);
      await vscode.clickTab('d.txt');
      assert.strictEqual((await vscode.tab('d.txt')).outlined, false, 'ungrouped active tab: no outline');
    });
  });

  // ------------------------------------------------------------------ collapse and expand

  suite('collapsing and expanding', () => {
    test("clicking the chip hides the group's tabs and keeps the chip; clicking again shows them", async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.clickTab('d.txt');

      await vscode.clickChip('Main');
      assert.deepStrictEqual(await vscode.tabNames(), ['c.txt', 'd.txt']);
      assert.strictEqual((await vscode.chip('Main'))!.collapsed, true);

      await vscode.clickChip('Main');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
      assert.strictEqual((await vscode.chip('Main'))!.collapsed, false);
    });

    test('collapsing the group of the active tab switches to a tab outside the group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.clickTab('b.txt');
      await vscode.clickChip('Main');
      const active = (await vscode.tabs()).find((t) => t.active)!;
      assert.ok(!['a.txt', 'b.txt'].includes(active.name), `active is now ${active.name}`);
    });

    test('opening a hidden tab with Quick Open expands its group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.clickTab('d.txt');
      await vscode.clickChip('Main');
      await vscode.open('b.txt');
      // Wait for what the user sees: the group's tabs drawn again (the tab bar redraws on the next frame).
      await vscode.waitUntil('the group is expanded and its tabs are shown', async () =>
        (await vscode.tabNames()).join(' ') === 'a.txt b.txt c.txt d.txt',
      );
      assert.strictEqual((await vscode.chip('Main'))!.collapsed, false);
    });
  });

  // ------------------------------------------------------------------ drag and drop

  suite('drag and drop', () => {
    test('dragging a tab between two tabs of a group adds it to the group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.dragTab('d.txt', { before: 'b.txt' });
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'd.txt', 'b.txt', 'c.txt']);
      await vscode.waitUntil('d.txt joined Main', async () => (await groupOf('d.txt')) === 'Main');
    });

    test('dropping a tab on a group\'s chip puts it between the groups: the line is drawn in front of the chip, and the tab joins neither', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await makeGroup('Tab', ['c.txt'], 'Blue');
      await vscode.startTabDrag('d.txt', { onChip: 'Tab' });
      const marker = await vscode.dropMarkerX();
      const color = await vscode.dropMarkerColor();
      const chip = await vscode.chipLeft('Tab');
      await vscode.drop();

      assert.ok(marker !== null, 'a drop line is shown');
      assert.ok(marker! < chip, `drop line (x=${marker}) is left of the Tab chip (x=${chip}), not between the chip and its tab`);
      assert.notStrictEqual(color, COLORS.Blue, 'the normal drop line, not the "join" color');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'd.txt', 'c.txt']);
      await vscode.settled(400);
      assert.strictEqual(await groupOf('d.txt'), null);
      assert.strictEqual(await groupOf('c.txt'), 'Tab');
    });

    test('a group with only one tab can be joined: drop on the right half of its tab', async () => {
      await makeGroup('Solo', ['b.txt'], 'Green');
      await vscode.startTabDrag('d.txt', { after: 'b.txt' });
      const color = await vscode.dropMarkerColor();
      await vscode.drop();

      assert.strictEqual(color, COLORS.Green, 'while hovering, the drop line is in the group color');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'd.txt', 'c.txt']);
      await vscode.waitUntil('d.txt joined Solo', async () => (await groupOf('d.txt')) === 'Solo');
    });

    test('a group with only one tab can be joined: drop between its chip and its tab (joins at the start)', async () => {
      await makeGroup('Solo', ['c.txt'], 'Pink');
      await vscode.startTabDrag('a.txt', { before: 'c.txt' });
      const marker = await vscode.dropMarkerX();
      const color = await vscode.dropMarkerColor();
      const chip = await vscode.chipLeft('Solo');
      await vscode.drop();

      assert.strictEqual(color, COLORS.Pink, 'while hovering, the drop line is in the group color');
      assert.ok(marker! > chip, `drop line (x=${marker}) is after the chip (x=${chip}), inside the group`);
      await vscode.waitUntil('a.txt joined Solo', async () => (await groupOf('a.txt')) === 'Solo');
      assert.deepStrictEqual(await vscode.tabNames(), ['b.txt', 'a.txt', 'c.txt', 'd.txt']);
      assert.deepStrictEqual((await vscode.chips()).map((c) => c.name), ['Solo']);
    });

    test('joining the end of a group that has another group right after it: the line is drawn in front of the next group\'s chip', async () => {
      await makeGroup('Tab', ['a.txt', 'b.txt'], 'Red');
      await makeGroup('Main', ['c.txt'], 'Grey');
      await vscode.startTabDrag('d.txt', { after: 'b.txt' });
      const marker = await vscode.dropMarkerX();
      const color = await vscode.dropMarkerColor();
      const mainChip = await vscode.chipLeft('Main');
      await vscode.drop();

      assert.strictEqual(color, COLORS.Red, "the line is in Tab's color (the group being joined)");
      assert.ok(marker! < mainChip, `the line (x=${marker}) is in front of the Main chip (x=${mainChip}), not between Main's chip and its tab`);
      await vscode.waitUntil('d.txt joined Tab', async () => (await groupOf('d.txt')) === 'Tab');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'd.txt', 'c.txt']);
      assert.strictEqual(await groupOf('c.txt'), 'Main');
    });

    test('dropping a tab on another group\'s tab moves it into that group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await makeGroup('Work', ['d.txt'], 'Orange');
      await vscode.dragTab('a.txt', { after: 'd.txt' });
      await vscode.waitUntil('a.txt moved to Work', async () => (await groupOf('a.txt')) === 'Work');
      assert.strictEqual(await groupOf('b.txt'), 'Main');
    });

    test('dragging the last tab of a group into another group removes the old group and its chip', async () => {
      await makeGroup('Solo', ['a.txt'], 'Green');
      await makeGroup('Main', ['c.txt', 'd.txt']);
      await vscode.dragTab('a.txt', { before: 'd.txt' });
      await vscode.waitUntil('a.txt joined Main', async () => (await groupOf('a.txt')) === 'Main');
      assert.deepStrictEqual((await vscode.chips()).map((c) => c.name), ['Main'], 'the Solo chip is gone');
      assert.deepStrictEqual(await vscode.tabNames(), ['b.txt', 'c.txt', 'a.txt', 'd.txt']);
    });

    test("dragging a group's last tab to the right, onto the next (ungrouped) tab, takes it out of the group", async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.startTabDrag('b.txt', { before: 'c.txt' });
      const color = await vscode.dropMarkerColor();
      await vscode.drop();

      assert.strictEqual(color, COLORS.UngroupDropLine, 'while hovering, the drop line is red: releasing will ungroup the tab');
      await vscode.waitUntil('b.txt left Main', async () => (await groupOf('b.txt')) === null);
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'c.txt', 'd.txt'], 'the tab stays where it is, just outside the group');
      assert.strictEqual(await groupOf('a.txt'), 'Main');
    });

    test('the "ungroup" drop line color can be changed in settings', async () => {
      await vscode.setColorCustomizations({ 'tabPalette.ungroupDropLine': '#00ff00' });
      try {
        await makeGroup('Main', ['a.txt', 'b.txt']);
        await vscode.startTabDrag('b.txt', { before: 'c.txt' });
        const color = await vscode.dropMarkerColor();
        await vscode.drop();
        assert.strictEqual(color, 'rgb(0, 255, 0)');
      } finally {
        await vscode.setColorCustomizations(undefined);
      }
    });

    test('the drop line is not red while a tab is only being moved inside its group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt', 'c.txt']);
      await vscode.startTabDrag('c.txt', { before: 'b.txt' });
      const color = await vscode.dropMarkerColor();
      await vscode.drop();
      assert.notStrictEqual(color, COLORS.UngroupDropLine);
      assert.strictEqual(await groupOf('c.txt'), 'Main');
    });

    test("dragging a group's last tab to the empty end of the tab bar takes it out of the group", async () => {
      await makeGroup('Main', ['c.txt', 'd.txt']);
      await vscode.dragTab('d.txt', { end: true });
      await vscode.waitUntil('d.txt left Main', async () => (await groupOf('d.txt')) === null);
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
      assert.strictEqual(await groupOf('c.txt'), 'Main');
    });

    test('several selected tabs dragged onto a group all join it', async () => {
      await makeGroup('Solo', ['a.txt'], 'Green');
      await vscode.clickTab('c.txt');
      await vscode.clickTab('d.txt', ['Control']);
      await vscode.dragTab('d.txt', { after: 'a.txt' });
      await vscode.waitUntil('c.txt and d.txt joined Solo', async () => (await groupOf('c.txt')) === 'Solo' && (await groupOf('d.txt')) === 'Solo');
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
    });

    test('several selected tabs dragged out of their group all leave it', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt', 'c.txt']);
      await vscode.clickTab('b.txt');
      await vscode.clickTab('c.txt', ['Control']);
      await vscode.dragTab('c.txt', { end: true });
      await vscode.waitUntil('b.txt and c.txt left Main', async () => (await groupOf('b.txt')) === null && (await groupOf('c.txt')) === null);
      assert.strictEqual(await groupOf('a.txt'), 'Main');
    });

    test("a group's only tab dragged out keeps its group (the group moves with it)", async () => {
      await makeGroup('Solo', ['b.txt'], 'Green');
      await vscode.dragTab('b.txt', { after: 'd.txt' });
      await vscode.settled(400);
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
      assert.strictEqual(await groupOf('b.txt'), 'Solo');
    });

    test('dragging a tab out of its group removes it from the group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt', 'c.txt']);
      await vscode.dragTab('b.txt', { after: 'd.txt' });
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
      await vscode.waitUntil('b.txt left Main', async () => (await groupOf('b.txt')) === null);
      assert.strictEqual(await groupOf('a.txt'), 'Main');
    });

    test('dragging a tab inside its group reorders it and keeps it in the group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt', 'c.txt']);
      await vscode.dragTab('c.txt', { before: 'a.txt' });
      assert.deepStrictEqual(await vscode.tabNames(), ['c.txt', 'a.txt', 'b.txt', 'd.txt']);
      assert.strictEqual(await groupOf('c.txt'), 'Main');
    });

    test('dragging a chip moves the whole group: two groups swap places', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await makeGroup('Work', ['c.txt', 'd.txt']);
      await vscode.dragChip('Work', { before: 'a.txt' });
      assert.deepStrictEqual(await vscode.tabNames(), ['c.txt', 'd.txt', 'a.txt', 'b.txt']);
      assert.deepStrictEqual((await vscode.chips()).map((c) => c.name), ['Work', 'Main']);
      assert.strictEqual(await groupOf('a.txt'), 'Main', 'moving a group does not change who is in it');
    });

    test('dragging a chip to the end moves the group to the end', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.dragChip('Main', 'end');
      assert.deepStrictEqual(await vscode.tabNames(), ['c.txt', 'd.txt', 'a.txt', 'b.txt']);
    });
  });

  // ------------------------------------------------------------------ group editor menu

  suite('group editor menu', () => {
    test('"Close group" closes its tabs and hides the chip; "Show Tab Groups" reopens it', async () => {
      await makeGroup('Later', ['a.txt', 'b.txt'], 'Cyan');
      await vscode.openGroupEditor('Later');
      await vscode.groupEditorItem('Close group');
      await vscode.waitUntil('the tabs are closed', async () => (await vscode.tabNames()).join() === 'c.txt,d.txt');
      assert.deepStrictEqual(await vscode.chips(), []);

      await vscode.press('Control+Alt+T');
      await vscode.pickFromList('Later');
      await vscode.waitUntil('the group is back', async () => !!(await vscode.chip('Later')));
      assert.strictEqual((await vscode.chip('Later'))!.color, COLORS.Cyan, 'reopened with its color');
      assert.strictEqual(await groupOf('a.txt'), 'Later');
      assert.strictEqual(await groupOf('b.txt'), 'Later');
    });

    test('Ctrl+Alt+Shift+W closes the current tab\'s group', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.clickTab('a.txt');
      await vscode.press('Control+Alt+Shift+W');
      await vscode.waitUntil('the tabs are closed', async () => (await vscode.tabNames()).join() === 'c.txt,d.txt');
      // reopen so the next test starts without a closed group left over
      await vscode.press('Control+Alt+T');
      await vscode.pickFromList('Main');
      await vscode.waitUntil('the group is back', async () => !!(await vscode.chip('Main')));
    });

    test('"Ungroup" removes the chip and lines but keeps the tabs open', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.openGroupEditor('Main');
      await vscode.groupEditorItem('Ungroup');
      await vscode.waitUntil('the chip is gone', async () => (await vscode.chips()).length === 0);
      assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
      assert.strictEqual(await groupOf('a.txt'), null);
    });

    test('"Delete group" closes the group\'s tabs', async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await vscode.openGroupEditor('Main');
      await vscode.groupEditorItem('Delete group');
      await vscode.waitUntil('the tabs are closed', async () => (await vscode.tabNames()).join() === 'c.txt,d.txt');
      assert.deepStrictEqual(await vscode.chips(), []);
    });

    test('"New tab in group" opens the picked file inside the group', async () => {
      await makeGroup('Main', ['a.txt']);
      await vscode.tabMenu('d.txt', 'Close');
      await vscode.openGroupEditor('Main');
      await vscode.groupEditorItem('New tab in group');
      await vscode.type('d.txt');
      await vscode.pickFromList('d.txt');
      await vscode.waitUntil('d.txt is in Main', async () => (await vscode.tabs()).some((t) => t.name === 'd.txt' && t.group === 'Main'));
      assert.deepStrictEqual((await vscode.tabNames()).slice(0, 2), ['a.txt', 'd.txt']);
    });

    test('Escape closes the group editor without changes', async () => {
      await makeGroup('Main', ['a.txt'], 'Green');
      await vscode.openGroupEditor('Main');
      await vscode.press('Escape');
      assert.ok(!(await vscode.editorIsOpen()));
      assert.deepStrictEqual(await vscode.chips(), [{ name: 'Main', color: COLORS.Green, collapsed: false, isDot: false }]);
    });
  });

  // ------------------------------------------------------------------ pinned tabs

  suite('pinned tabs', () => {
    /** Right-click a tab → Pin / Unpin (VS Code's own commands). */
    const pin = (file: string) => vscode.tabMenu(file, 'Pin');
    const unpin = (file: string) => vscode.tabMenu(file, 'Unpin');
    const isPinned = async (file: string) => (await vscode.tab(file)).pinned;

    test('with pinned tabs on a row of their own, groups are still drawn', async () => {
      await vscode.setUserSetting('workbench.editor.pinnedTabsOnSeparateRow', true);
      try {
        await makeGroup('Main', ['c.txt', 'd.txt'], 'Blue');
        await pin('a.txt');
        await vscode.waitUntil('a.txt is pinned', () => isPinned('a.txt'));
        assert.deepStrictEqual(await vscode.chips(), [{ name: 'Main', color: COLORS.Blue, collapsed: false, isDot: false }]);
        assert.strictEqual(await groupOf('c.txt'), 'Main');
        assert.strictEqual(await groupOf('d.txt'), 'Main');
        assert.strictEqual((await vscode.tab('c.txt')).lineColor, COLORS.Blue, 'the group line is drawn too');
        assert.strictEqual((await vscode.tab('d.txt')).outlined, true, 'and the outline around the active tab');

        // Dragging the chip: the drop position counts the tabs of both tab bars.
        await vscode.dragChip('Main', { before: 'b.txt' });
        assert.deepStrictEqual(await vscode.tabNames(), ['a.txt', 'c.txt', 'd.txt', 'b.txt']);
        assert.strictEqual(await isPinned('a.txt'), true);
      } finally {
        await unpin('a.txt');
        await vscode.setUserSetting('workbench.editor.pinnedTabsOnSeparateRow', undefined);
      }
    });

    test("pinning a grouped tab takes it out of its group (pinned tabs can't be in a group, like Chrome)", async () => {
      await makeGroup('Main', ['a.txt', 'b.txt']);
      await pin('b.txt');
      try {
        await vscode.waitUntil('b.txt left Main', async () => (await groupOf('b.txt')) === null);
        assert.strictEqual(await groupOf('a.txt'), 'Main');
      } finally {
        await unpin('b.txt');
      }
    });

    test('adding a pinned tab to a group unpins it', async () => {
      await makeGroup('Main', ['c.txt']);
      await pin('a.txt');
      await vscode.waitUntil('a.txt is pinned', () => isPinned('a.txt'));
      await addToGroup('a.txt', 'Main');
      assert.strictEqual(await isPinned('a.txt'), false);
      assert.strictEqual(await groupOf('a.txt'), 'Main');
    });
  });

  // ------------------------------------------------------------------ saved per workspace

  suite('saved per workspace', () => {
    test('groups, names, colors and collapsed state come back after reloading the window', async function () {
      this.timeout(150_000); // a reload restarts all extensions, which can take a while on a busy machine
      await makeGroup('Main', ['a.txt', 'b.txt'], 'Pink');
      await makeGroup('Work', ['c.txt'], 'Yellow');
      await vscode.clickTab('d.txt');
      await vscode.clickChip('Work');

      await vscode.reload();
      await vscode.waitUntil('both chips are drawn', async () => (await vscode.chips()).length === 2);
      assert.deepStrictEqual(await vscode.chips(), [
        { name: 'Main', color: COLORS.Pink, collapsed: false, isDot: false },
        { name: 'Work', color: COLORS.Yellow, collapsed: true, isDot: false },
      ]);
      assert.strictEqual(await groupOf('a.txt'), 'Main');
      assert.strictEqual(await groupOf('b.txt'), 'Main');
      assert.strictEqual((await vscode.tab('c.txt')).hidden, true, 'Work is still collapsed');
    });
  });

  // ------------------------------------------------------------------ turning it off (runs last)

  suite('turning the tab bar patch off', () => {
    test('"Disable Chrome-style Tab Groups" restores VS Code\'s original files', async () => {
      await vscode.runCommand('Tab Groups: Disable Chrome-style Tab Groups');
      await vscode.waitUntil('workbench.html is restored', () => vscode.isUnpatched());
    });
  });
});
