import * as assert from 'assert';
import { pageText, t, tabCount } from '../text';

suite('Text (by key, from the language files)', () => {
  test('a key gives its English text, with {0}, {1} filled in', () => {
    assert.strictEqual(t('group.rename'), 'Rename group');
    assert.strictEqual(t('sidebar.reopen', 'Work', '2 tabs'), 'Reopen "Work" (2 tabs)');
  });

  test('"1 tab", "3 tabs"', () => {
    assert.strictEqual(tabCount(1), '1 tab');
    assert.strictEqual(tabCount(3), '3 tabs');
  });

  test('the tab bar and side bar get every text, with {0} left for them to fill in', () => {
    const text = pageText();
    assert.strictEqual(text['editor.close'], 'Close group');
    assert.strictEqual(text['tabs.many'], '{0} tabs');
    assert.ok(Object.values(text).every((value) => value.length > 0));
  });
});
