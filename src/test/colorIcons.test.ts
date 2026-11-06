import * as assert from 'assert';
import { resolveThemeColor } from '../colorIcons';

const DEFAULTS = { dark: '#8AB4F8', light: '#1A73E8', highContrast: '#8AB4F8', highContrastLight: '#1A73E8' };
const resolve = (customizations: Record<string, unknown>, kind: 'dark' | 'light' = 'dark', theme = 'Default Dark Modern') =>
  resolveThemeColor('tabPalette.color2', customizations, theme, kind, DEFAULTS);

suite('Picker dot colors (follow the color settings)', () => {
  test('without settings, the default for the light or dark theme is used', () => {
    assert.strictEqual(resolve({}, 'dark'), '#8AB4F8');
    assert.strictEqual(resolve({}, 'light'), '#1A73E8');
  });

  test('a color set in workbench.colorCustomizations is used', () => {
    assert.strictEqual(resolve({ 'tabPalette.color2': '#00ff00' }), '#00ff00');
  });

  test('a color set for the current theme wins over the general one', () => {
    const settings = { 'tabPalette.color2': '#00ff00', '[Default Dark Modern]': { 'tabPalette.color2': '#ff00ff' } };
    assert.strictEqual(resolve(settings), '#ff00ff');
    assert.strictEqual(resolve(settings, 'dark', 'Another Theme'), '#00ff00', 'a block for another theme is ignored');
  });

  test('values that are not hex colors fall back to the default', () => {
    assert.strictEqual(resolve({ 'tabPalette.color2': 'blue' }), '#8AB4F8');
    assert.strictEqual(resolve({ 'tabPalette.color2': 42 }), '#8AB4F8');
  });
});
