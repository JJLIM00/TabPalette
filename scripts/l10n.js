/*
 * Checks the language files (run before the tests):
 * - every key the code uses — t('key') in src/, tx('key') in the tab bar script and the side bar
 *   page — has its English text in l10n/bundle.l10n.json, and every key there is used;
 * - every %key% in package.json has its English text in package.nls.json, and every key there is used;
 * - a translation (bundle.l10n.<language>.json, package.nls.<language>.json) only has known keys
 *   and keeps the {0}, {1}… of the English text.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const problems = [];

function filesIn(dir, ext) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' || entry.name === 'test-ui' ? [] : filesIn(rel, ext);
    }
    return entry.name.endsWith(ext) ? [rel] : [];
  });
}

/** `english` (key → text) against the keys in use, and each translation against `english`. */
function check(name, english, used, translations) {
  for (const key of used) {
    if (!(key in english)) {
      problems.push(`${name}: no English text for "${key}"`);
    }
  }
  for (const key of Object.keys(english)) {
    if (!used.has(key)) {
      problems.push(`${name}: "${key}" is not used`);
    }
  }
  const slots = (text) => (text.match(/\{\d+\}/g) || []).sort().join();
  for (const file of translations) {
    const translated = JSON.parse(read(file));
    for (const [key, text] of Object.entries(translated)) {
      if (!(key in english)) {
        problems.push(`${file}: unknown key "${key}"`);
      } else if (slots(text) !== slots(english[key])) {
        problems.push(`${file}: "${key}" must keep ${slots(english[key]) || 'no {0}'}`);
      }
    }
  }
}

// Code text: l10n/bundle.l10n.json
const code = [...filesIn('src', '.ts'), ...filesIn('resources', '.js')].map(read).join('\n');
// t('key'), and t(condition ? 'key' : 'other key')
const calls = code.matchAll(/\btx?\(\s*(?:[\w.]+ \? )?'([\w.]+)'(?: : '([\w.]+)')?/g);
const usedInCode = new Set([...calls].flatMap((m) => m.slice(1).filter(Boolean)));
const l10nFiles = fs.readdirSync(path.join(ROOT, 'l10n')).filter((f) => /^bundle\.l10n\.[\w-]+\.json$/.test(f));
check('l10n/bundle.l10n.json', JSON.parse(read('l10n/bundle.l10n.json')), usedInCode, l10nFiles.map((f) => `l10n/${f}`));

// package.json text: package.nls.json
const usedInPackage = new Set([...read('package.json').matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
const nlsFiles = fs.readdirSync(ROOT).filter((f) => /^package\.nls\.[\w-]+\.json$/.test(f));
check('package.nls.json', JSON.parse(read('package.nls.json')), usedInPackage, nlsFiles);

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Language files OK: ${usedInCode.size} texts, ${usedInPackage.size} package.json texts, translations: ${[...l10nFiles, ...nlsFiles].join(', ') || 'none'}.`);
