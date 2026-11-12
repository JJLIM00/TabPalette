// The "Tab Groups" side bar: the open tabs listed top to bottom like Chrome's vertical tabs,
// each tab group under a header in its color. Gets its state from src/sidebar.ts and sends
// back what the user does (click, close, collapse, drag and drop). Builds the page with DOM
// calls only (no HTML strings).
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  /** @type {{rows: any[], groups: any[]} | undefined} */
  let state;
  /** What is being dragged: { kind: 'tabs', row, tabs: [{ index, key, groupId }] } or { kind: 'group', row, groupId }. */
  let drag;
  /** The open group settings popup: { groupId, node, input, swatches }. */
  let popup;
  let renameTimer;

  /** Icon fonts of the file icon theme already added to the page, by family. */
  const fontsLoaded = new Set();

  /** Adds the theme's icon fonts (with the FontFace API: the page allows no inline styles). */
  function loadFonts(fonts) {
    for (const f of fonts) {
      const id = f.family + ' ' + f.src;
      if (fontsLoaded.has(id)) {
        continue;
      }
      fontsLoaded.add(id);
      try {
        const face = new FontFace(f.family, f.src, { weight: f.weight || 'normal', style: f.style || 'normal' });
        document.fonts.add(face);
        face.load().then(() => undefined, () => undefined);
      } catch {
        // A font the browser can't read: its icons show as plain characters.
      }
    }
  }

  /** The tab's icon from the file icon theme (a picture or a font character), or a plain file icon. */
  function fileIcon(icon) {
    if (icon && icon.src) {
      const span = el('span', 'icon themed');
      span.style.backgroundImage = 'url("' + icon.src.replace(/"/g, '%22') + '")';
      return span;
    }
    if (icon && icon.char) {
      const span = el('span', 'icon themed glyph', icon.char);
      span.style.fontFamily = '"' + icon.font + '"';
      if (icon.color) {
        span.style.color = icon.color;
      }
      if (icon.size) {
        span.style.fontSize = icon.size;
      }
      return span;
    }
    return el('span', 'icon');
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data.state;
      loadFonts(state.fonts || []);
      pruneSelection();
      render();
    } else if (e.data && e.data.type === 'edit') {
      // A new group made from the side bar's menu: open its settings here, like Chrome.
      const header = headerOf(e.data.groupId);
      if (header) {
        header.scrollIntoView({ block: 'nearest' });
        openPopup(e.data.groupId, header);
      }
    }
  });
  // Header text color depends on the theme's group colors: when the theme changes (a body class,
  // and the color variables on <html>), work the colors out again and redraw.
  const themeObserver = new MutationObserver(() => {
    textColors.clear();
    if (state) {
      render();
    }
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  vscode.postMessage({ type: 'ready' });

  // ---------------------------------------------------------------- drawing

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function colorVar(color) {
    return 'var(--vscode-tabPalette-' + color + ')';
  }

  /** Text color for each group color, worked out once per theme (reading computed styles is slow). */
  const textColors = new Map();

  /** Dark or light text, whichever reads better on the group color. */
  function textOn(color) {
    if (!textColors.has(color)) {
      textColors.set(color, readableTextOn(color));
    }
    return textColors.get(color);
  }

  function readableTextOn(color) {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--vscode-tabPalette-' + color).trim();
    const m = /^#([0-9a-f]{3,8})$/i.exec(value);
    if (!m) {
      return 'var(--vscode-editor-background)';
    }
    let hex = m[1];
    if (hex.length <= 4) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.35 ? '#202124' : '#ffffff';
  }

  function render() {
    const groups = new Map(state.groups.map((g) => [g.id, g]));
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focusKey : undefined;
    root.replaceChildren();
    const several = state.rows.length > 1;
    for (const row of state.rows) {
      const section = el('div', 'row' + (row.active ? ' active-row' : ''));
      if (several) {
        section.append(el('div', 'row-title', 'Editor Group ' + (row.index + 1)));
      }
      let i = 0;
      while (i < row.tabs.length) {
        const tab = row.tabs[i];
        const group = tab.groupId ? groups.get(tab.groupId) : undefined;
        if (!group) {
          section.append(tabItem(row, tab, i));
          i++;
          continue;
        }
        const block = el('div', 'group' + (group.collapsed ? ' collapsed' : ''));
        block.style.setProperty('--group-color', colorVar(group.color));
        const members = [];
        while (i < row.tabs.length && row.tabs[i].groupId === group.id) {
          members.push(tabItem(row, row.tabs[i], i));
          i++;
        }
        block.append(groupHeader(row, group, members.length));
        if (!group.collapsed) {
          const list = el('div', 'members');
          list.setAttribute('role', 'group');
          list.append(...members);
          block.append(list);
        }
        section.append(block);
      }
      const end = el('div', 'end');
      end.dataset.row = String(row.index);
      section.append(end);
      root.append(section);
    }
    if (state.rows.every((r) => r.tabs.length === 0)) {
      root.prepend(el('div', 'empty', 'No open tabs'));
    }
    const closed = state.groups.filter((g) => g.closed);
    if (closed.length > 0) {
      const section = el('div', 'closed');
      section.append(el('div', 'row-title', 'Closed groups'));
      for (const group of closed) {
        section.append(closedGroup(group));
      }
      root.append(section);
    }
    if (focused) {
      const again = root.querySelector('[data-focus-key="' + CSS.escape(focused) + '"]');
      if (again) {
        again.focus();
      }
    }
    syncPopup();
  }

  // ---------------------------------------------------------------- group settings popup

  /** Chrome's group editor: name, color, then New tab in group … Delete group. */
  function openPopup(groupId, header) {
    closePopup();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) {
      return;
    }
    const node = el('div', 'popup');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'Edit tab group');
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopup(true);
      }
    });

    const input = el('input', 'name');
    input.type = 'text';
    input.value = group.name;
    input.placeholder = 'Name this group';
    input.spellcheck = false;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Group name');
    // The name updates as you type, like Chrome.
    input.addEventListener('input', () => {
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => action('rename', input.value), 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        closePopup(true);
      }
    });

    const swatches = el('div', 'colors');
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', 'Group color');
    for (let n = 1; n <= 9; n++) {
      const color = 'color' + n;
      const swatch = el('button', 'color');
      swatch.type = 'button';
      swatch.title = 'Color ' + n;
      swatch.dataset.color = color;
      swatch.setAttribute('role', 'radio');
      swatch.style.setProperty('--c', colorVar(color));
      // Keep typing in the name field after picking a color.
      swatch.addEventListener('mousedown', (e) => e.preventDefault());
      swatch.addEventListener('click', () => {
        markColor(swatches, color);
        action('setColor', color);
      });
      swatches.append(swatch);
    }
    markColor(swatches, group.color);

    const item = (icon, text, name) => {
      const row = el('button', 'item');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.append(el('span', 'item-icon ' + icon), el('span', 'item-text', text));
      row.addEventListener('click', () => {
        closePopup(true);
        action(name);
      });
      return row;
    };
    node.append(
      input,
      swatches,
      el('div', 'separator'),
      item('i-add', 'New tab in group', 'newTab'),
      item('i-window', 'Move group to new window', 'moveToNewWindow'),
      item('i-close', 'Close group', 'close'),
      el('div', 'separator'),
      item('i-ungroup', 'Ungroup', 'ungroup'),
      item('i-delete', 'Delete group', 'delete'),
    );
    document.body.append(node);
    popup = { groupId: groupId, node: node, input: input, swatches: swatches };
    header.classList.add('editing');
    place(header);
    input.focus();
    input.select();

    function action(name, value) {
      if (name !== 'rename') {
        // Send a name still waiting to be sent first, so it is not lost.
        flushRename();
      }
      vscode.postMessage({ type: 'groupAction', groupId: groupId, action: name, value: value });
    }
  }

  function flushRename() {
    if (popup && renameTimer !== undefined) {
      clearTimeout(renameTimer);
      renameTimer = undefined;
      vscode.postMessage({ type: 'groupAction', groupId: popup.groupId, action: 'rename', value: popup.input.value });
    }
  }

  function markColor(swatches, color) {
    for (const s of swatches.children) {
      const on = s.dataset.color === color;
      s.classList.toggle('selected', on);
      s.setAttribute('aria-checked', String(on));
    }
  }

  /** Below the group's header, or above it when there is no room below. */
  function place(header) {
    const node = popup.node;
    const box = header.getBoundingClientRect();
    node.style.left = '8px';
    node.style.width = Math.max(180, Math.min(300, window.innerWidth - 16)) + 'px';
    let top = box.bottom + 4;
    if (top + node.offsetHeight > window.innerHeight - 4 && box.top - node.offsetHeight - 4 >= 4) {
      top = box.top - node.offsetHeight - 4;
    }
    node.style.top = Math.max(4, top) + 'px';
  }

  /** The header of a group in the list. */
  function headerOf(groupId) {
    return root.querySelector('.group-header[data-focus-key$=":' + CSS.escape(groupId) + '"]');
  }

  /** After a redraw: follow the group (moved, recolored), or close when it is gone. */
  function syncPopup() {
    if (!popup) {
      return;
    }
    const group = state.groups.find((g) => g.id === popup.groupId);
    const header = headerOf(popup.groupId);
    if (!group || group.closed || !header) {
      closePopup();
      return;
    }
    markColor(popup.swatches, group.color);
    place(header);
  }

  function closePopup(refocus) {
    if (!popup) {
      return;
    }
    flushRename();
    const groupId = popup.groupId;
    popup.node.remove();
    popup = undefined;
    for (const h of root.querySelectorAll('.group-header.editing')) {
      h.classList.remove('editing');
    }
    if (refocus) {
      const header = headerOf(groupId);
      if (header) {
        header.focus();
      }
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (popup && !popup.node.contains(e.target) && !(e.target.closest && e.target.closest('.more'))) {
      closePopup();
    }
  });
  window.addEventListener('blur', () => closePopup());
  window.addEventListener('resize', () => syncPopup());

  function tabItem(row, tab, index) {
    const item = el('div', 'tab');
    const selected = isSelected(row.index, tab.key);
    item.classList.toggle('active', tab.active);
    item.classList.toggle('focused-row', tab.active && row.active);
    item.classList.toggle('selected', selected);
    item.classList.toggle('preview', tab.preview);
    item.classList.toggle('dirty', tab.dirty);
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-selected', String(selected || tab.active));
    item.tabIndex = 0;
    item.title = tab.tooltip;
    item.draggable = true;
    item.dataset.row = String(row.index);
    item.dataset.index = String(index);
    item.dataset.focusKey = 'tab:' + row.index + ':' + tab.key;
    const isFile = !tab.key.startsWith('#');
    // Right-click on one of several selected tabs: the menu acts on all of them.
    const many = selected ? selectedTabs(row).filter((t) => !t.key.startsWith('#')) : [];
    item.dataset.vscodeContext = JSON.stringify(
      many.length > 1
        ? { webviewSection: 'selectedTabs', uris: many.map((t) => t.key), preventDefaultContextMenuItems: true }
        : {
            webviewSection: !isFile ? 'otherTab' : tab.groupId ? 'groupedTab' : 'tab',
            uri: isFile ? tab.key : undefined,
            // For the Open Editors items: which tab, and what they depend on.
            row: row.index,
            index: index,
            key: tab.key,
            tabDirty: tab.dirty,
            tabScheme: isFile ? tab.key.slice(0, tab.key.indexOf(':')) : undefined,
            preventDefaultContextMenuItems: true,
          },
    );

    const icon = fileIcon(tab.icon);
    icon.setAttribute('aria-hidden', 'true');
    item.classList.toggle('pinned', tab.pinned);
    const label = el('span', 'label', tab.label);
    item.append(icon, label);
    if (tab.description) {
      item.append(el('span', 'description', tab.description));
    }
    const close = el('button', 'close');
    close.title = tab.dirty ? 'Close (unsaved changes)' : 'Close';
    close.setAttribute('aria-label', 'Close ' + tab.label);
    close.tabIndex = -1;
    item.append(close);

    const ref = { row: row.index, index: index, key: tab.key };
    item.addEventListener('click', (e) => {
      if (e.target === close) {
        vscode.postMessage(Object.assign({ type: 'close' }, ref));
      } else if (state.selectionSync && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        // The tab bar is connected: select there, and show what it reports back.
        vscode.postMessage(Object.assign({ type: 'select', ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey }, ref));
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelected(row, tab);
      } else if (e.shiftKey) {
        selectRange(row, index);
      } else {
        clearSelection(row.index, tab.key);
        render();
        vscode.postMessage(Object.assign({ type: 'activate' }, ref));
      }
    });
    item.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        vscode.postMessage(Object.assign({ type: 'close' }, ref));
      }
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (state.selectionSync) {
          vscode.postMessage(Object.assign({ type: 'select', ctrl: e.ctrlKey, meta: e.metaKey }, ref));
        } else {
          toggleSelected(row, tab);
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        clearSelection(row.index, tab.key);
        render();
        vscode.postMessage(Object.assign({ type: 'activate' }, ref));
      } else if (e.key === 'Delete') {
        e.preventDefault();
        // Closes all selected tabs when this is one of them.
        const tabs = selected ? selectedTabs(row) : [{ index: index, key: tab.key }];
        clearSelection(row.index);
        vscode.postMessage({ type: 'closeTabs', row: row.index, tabs: tabs.map((t) => ({ index: t.index, key: t.key })) });
      } else if (e.key === 'Escape' && selection.keys.size > 0 && !state.selectionSync) {
        clearSelection(row.index);
        render();
      } else {
        moveFocus(e);
      }
    });
    item.addEventListener('dragstart', (e) => {
      // Dragging one of the selected tabs drags all of them, like Chrome.
      const tabs = selected && selection.keys.size > 1 ? selectedTabs(row) : [{ index: index, key: tab.key, groupId: tab.groupId }];
      drag = { kind: 'tabs', row: row.index, tabs: tabs };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabs.length > 1 ? tabs.length + ' tabs' : tab.label);
    });
    item.addEventListener('dragend', endDrag);
    item.addEventListener('dragover', (e) => overTab(e, item, row, tab, index));
    item.addEventListener('drop', (e) => dropOn(e, row.index, dropTargetOf(item, e, index)));
    return item;
  }

  // ---------------------------------------------------------------- selection (Ctrl/Shift+click)

  /** Tabs selected with Ctrl/Shift+click, all in one editor group (row), by key. */
  const selection = { row: -1, keys: new Set(), anchor: undefined };

  function isSelected(rowIndex, key) {
    return selection.row === rowIndex && selection.keys.has(key);
  }

  /** The selected tabs of `row`, in tab order: { index, key, groupId }. */
  function selectedTabs(row) {
    if (selection.row !== row.index) {
      return [];
    }
    return row.tabs.map((t, i) => ({ index: i, key: t.key, groupId: t.groupId })).filter((t) => selection.keys.has(t.key));
  }

  /** Back to no selection; `anchor` is where a later Shift+click range starts. */
  function clearSelection(rowIndex, anchor) {
    selection.row = rowIndex;
    selection.keys = new Set();
    selection.anchor = anchor;
  }

  /** Ctrl+click: add or remove one tab. The first Ctrl+click also keeps the tab that was active. */
  function toggleSelected(row, tab) {
    if (selection.row !== row.index || selection.keys.size === 0) {
      const active = row.tabs.find((t) => t.active);
      clearSelection(row.index, tab.key);
      if (active && active.key !== tab.key) {
        selection.keys.add(active.key);
      }
    }
    if (selection.keys.has(tab.key)) {
      selection.keys.delete(tab.key);
    } else {
      selection.keys.add(tab.key);
    }
    selection.anchor = tab.key;
    render();
  }

  /** Shift+click: every tab from the anchor (the last clicked, or the active tab) to this one. */
  function selectRange(row, index) {
    const active = row.tabs.find((t) => t.active);
    const anchorKey = selection.row === row.index && selection.anchor ? selection.anchor : active ? active.key : undefined;
    let from = row.tabs.findIndex((t) => t.key === anchorKey);
    if (from < 0) {
      from = index;
    }
    const a = Math.min(from, index);
    const b = Math.max(from, index);
    selection.row = row.index;
    selection.keys = new Set(row.tabs.slice(a, b + 1).map((t) => t.key));
    selection.anchor = row.tabs[from].key;
    render();
  }

  /** After a redraw: take the tab bar's selection when connected; else forget selected tabs that are gone. */
  function pruneSelection() {
    if (state.selectionSync) {
      // Several selected tabs in one row (one selected tab is just the active tab).
      const row = state.rows.find((r) => r.tabs.filter((t) => t.selected).length > 1);
      selection.row = row ? row.index : -1;
      selection.keys = new Set(row ? row.tabs.filter((t) => t.selected).map((t) => t.key) : []);
      return;
    }
    const row = state.rows.find((r) => r.index === selection.row);
    const keys = new Set(row ? row.tabs.map((t) => t.key) : []);
    for (const key of [...selection.keys]) {
      if (!keys.has(key)) {
        selection.keys.delete(key);
      }
    }
  }

  function groupHeader(row, group, count) {
    const header = el('div', 'group-header');
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-expanded', String(!group.collapsed));
    header.tabIndex = 0;
    header.draggable = true;
    header.style.color = textOn(group.color);
    header.dataset.focusKey = 'group:' + row.index + ':' + group.id;
    // Right-click opens the group settings popup (like Chrome), not a VS Code menu: this section has no menu items.
    header.dataset.vscodeContext = JSON.stringify({ webviewSection: 'groupHeader', preventDefaultContextMenuItems: true });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPopup(group.id, header);
    });
    const name = el('span', 'group-name', group.name || '');
    header.classList.toggle('editing', !!popup && popup.groupId === group.id);
    header.title =
      (group.name || 'Unnamed group') + ' · ' + count + ' tab' + (count === 1 ? '' : 's') + ' (click to ' + (group.collapsed ? 'expand' : 'collapse') + ', drag to move, right-click, ⋮ or F2 to edit)';
    header.setAttribute('aria-label', (group.name || 'Unnamed group') + ', ' + count + ' tab' + (count === 1 ? '' : 's'));
    header.append(name);
    if (group.collapsed) {
      header.append(el('span', 'count', String(count)));
    }
    // Chrome: a ⋮ button appears on the header on hover and opens the group's settings.
    const more = el('button', 'more');
    more.type = 'button';
    more.tabIndex = -1;
    more.title = 'Edit group';
    more.setAttribute('aria-label', 'Edit group ' + (group.name || 'Unnamed group'));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popup && popup.groupId === group.id) {
        closePopup();
      } else {
        openPopup(group.id, header);
      }
    });
    header.append(more, el('span', 'chevron'));

    const toggle = () => vscode.postMessage({ type: 'toggle', groupId: group.id });
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        openPopup(group.id, header);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if ((e.key === 'ArrowLeft' && !group.collapsed) || (e.key === 'ArrowRight' && group.collapsed)) {
        e.preventDefault();
        toggle();
      } else {
        moveFocus(e);
      }
    });
    header.addEventListener('dragstart', (e) => {
      drag = { kind: 'group', row: row.index, groupId: group.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', group.name || 'Unnamed group');
    });
    header.addEventListener('dragend', endDrag);
    header.addEventListener('dragover', (e) => {
      if (!drag || drag.row !== row.index || (drag.kind === 'group' && drag.groupId === group.id)) {
        return;
      }
      e.preventDefault();
      clearMarks();
      if (drag.kind === 'tabs') {
        header.classList.add('drop-into');
      } else {
        header.closest('.group').classList.add('drop-before');
      }
    });
    header.addEventListener('drop', (e) => dropOn(e, row.index, { header: group.id }));
    return header;
  }

  function closedGroup(group) {
    const item = el('div', 'closed-group');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.style.setProperty('--group-color', colorVar(group.color));
    item.title = 'Reopen "' + (group.name || 'Unnamed group') + '" (' + group.count + ' tab' + (group.count === 1 ? '' : 's') + ')';
    item.dataset.focusKey = 'closed:' + group.id;
    item.dataset.vscodeContext = JSON.stringify({ webviewSection: 'closedGroup', groupId: group.id, preventDefaultContextMenuItems: true });
    item.append(el('span', 'dot'), el('span', 'label', group.name || 'Unnamed group'), el('span', 'description', String(group.count)));
    const reopen = () => vscode.postMessage({ type: 'reopen', groupId: group.id });
    item.addEventListener('click', reopen);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        reopen();
      } else {
        moveFocus(e);
      }
    });
    return item;
  }

  /** Up and down arrows move through the list. */
  function moveFocus(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
      return;
    }
    e.preventDefault();
    const items = Array.from(root.querySelectorAll('[tabindex="0"]'));
    const next = items[items.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      next.focus();
    }
  }

  // ---------------------------------------------------------------- drag and drop

  function dropTargetOf(item, e, index) {
    const box = item.getBoundingClientRect();
    return { index: index, after: e.clientY > box.top + box.height / 2 };
  }

  function overTab(e, item, row, tab, index) {
    if (!drag || drag.row !== row.index) {
      return; // tabs move within their own editor group
    }
    if (drag.kind === 'group' && tab.groupId === drag.groupId) {
      return;
    }
    if (drag.kind === 'tabs' && drag.tabs.length > 1 && drag.tabs.some((t) => t.key === tab.key)) {
      clearMarks(); // not onto one of the dragged tabs
      return;
    }
    e.preventDefault();
    clearMarks();
    const target = dropTargetOf(item, e, index);
    if (drag.kind === 'group' && tab.groupId) {
      // A group never goes inside another group: before or after that whole group.
      const other = item.closest('.group');
      other.classList.add(target.after ? 'drop-after' : 'drop-before');
      return;
    }
    item.classList.add(target.after ? 'drop-after' : 'drop-before');
    // The drop line shows what happens: the group's color to join it, red to leave a group.
    const joins = drag.kind === 'tabs' && drag.tabs.some((t) => !t.key.startsWith('#')) ? tab.groupId : undefined;
    const group = joins && state.groups.find((g) => g.id === joins);
    const leaves = !joins && leavesGroup(row, drag);
    item.style.setProperty(
      '--drop-color',
      group ? colorVar(group.color) : leaves ? 'var(--vscode-tabPalette-ungroupDropLine)' : 'var(--vscode-focusBorder)',
    );
  }

  /** Dropped outside any group, would a dragged tab leave its group? Not when its whole group is dragged along. */
  function leavesGroup(row, d) {
    if (d.kind !== 'tabs') {
      return false;
    }
    const dragged = new Set(d.tabs.map((t) => t.key));
    return d.tabs.some((t) => t.groupId && row.tabs.some((o) => o.groupId === t.groupId && !dragged.has(o.key)));
  }

  document.addEventListener('dragover', (e) => {
    const end = e.target.closest && e.target.closest('.end');
    if (drag && end && Number(end.dataset.row) === drag.row) {
      e.preventDefault();
      clearMarks();
      end.classList.add('drop-end');
      const row = state.rows.find((r) => r.index === drag.row);
      const leaves = row && leavesGroup(row, drag);
      end.style.setProperty('--drop-color', leaves ? 'var(--vscode-tabPalette-ungroupDropLine)' : 'var(--vscode-focusBorder)');
    }
  });
  document.addEventListener('drop', (e) => {
    const end = e.target.closest && e.target.closest('.end');
    if (drag && end && Number(end.dataset.row) === drag.row) {
      dropOn(e, drag.row, { end: true });
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) {
      clearMarks();
    }
  });

  function dropOn(e, row, target) {
    if (!drag || drag.row !== row) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (drag.kind === 'tabs') {
      const tabs = drag.tabs.map((t) => ({ index: t.index, key: t.key }));
      vscode.postMessage({ type: 'dropTabs', row: row, tabs: tabs, target: target });
    } else {
      vscode.postMessage({ type: 'dropGroup', row: row, groupId: drag.groupId, target: target });
    }
    endDrag();
  }

  function clearMarks() {
    for (const node of root.querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-end')) {
      node.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-end');
    }
  }

  function endDrag() {
    drag = undefined;
    clearMarks();
  }
})();
