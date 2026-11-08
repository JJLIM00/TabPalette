# Changelog

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
