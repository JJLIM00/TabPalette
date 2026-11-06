import * as assert from 'assert';
import { GROUP_COLORS, TabGroup, colorLabel, displayName, isGroupColor, themeColorId } from '../model';

const group = (name: string): TabGroup => ({ id: 'g', name, color: 'color1', uris: [], collapsed: false, closed: false });

suite('Group model', () => {
  test('offers nine numbered color slots', () => {
    assert.deepStrictEqual([...GROUP_COLORS], ['color1', 'color2', 'color3', 'color4', 'color5', 'color6', 'color7', 'color8', 'color9']);
  });

  test('only those nine slots count as group colors', () => {
    assert.ok(isGroupColor('color2'));
    assert.ok(!isGroupColor('color10'));
    assert.ok(!isGroupColor('blue'));
    assert.ok(!isGroupColor(3));
  });

  test('each slot is the theme color users can change: tabPalette.color1 … tabPalette.color9', () => {
    assert.strictEqual(themeColorId('color1'), 'tabPalette.color1');
    assert.strictEqual(themeColorId('color9'), 'tabPalette.color9');
  });

  test('slots are shown as "Color 1" … "Color 9" (a slot can be set to any color)', () => {
    assert.strictEqual(colorLabel('color1'), 'Color 1');
    assert.strictEqual(colorLabel('color9'), 'Color 9');
  });


  test('a group without a name is shown as "Unnamed group"', () => {
    assert.strictEqual(displayName(group('Main')), 'Main');
    assert.strictEqual(displayName(group('  Main ')), 'Main');
    assert.strictEqual(displayName(group('   ')), 'Unnamed group');
  });
});
