# Changelog

## 0.4.0

- **Keyboard shortcuts** to move between groups. Each can be changed in Keyboard Shortcuts:
  - Go to group 1 … 9: `Alt+1` … `Alt+9` (macOS `Ctrl+1` … `Ctrl+9`, Linux `Ctrl+Alt+1` … `Ctrl+Alt+9`). It opens the group's tab you used last, and expands a collapsed group.
  - Next and previous group: `Ctrl+Alt+]` and `Ctrl+Alt+[` (macOS `Ctrl+Cmd+]` and `Ctrl+Cmd+[`), going round from the last group to the first.
  - Collapse or expand the active tab's group: `Ctrl+Alt+C` (macOS `Ctrl+Cmd+C`).
  - Add the active tab, or the selected tabs, to a new group: `Ctrl+Alt+N` (macOS `Ctrl+Cmd+N`).
- While you hold the modifier keys of "Go to group" (Alt on Windows), each chip on the tab bar and each group header in the side bar shows its key, like `Alt+1`, where the tab count is. It follows keys you change in Keyboard Shortcuts. New setting `tabPalette.keyboard.showGroupShortcuts` turns it off.
- The settings are in three sections: Tab Bar, Group Colors and Keyboard Shortcuts. Keyboard Shortcuts has a link that opens the Tab Groups keys.
- **Search in the side bar.** The search button on the view header (shown while the mouse is over the view), `Ctrl+Alt+F`, or `Ctrl+F` in the side bar opens a search box that finds groups by name and tabs by name. A group found by name shows all its tabs; other groups show only the tabs found, even when collapsed; tabs in no group come last. While the box is open the search button shows pressed; a click on it (or `Ctrl+Alt+F` again) empties the search and closes the box. An open search stays open when the view is collapsed or another view is shown. The × in the box empties it and leaves it open. Enter opens the first tab found, Escape empties the box and closes it.
- **Go to Tab in Group** (`Ctrl+Alt+P`) lists every open tab, in collapsed groups too, then the tabs of closed groups. Each row shows the tab's icon, and on the right its group as a chip in the group's color, with "collapsed" or "closed group" in a box (without the tab bar patch: a color dot, and the group after the tab's name). Type to filter by tab or group name. Picking a tab opens it, expanding its group, or reopening its closed group first.
- "Add Tab to Group…" (`Ctrl+Alt+G`) lists the group you last added a tab to first, so Enter adds to it again.
- Fixed: going to a tab that shows no file (Settings, Claude Code, a Markdown preview) from the side bar or a group shortcut first showed another tab of its row for a moment.
- Fixed: dragging a group chip on a tab bar that wraps onto several lines drew the drop line across every line, and could drop the group on another line. It now shows and drops on the line under the pointer.

## 0.3.1

- Group chips on the tab bar can show how many tabs the group has, in a small badge. New setting `tabPalette.tabBar.chipTabCount`: off (default), while the group is collapsed, or always.
- Fixed: the side bar's scroll bar was always shown, on the editor's background color. It now looks like the Explorer's: a thin rounded slider with no arrows, fading in while the mouse is over the view or just after scrolling, and fading out after.

## 0.3.0

- New **settings** (search for TabPalette in Settings). Changes apply at once:
  - `tabPalette.tabBar.activeTabOutline` turns Chrome's rounded outline around a group's active tab on or off.
  - `tabPalette.tabBar.chipMaxWidth` sets how wide a group chip can get before a long name is cut.
  - `tabPalette.groupColors.color1` … `color9` set each group color to a hex color for every theme. They apply to the chips, group lines, side bar and pickers. Each field shows the slot's default color; left unchanged, the slot keeps its theme color.
  - `tabPalette.ungroupDropLineColor` sets the color of the drop line shown when a dropped tab would leave its group.
- Simplified Chinese (简体中文), Traditional Chinese (繁體中文) and Japanese (日本語). When VS Code's display language is one of them, TabPalette's commands, menus, settings, messages, group editor and side bar show in that language.

## 0.2.2

- Tabs that show no file can join groups: webviews like Git Graph and Claude Code, terminals in the editor, Keyboard Shortcuts and other special editors. Right-click them on the tab bar or in the side bar, or drag them into a group, like any tab. On the tab bar, "Add Tab to Group…" on a grouped one offers "Remove from group". The side bar shows their icons, the same as the tab bar: the pictures of webviews like Git Graph and Claude Code, and the symbols of Settings, Extension pages and Keyboard Shortcuts.

## 0.2.1

- The side bar's tab menu now has the same items as the Explorer's Open Editors list, below the Tab Groups items: Open to the Side, Reveal in File Explorer, Copy Path, Copy Relative Path, Reopen Editor With..., Save, Revert File, Compare with Saved, Select for Compare / Compare with Selected, Close, Close Others, Close Saved and Close All. Save, Revert File and Compare with Saved are greyed out for saved tabs, as in VS Code.
- Fixed: the side bar showed the same plain file icon for every tab. It now shows the icons of your file icon theme, the same as the Explorer and the tab bar (by file name, extension or language, so an untitled file set to JSON gets the JSON icon). Pinned tabs show a pin where the close button is.
- Fixed: dragging a grouped tab out of its group on the tab bar took about half a second to ungroup it. It now leaves the group as soon as you drop it.
- Fixed: a grouped tab dragged to another editor group, or opened to the side, still showed as grouped there. Like a Chrome group lives in one window, a group now lives in one editor group: a tab dragged to another editor group leaves its group (a group's only tab takes the group along), and the copy opened to the side is not grouped. Adding a tab from another editor group to a group moves it to the group.
- Fixed: "Add Tab to Group…" on several files selected in the Explorer only grouped the file that was already open. Files without a tab are now opened and all of them join the group (folders are skipped).
- Fixed: "Move group to new window" moved only one of the group's tabs, and the new window's tab bar showed no group. Every tab of the group now moves, and the new window's tab bar shows the group too.

## 0.2.0

- New **Tab Groups side bar** (Activity Bar icon): all open tabs listed top to bottom like Chrome's vertical tabs, each group under a header in its color. Click to open or close tabs and to collapse groups; drag tabs into and out of groups and drag headers to move groups; Ctrl/Shift+click to select several tabs (the same selection as the tab bar), then drag, right-click or press Delete to act on all of them; right-click a header, or hover it and click ⋮ (or press F2), for the group settings, as in Chrome: name, color, New tab in group, Move group to new window, Close group, Ungroup, Delete group; reopen closed groups from the list.
- Fixed: collapsing a group when every other tab is hidden in a collapsed group kept showing a hidden tab. Collapsing now switches only to a tab that stays visible, and when there is none it opens a new empty file outside any group at the end of the tab bar, like Chrome's new tab.
- Fixed: "Add Tab to New Group" from the side bar's right-click menu opened the new group's settings on the tab bar. They now open in the side bar, where the menu was used.
- Faster: the tab bar is only redrawn when a tab bar changes, not on every key typed in the editor or every blink of the cursor (from about 26 redraws to 2 while typing a few words). Unchanged state is no longer sent to the tab bar or the side bar again, and finding a file's group no longer searches every group.

## 0.1.3

- Fixed: after an update, the tab bar could keep running the old script even after reloading the window. Each version of the script now has a file name of its own, so VS Code always loads the current one.
- New command **Tab Groups: Reload Tab Bar Script**: writes the script again and reloads the window.

## 0.1.2

- Fixed: groups were no longer drawn when pinned tabs are shown on a separate row (`workbench.editor.pinnedTabsOnSeparateRow`).
- Pinned tabs are never in a group, like in Chrome: pinning a grouped tab takes it out of its group, and adding a pinned tab to a group unpins it.

## 0.1.1

- The screenshots on the extension page load reliably (they are now served from raw.githubusercontent.com).

## 0.1.0

First public release.

- Chrome-style group chips and group-colored lines on the tab bar, with Chrome's rounded outline on the active tab.
- Nine group colors (Chrome's by default) as numbered theme colors `tabPalette.color1` … `tabPalette.color9`, each customizable through `workbench.colorCustomizations`.
- Click a chip to collapse or expand its group; right-click it to rename, recolor, close, ungroup or delete.
- Drag tabs into and out of groups, and drag a chip to move the whole group.
- Groups stay together: added tabs move next to their group, removed tabs move just past it.
- Add or remove several selected tabs at once.
- Close a group and reopen it later; groups are saved per workspace.
