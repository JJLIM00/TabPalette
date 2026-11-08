import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BACKUP_SUFFIX, applyPatch, findWorkbenchHtml, isPermissionError, patchStatus, removePatch, scriptName } from '../patch';

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
    const name = scriptName('console.log(1)');
    assert.ok(patched.indexOf(`<script src="./${name}"></script>`) > patched.indexOf('workbench.js'));
    assert.ok(patched.trimEnd().endsWith('</html>'));
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(html), name), 'utf8'), 'console.log(1)');
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
    assert.strictEqual(patched.split('<script src="./tab-groups-patch').length - 1, 1);
    assert.strictEqual(patchStatus(html, 'b'), 'patched');
  });

  test('each version of the script gets a file name of its own, so VS Code never runs a cached old copy', () => {
    const dir = path.dirname(html);
    const ours = () => fs.readdirSync(dir).filter((f) => f.startsWith('tab-groups-patch')).sort();
    assert.notStrictEqual(scriptName('v1'), scriptName('v2'));
    assert.match(scriptName('v1'), /^tab-groups-patch.[0-9a-f]{12}.js$/);

    fs.writeFileSync(path.join(dir, 'tab-groups-patch.js'), 'from an older version of the extension');
    applyPatch(html, 'v1');
    assert.deepStrictEqual(ours(), [scriptName('v1')], 'the old unhashed script is removed');
    applyPatch(html, 'v2');
    assert.deepStrictEqual(ours(), [scriptName('v2')], 'only the current version is kept');
    assert.ok(fs.readFileSync(html, 'utf8').includes(`src="./${scriptName('v2')}"`));
  });

  test('disabling restores the original file exactly and removes everything we added', () => {
    applyPatch(html, 'a');
    removePatch(html);
    assert.strictEqual(fs.readFileSync(html, 'utf8'), ORIGINAL);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(html)), ['workbench.html']);
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
