import * as assert from 'assert';
import { isHexColor } from '../model';
import { CHIP_MAX_WIDTH, DEFAULT_SETTINGS, parseSettings } from '../settings';

/** parseSettings over a plain object of `tabPalette.*` keys (without the prefix). */
const parse = (values: Record<string, unknown>) => parseSettings((key) => values[key]);

suite('Settings (tabPalette.*)', () => {
  test('without settings, every value is its default', () => {
    assert.deepStrictEqual(parse({}), DEFAULT_SETTINGS);
  });

  test('reads the tab bar settings', () => {
    const settings = parse({ 'tabBar.activeTabOutline': false, 'tabBar.chipMaxWidth': 90 });
    assert.strictEqual(settings.activeTabOutline, false);
    assert.strictEqual(settings.chipMaxWidth, 90);
  });

  test('keeps the chip width in range, and rounds it', () => {
    assert.strictEqual(parse({ 'tabBar.chipMaxWidth': 1 }).chipMaxWidth, CHIP_MAX_WIDTH.min);
    assert.strictEqual(parse({ 'tabBar.chipMaxWidth': 5000 }).chipMaxWidth, CHIP_MAX_WIDTH.max);
    assert.strictEqual(parse({ 'tabBar.chipMaxWidth': 120.6 }).chipMaxWidth, 121);
  });

  test('an invalid value gets its default (a typo in settings.json never breaks the tab bar)', () => {
    const settings = parse({ 'tabBar.activeTabOutline': 'no', 'tabBar.chipMaxWidth': 'wide' });
    assert.strictEqual(settings.activeTabOutline, DEFAULT_SETTINGS.activeTabOutline);
    assert.strictEqual(settings.chipMaxWidth, DEFAULT_SETTINGS.chipMaxWidth);
    assert.strictEqual(parse({ 'tabBar.chipMaxWidth': NaN }).chipMaxWidth, DEFAULT_SETTINGS.chipMaxWidth);
  });

  test('reads when a chip shows its tab count; an unknown mode gets the default', () => {
    assert.strictEqual(DEFAULT_SETTINGS.chipTabCount, 'off');
    for (const mode of ['off', 'collapsed', 'always'] as const) {
      assert.strictEqual(parse({ 'tabBar.chipTabCount': mode }).chipTabCount, mode);
    }
    for (const bad of ['Always', 'never', true, 3]) {
      assert.strictEqual(parse({ 'tabBar.chipTabCount': bad }).chipTabCount, 'off', String(bad));
    }
  });

  test('lists only the group colors set to a hex color', () => {
    const settings = parse({
      'groupColors.color1': '#123',
      'groupColors.color2': ' #1A73E8 ',
      'groupColors.color3': '',
      'groupColors.color4': 'red',
      'groupColors.color5': '#12345',
      'groupColors.color6': 'url(x)',
    });
    assert.deepStrictEqual(settings.colors, { color1: '#123', color2: '#1A73E8' });
  });

  test('reads the "ungroup" drop line color only when it is a hex color', () => {
    assert.strictEqual(parse({ ungroupDropLineColor: '#00ff00' }).ungroupDropLine, '#00ff00');
    assert.ok(!('ungroupDropLine' in parse({ ungroupDropLineColor: 'green' })));
  });

  test('a hex color is #rgb, #rgba, #rrggbb or #rrggbbaa', () => {
    for (const ok of ['#abc', '#abcd', '#A1B2C3', '#a1b2c3d4']) {
      assert.ok(isHexColor(ok), ok);
    }
    for (const bad of ['abc', '#ab', '#abcde', '#ggg', '#a1b2c3d4e', 1, undefined]) {
      assert.ok(!isHexColor(bad), String(bad));
    }
  });
});
