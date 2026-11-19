import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GO_TO_GROUP_COMMANDS, chipShortcuts, defaultGoToKey, formatKey, modifiersOf, parseKeybindings, resolveGoToKeys } from '../shortcuts';

suite('Group keys (Go to Group 1…9)', () => {
  test('the default keys are the ones package.json binds', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    const bindings: { command: string; key: string; win?: string; mac?: string; linux?: string }[] = pkg.contributes.keybindings;
    GO_TO_GROUP_COMMANDS.forEach((command, i) => {
      const b = bindings.find((k) => k.command === command);
      assert.ok(b, `${command} has a key`);
      assert.strictEqual(b.key, defaultGoToKey('win32', i + 1));
      // VS Code takes the Linux key on Windows unless "win" is given.
      assert.strictEqual(b.win, defaultGoToKey('win32', i + 1));
      assert.strictEqual(b.mac, defaultGoToKey('darwin', i + 1));
      assert.strictEqual(b.linux, defaultGoToKey('linux', i + 1));
    });
  });

  test('a key set in keybindings.json replaces the default; "-command" removes it', () => {
    const keys = resolveGoToKeys('win32', [
      { key: 'ctrl+k 1', command: 'tabPalette.goToGroup1' },
      { key: 'alt+2', command: '-tabPalette.goToGroup2' },
      { command: '-tabPalette.goToGroup3' },
      { key: 'alt+9', command: '-tabPalette.goToGroup4' }, // not its key: nothing removed
      { key: 'Ctrl+Shift+5', command: 'tabPalette.goToGroup5' },
    ]);
    assert.deepStrictEqual(keys, ['ctrl+k 1', null, null, 'alt+4', 'ctrl+shift+5', 'alt+6', 'alt+7', 'alt+8', 'alt+9']);
  });

  test('keys are written the way VS Code shows them on each platform', () => {
    assert.strictEqual(formatKey('alt+1', 'win32'), 'Alt+1');
    assert.strictEqual(formatKey('ctrl+alt+1', 'linux'), 'Ctrl+Alt+1');
    assert.strictEqual(formatKey('ctrl+1', 'darwin'), '⌃1');
    assert.strictEqual(formatKey('cmd+shift+g', 'darwin'), '⇧⌘G');
    assert.strictEqual(formatKey('ctrl+k ctrl+1', 'win32'), 'Ctrl+K Ctrl+1');
    assert.strictEqual(formatKey('meta+1', 'linux'), 'Super+1');
  });

  test('the chips show the keys while the first key\'s modifiers are held', () => {
    assert.deepStrictEqual(modifiersOf('ctrl+k 1'), { ctrl: true, alt: false, shift: false, meta: false });
    const shortcuts = chipShortcuts(resolveGoToKeys('win32', []), 'win32');
    assert.deepStrictEqual(shortcuts?.labels.slice(0, 2), ['Alt+1', 'Alt+2']);
    assert.deepStrictEqual(shortcuts?.modifiers, { ctrl: false, alt: true, shift: false, meta: false });
    assert.strictEqual(chipShortcuts([null, 'f5'], 'win32'), null, 'no key with a modifier: nothing to hold');
  });

  test('keybindings.json may have comments and trailing commas; anything unreadable counts as empty', () => {
    const text = `// Place your key bindings in this file
      [
        { "key": "alt+q", /* jump */ "command": "tabPalette.goToGroup1" }, // the first group
        { "key": "ctrl+/", "command": "editor.action.commentLine", },
      ]`;
    assert.deepStrictEqual(parseKeybindings(text), [
      { key: 'alt+q', command: 'tabPalette.goToGroup1' },
      { key: 'ctrl+/', command: 'editor.action.commentLine' },
    ]);
    assert.deepStrictEqual(parseKeybindings('[{'), []);
    assert.deepStrictEqual(parseKeybindings('{}'), []);
  });

  test('the Keyboard Shortcuts setting links there filtered to this extension, in every language', () => {
    const root = path.resolve(__dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const link = `(command:workbench.action.openGlobalKeybindings?${encodeURIComponent(JSON.stringify([`@ext:${pkg.publisher}.${pkg.name}`]))})`;
    for (const file of fs.readdirSync(root).filter((f) => /^package\.nls(\..+)?\.json$/.test(f))) {
      const text: string = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))['setting.keyboard.changeKeys'];
      assert.ok(text.includes(link), `${file} links to Keyboard Shortcuts`);
    }
  });
});
