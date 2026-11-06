# TabPalette - Tab Groups

**TabPalette** brings Chrome-style tab groups to VS Code. Name and color a group of tabs, collapse it to a single chip, and drag tabs in and out of it, right on the tab bar.

![Tab groups on the VS Code tab bar](images/tab-groups.png)

## Features

- **Group chips and lines.** Each group shows a colored chip with its name in front of its tabs, and a line in the group's color runs under them. The active tab in a group gets Chrome's rounded outline.
- **Nine Chrome colors.** Grey, blue, red, yellow, green, pink, purple, cyan and orange, tuned for light and dark themes.
- **Collapse with a click.** Click a chip to hide the group's tabs and click it again to bring them back.
- **Edit in place.** Right-click a chip to rename the group, pick a color, or close, ungroup or delete it.
- **Drag and drop.**
  - Drop a tab between two tabs of a group to add it to the group.
  - Drag a tab away from its group to remove it.
  - Drag a chip to move the whole group.
- **Groups stay together.** A tab added to a group moves next to it. A tab removed from the middle of a group moves just past the group, so the group never splits.
- **Saved per workspace.** Groups come back when you reopen the folder, including closed groups.

![Group editor](images/group-editor.png)

## Getting started

1. Install TabPalette. On first start it asks to **Enable** Chrome-style tab groups (see [How it draws on the tab bar](#how-it-draws-on-the-tab-bar)). Confirm, then reload the window.
2. Right-click a tab and choose **Add Tab to New Group**. Type a name, pick a color, and press Enter.
3. Right-click more tabs and choose **Add Tab to Group…**, or drag them in between the group's tabs.

![Add a tab to a group from the tab's context menu](images/add-to-group.png)

## Usage

| To… | Do this |
|---|---|
| Create a group | Right-click a tab → **Add Tab to New Group**. The group gets the next free color, and its editor opens so you can name it. |
| Add a tab to a group | Right-click the tab → **Add Tab to Group…**, or drop it between two tabs of the group. |
| Group several tabs at once | Ctrl/Shift+click the tabs, right-click → **Add Selected Tabs to Group…** |
| Add a file from the Explorer | Right-click the file in the Explorer → **Add Tab to Group…** |
| Remove a tab from its group | Right-click → **Tab Group → Remove Tab from Group**, or drag it away from the group. |
| Collapse or expand | Click the chip. Opening a hidden tab (Quick Open, Explorer…) expands its group. |
| Rename or recolor | Right-click the chip. The name updates as you type. Enter or Esc closes the editor. |
| Move a group | Drag its chip to a new place on the tab bar. |
| Close a group | Chip editor → **Close group**. The tabs close and the group is kept; reopen it from **Tab Groups: Show Tab Groups** (`Ctrl+Alt+T`). |
| Ungroup or delete | **Ungroup** keeps the tabs open. **Delete group** closes them too. |

Closing a tab removes it from its group, and a group disappears when its last tab is closed.

![Collapsed groups](images/collapsed.png)

### Keyboard shortcuts

| Shortcut | Command |
|---|---|
| `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS) | Add the current tab, or the selected tabs, to a group |
| `Ctrl+Alt+Shift+W` (`Cmd+Alt+Shift+W`) | Close the current tab's group |
| `Ctrl+Alt+T` (`Cmd+Alt+T`) | Show Tab Groups: all groups in this workspace, including closed ones |

Every action is also in the Command Palette under **Tab Groups:**.

### Custom colors

The group colors are theme colors, so you can change them in your settings:

```jsonc
"workbench.colorCustomizations": {
  "tabPalette.blue": "#4285F4",
  "tabPalette.green": "#34A853"
}
```

Available ids: `tabPalette.grey`, `tabPalette.blue`, `tabPalette.red`, `tabPalette.yellow`, `tabPalette.green`, `tabPalette.pink`, `tabPalette.purple`, `tabPalette.cyan`, `tabPalette.orange`.

## How it draws on the tab bar

VS Code's extension API cannot draw on the tab bar. To show chips and group lines, the extension adds one small script to VS Code's own UI file, `workbench.html`. It asks before doing so, and you can undo it at any time.

- **"Your Code installation appears to be corrupt."** VS Code shows this after any change to its files. It is expected; choose **Don't Show Again**.
- **VS Code updates** replace the file. On the next start the extension offers to re-apply the script.
- **To undo it,** run **Tab Groups: Disable Chrome-style Tab Groups**. It restores VS Code's original file exactly. Do this before uninstalling the extension.
- **Permissions.** If VS Code is installed for all users (for example under *Program Files*), run VS Code as administrator once to enable or disable. Per-user installs don't need this.

Without the script, groups still work from the context menus and the Command Palette, but nothing is drawn on the tab bar.

**Privacy and security.** The extension never changes your settings and sends nothing over the network. The script talks to the extension through a WebSocket on `127.0.0.1` only. That socket accepts only VS Code's own window origin, and only with a random token that is created for each session.

## Known limitations

- Chips are drawn in the main window. Groups moved to a new window keep their membership, but are not drawn there.
- Only file tabs can be grouped. Settings, the Welcome page and other special editors can't join a group.
- The patch targets VS Code desktop. It does not work in VS Code for the Web or in Codespaces in the browser.

## Development

Requires [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm run compile    # type-check and bundle to dist/
pnpm test           # unit and integration tests in a VS Code test host
pnpm run test:ui    # UI tests: drives a real VS Code window with the mouse and keyboard (about 4 minutes)
pnpm run vsix       # build a .vsix
```

`pnpm run test:ui` uses every feature the way a person does: right-click menus, the group editor, clicking and dragging chips, dragging tabs, and the keyboard shortcuts. It then checks what is on screen. It patches only the test copy of VS Code in `.vscode-test`, restores it afterwards, and uses a temporary profile. Don't use the mouse or keyboard while it runs.

Press **F5** to start an Extension Development Host with the `test-fixtures` folder open. That window runs your installed VS Code, so **Enable** there patches your real installation. Run **Disable** to undo it.

## License

[MIT](LICENSE)
