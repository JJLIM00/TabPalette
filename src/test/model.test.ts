import * as assert from 'assert';
import { GROUP_COLORS, TabGroup, colorLabel, displayName, isGroupColor } from '../model';

const group = (name: string): TabGroup => ({ id: 'g', name, color: 'grey', uris: [], collapsed: false, closed: false });

suite('Group model', () => {
  test("offers Chrome's nine group colors, in Chrome's order", () => {
    assert.deepStrictEqual([...GROUP_COLORS], ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  });

  test('only those nine names count as group colors', () => {
    assert.ok(isGroupColor('blue'));
    assert.ok(!isGroupColor('Blue'));
    assert.ok(!isGroupColor('magenta'));
    assert.ok(!isGroupColor(3));
  });

  test('color names are shown capitalized', () => {
    assert.strictEqual(colorLabel('orange'), 'Orange');
  });

  test('a group without a name is shown as "Unnamed group"', () => {
    assert.strictEqual(displayName(group('Main')), 'Main');
    assert.strictEqual(displayName(group('  Main ')), 'Main');
    assert.strictEqual(displayName(group('   ')), 'Unnamed group');
  });
});
