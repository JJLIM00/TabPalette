import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BACKUP_SUFFIX, SCRIPT_NAME, applyPatch, findWorkbenchHtml, isPermissionError, patchStatus, removePatch } from '../patch';

const ORIGINAL = `<!DOCTYPE html>
<html>
	<head></head>
	<body aria-label="">
	</body>

	<!-- Startup (do not modify order of script tags!) -->
	<script src="./workbench.js" type="module"></script>
</html>
`;

suite('Patching VS Code (workbench.html)', () => {
  let root: string;
  let html: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-groups-patch-'));
    const dir = path.join(root, 'out', 'vs', 'code', 'electron-browser', 'workbench');
    fs.mkdirSync(dir, { recursive: true });
    html = path.join(dir, 'workbench.html');
    fs.writeFileSync(html, ORIGINAL);
  });

  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test("finds VS Code's workbench.html, and reports when it is missing", () => {
    assert.strictEqual(findWorkbenchHtml(root), html);
    assert.strictEqual(findWorkbenchHtml(path.join(root, 'nope')), undefined);
  });

  test("enabling adds our script after VS Code's own, and keeps a backup of the original file", () => {
    applyPatch(html, 'console.log(1)');
    const patched = fs.readFileSync(html, 'utf8');
    assert.ok(patched.indexOf(`<script src="./${SCRIPT_NAME}"></script>`) > patched.indexOf('workbench.js'));
    assert.ok(patched.trimEnd().endsWith('</html>'));
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(html), SCRIPT_NAME), 'utf8'), 'console.log(1)');
    assert.strictEqual(fs.readFileSync(html + BACKUP_SUFFIX, 'utf8'), ORIGINAL);
  });

  test('knows whether the patch is missing, current, or from an older version of the extension', () => {
    assert.strictEqual(patchStatus(html, 'v1'), 'unpatched');
    applyPatch(html, 'v1');
    assert.strictEqual(patchStatus(html, 'v1'), 'patched');
    assert.strictEqual(patchStatus(html, 'v2'), 'outdated', 'after an extension update the script must be refreshed');
  });

  test('enabling twice does not add the script twice', () => {
    applyPatch(html, 'a');
    applyPatch(html, 'b');
    const patched = fs.readFileSync(html, 'utf8');
    assert.strictEqual(patched.split(SCRIPT_NAME).length - 1, 1);
    assert.strictEqual(patchStatus(html, 'b'), 'patched');
  });

  test('disabling restores the original file exactly and removes everything we added', () => {
    applyPatch(html, 'a');
    removePatch(html);
    assert.strictEqual(fs.readFileSync(html, 'utf8'), ORIGINAL);
    assert.ok(!fs.existsSync(path.join(path.dirname(html), SCRIPT_NAME)));
    assert.ok(!fs.existsSync(html + BACKUP_SUFFIX));
    assert.strictEqual(patchStatus(html, 'a'), 'unpatched');
  });

  test('disabling when nothing was patched changes nothing', () => {
    removePatch(html);
    assert.strictEqual(fs.readFileSync(html, 'utf8'), ORIGINAL);
  });

  test('recognizes "no permission" errors (VS Code installed for all users)', () => {
    assert.ok(isPermissionError(Object.assign(new Error('x'), { code: 'EPERM' })));
    assert.ok(isPermissionError(Object.assign(new Error('x'), { code: 'EACCES' })));
    assert.ok(!isPermissionError(Object.assign(new Error('x'), { code: 'ENOENT' })));
    assert.ok(!isPermissionError(undefined));
  });
});
