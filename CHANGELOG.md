# Changelog

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
