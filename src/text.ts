import * as fs from 'fs';
import * as path from 'path';
import { l10n } from 'vscode';

/*
 * Text shown to people, by key ("group.rename"). l10n/bundle.l10n.json holds the English text of
 * every key; each other language is a copy with the values translated, named
 * bundle.l10n.<language>.json (for example bundle.l10n.zh-cn.json), which VS Code loads for its
 * display language. package.json's own text works the same way in package.nls.json.
 */

/** The English text of every key, shipped with the extension (next to dist/ and out/). */
const ENGLISH: Readonly<Record<string, string>> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.json'), 'utf8'));

/**
 * The text of `key` in VS Code's language (English when there is no translation of it), with
 * {0}, {1}… filled in from `args`.
 */
export function t(key: string, ...args: (string | number)[]): string {
  const text = l10n.bundle?.[key] ?? ENGLISH[key] ?? key;
  return text.replace(/\{(\d+)\}/g, (match, i: string) => (args[+i] !== undefined ? String(args[+i]) : match));
}

/** "1 tab", "3 tabs". */
export function tabCount(count: number): string {
  return count === 1 ? t('tabs.one') : t('tabs.many', count);
}

/**
 * Every text in VS Code's language, by key, for the tab bar script and the side bar page: they run
 * in VS Code's window and cannot read the language files. They fill in the {0}s themselves.
 */
export function pageText(): Record<string, string> {
  return Object.fromEntries(Object.keys(ENGLISH).map((key) => [key, t(key)]));
}
