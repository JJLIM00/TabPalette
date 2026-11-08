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

## Continuous integration

Every push to `master` and every pull request runs [CI](.github/workflows/ci.yml): type-check, lint, bundle, the unit and integration tests, and packaging, on Windows, Linux and macOS. The UI tests don't run there; run them locally before a release.

## Releasing a new version

1. Update `version` in `package.json` and add a `## <version>` section with the release notes to `CHANGELOG.md`.
2. Commit and push, then tag the commit and push the tag:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

The [Release workflow](.github/workflows/release.yml) then runs the CI checks, publishes the extension to the VS Code Marketplace, and creates a GitHub Release with the `.vsix` attached. It stops if the tag doesn't match the version in `package.json`, or if `CHANGELOG.md` has no notes for it.

Publishing uses the Marketplace's **Trusted Publishing**, so no token is stored on GitHub. It is set up once on the [publisher's page](https://marketplace.visualstudio.com/manage) → **Trusted Publishing**, with a policy for repository owner `JJLIM00`, repository `TabPalette`, workflow `release.yml`, and no environment.
