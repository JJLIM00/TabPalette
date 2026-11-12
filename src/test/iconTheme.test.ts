import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileIconTheme, fontCharacter, parseJsonc, pickIcon } from '../iconTheme';

suite('file icon theme', () => {
  const theme = {
    file: 'default',
    fileNames: { 'package.json': 'npm', 'Dockerfile': 'docker' },
    fileExtensions: { ts: 'typescript', 'd.ts': 'typings', json: 'json' },
    languageIds: { javascriptreact: 'react', json: 'json-lang' },
    light: { fileExtensions: { ts: 'typescript-light' }, file: 'default-light' },
  };

  test('a file name match comes first, ignoring case', () => {
    assert.strictEqual(pickIcon(theme, 'package.json', 'json'), 'npm');
    assert.strictEqual(pickIcon(theme, 'dockerfile', undefined), 'docker');
  });

  test('then the longest file extension', () => {
    assert.strictEqual(pickIcon(theme, 'index.d.ts', 'typescript'), 'typings');
    assert.strictEqual(pickIcon(theme, 'a.b.ts', 'typescript'), 'typescript');
    assert.strictEqual(pickIcon(theme, 'DATA.JSON', 'json'), 'json');
  });

  test('then the language, then the default', () => {
    assert.strictEqual(pickIcon(theme, 'Untitled-1', 'javascriptreact'), 'react');
    assert.strictEqual(pickIcon(theme, 'Untitled-2', 'plaintext'), 'default');
    assert.strictEqual(pickIcon(theme, 'Untitled-2', undefined), 'default');
  });

  test('light themes look in their own section first', () => {
    assert.strictEqual(pickIcon(theme, 'a.ts', undefined, 'light'), 'typescript-light');
    assert.strictEqual(pickIcon(theme, 'a.json', undefined, 'light'), 'json');
    assert.strictEqual(pickIcon(theme, 'x', undefined, 'light'), 'default-light');
  });

  test('theme files may have comments and trailing commas', () => {
    const text = '{\n  // a comment\n  "a": "http://x/*not a comment*/", /* block */\n  "b": [1, 2,],\n}';
    assert.deepStrictEqual(parseJsonc(text), { a: 'http://x/*not a comment*/', b: [1, 2] });
  });

  test('font characters are written as \\E001', () => {
    assert.strictEqual(fontCharacter('\\E001'), '');
    assert.strictEqual(fontCharacter('A'), 'A');
  });

  test('the built-in Seti theme gives TypeScript and untitled files their icons', () => {
    const icons = new FileIconTheme();
    const webview = { asWebviewUri: (u: vscode.Uri) => u } as unknown as vscode.Webview;
    try {
      const config = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
      if (config !== 'vs-seti') {
        return; // another theme is set for this test run
      }
      const ts = icons.iconFor(vscode.Uri.file('/x/a.ts'), 'typescript', webview);
      assert.ok(ts && 'char' in ts && ts.font.startsWith('tp-icons-'), JSON.stringify(ts));
      const untitled = icons.iconFor(vscode.Uri.parse('untitled:Untitled-1'), 'json', webview);
      assert.ok(untitled && 'char' in untitled, JSON.stringify(untitled));
      assert.ok(icons.fonts(webview).length > 0, 'Seti has an icon font');
    } finally {
      icons.dispose();
    }
  });
});
