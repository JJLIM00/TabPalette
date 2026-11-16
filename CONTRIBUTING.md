# Contributing to TabPalette

Thanks for helping! Bug reports and ideas go to [GitHub issues](https://github.com/JJLIM00/TabPalette/issues). For code changes, open a pull request against `master`.

## Development

Requires [Node.js](https://nodejs.org) 22 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm run compile    # type-check and bundle to dist/
pnpm test           # unit and integration tests in a VS Code test host
pnpm run test:ui    # UI tests: drives a real VS Code window with the mouse and keyboard (about 3 minutes)
pnpm run vsix       # build a .vsix
```

`pnpm run test:ui` uses every feature the way a person does: right-click menus, the group editor, clicking and dragging chips, dragging tabs, and the keyboard shortcuts. It then checks what is on screen. It patches only the test copy of VS Code in `.vscode-test`, restores it afterwards, and uses a temporary profile. Don't use the mouse or keyboard while it runs. When a test fails, a screenshot of the window is saved to `out/ui-failures/`.

Press **F5** to start an Extension Development Host with the `test-fixtures` folder open. That window runs your installed VS Code, so **Enable** there patches your real installation. Run **Disable** to undo it.

## Adding a language

All text is in English, and VS Code shows a translation when one exists for its display language. To add a language, add two files, using VS Code's language id (such as `zh-cn`, `ja` or `de`). No code changes are needed.

| Copy | To | What it holds |
|---|---|---|
| `package.nls.json` | `package.nls.<language>.json` | Command names, menus, the side bar title and the setting descriptions |
| `l10n/bundle.l10n.json` | `l10n/bundle.l10n.<language>.json` | Everything else: messages, pickers, the group editor and the side bar |

In each copy, translate the values and keep the keys. Keep `{0}` and `{1}`: they are filled in, for example with a group's name. A text left out stays in English.

Each text has a key named after where it shows, such as `"group.rename": "Rename group"` or `"sidebar.closedGroups": "Closed groups"`. To change a word, change it in `l10n/bundle.l10n.json` only.

To add a text, add its key and English text to `l10n/bundle.l10n.json`, then use it:
- in `src/`: `t('group.rename')` from `src/text.ts`, with values for `{0}`, `{1}` after the key: `t('group.newTabIn', name)`;
- in the tab bar script and the side bar page: `tx('group.rename')`. They get every text from the extension.

`pnpm run check-l10n` runs before the tests. It fails when:
- a key in the code has no English text;
- an English text is not used;
- a translation has an unknown key, or drops a `{0}`.

It checks `package.json`'s `%key%`s against `package.nls.json` the same way.

## Continuous integration

Every push to `master` and every pull request runs [CI](.github/workflows/ci.yml): type-check, lint, bundle, the unit and integration tests, and packaging, on Windows, Linux and macOS. The UI tests don't run there; run them locally before a release.

## Releasing a new version

1. Update `version` in `package.json` and add a `## <version>` section with the release notes to `CHANGELOG.md`.
2. Commit and push, then tag the commit and push the tag:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

The [Release workflow](.github/workflows/release.yml) then waits for the CI run that pushing the commit started, instead of running the same checks again (it runs them itself only if the tagged commit was never pushed to `master`). If they pass, it publishes the extension to the VS Code Marketplace, and creates a GitHub Release with the `.vsix` attached. It stops if the tag doesn't match the version in `package.json`, or if `CHANGELOG.md` has no notes for it.

Publishing uses the Marketplace's **Trusted Publishing**, so no token is stored on GitHub. It is set up once on the [publisher's page](https://marketplace.visualstudio.com/manage) → **Trusted Publishing**, with a policy for repository owner `JJLIM00`, repository `TabPalette`, workflow `release.yml`, and no environment.
