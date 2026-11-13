/*
 * TabPalette - Tab Groups: workbench patch (runs inside VS Code's window, not the extension host).
 * Installed by "Tab Groups: Enable Chrome-style Tab Groups"; removed by "Disable".
 *
 * Draws Chrome-style tab groups on VS Code's own tab bar:
 *   - a colored group chip (name, or a dot when unnamed) before the group's first tab,
 *   - a group-colored line under the group's tabs, and a rounded outline around the active one,
 *   - click chip = collapse/expand, drag chip = move the whole group,
 *   - right-click chip = group editor (name, 9 colors, New tab / Move / Close / Ungroup / Delete),
 *   - while a tab is dragged, a drop line in the group's color (joins) or the "ungroup" color
 *     (leaves); on drop it tells the extension, which updates the group once VS Code has moved the tab.
 *
 * Data comes from this window's extension host over a local WebSocket; the port and
 * a secret token are read from a hidden status bar item the extension adds to this
 * window (aria-label "tab-groups-bridge:<port>:<token>").
 * Built with DOM APIs only (the workbench enforces Trusted Types, so no innerHTML).
 */
(function () {
  'use strict';
  if (window.__tabGroupsPatch) {
    return;
  }
  var mainWindow = window;
  install(window);

  // "Move to New Window" opens another window (same page origin, built by this one) with
  // window.open: draw the groups in its tab bars too.
  var open = window.open;
  window.open = function () {
    var child = open.apply(this, arguments);
    if (child) {
      whenReady(child);
    }
    return child;
  };

  function whenReady(child) {
    try {
      if (child.closed) {
        return;
      }
      var d = child.document;
      if (d && d.readyState === 'complete' && d.head && d.body) {
        install(child);
        return;
      }
    } catch (err) {
      return; // not a window of ours (another origin)
    }
    setTimeout(function () {
      whenReady(child);
    }, 50);
  }

  /** Runs the tab groups script for one window: its own state, connection and tab bars. */
  function install(window) {
    var document = window.document;
    if (window.__tabGroupsPatch) {
      return;
    }
    // Also read by the UI tests: whether the extension is connected, the last state it sent, and
    // how many times the tab bar was redrawn.
    var P = (window.__tabGroupsPatch = { connected: false, state: null, renders: 0 });
    // This window's own: the script may run for another window than the one it was loaded in.
    var getComputedStyle = function (node, pseudo) {
      return window.getComputedStyle(node, pseudo);
    };
    var requestAnimationFrame = function (fn) {
      return window.requestAnimationFrame(fn);
    };

    var PREFIX = 'tab-groups-bridge:';
    // Color slots: theme colors tabPalette.color1 … color9 (Chrome's colors by default; users can change them).
    var COLORS = ['color1', 'color2', 'color3', 'color4', 'color5', 'color6', 'color7', 'color8', 'color9'];
    var SHORTCUT_CLOSE = /Macintosh|Mac OS X/.test(navigator.userAgent) ? '⌥⇧⌘W' : 'Ctrl+Alt+Shift+W';

    // ---------------------------------------------------------------- connection

    var ws = null;
    var state = null;

    function findBridge() {
      // The hidden status bar item is in the main window.
      var el = document.querySelector('[aria-label^="' + PREFIX + '"]') || mainWindow.document.querySelector('[aria-label^="' + PREFIX + '"]');
      if (!el) {
        return null;
      }
      var parts = el.getAttribute('aria-label').slice(PREFIX.length).split(':');
      return parts.length === 2 ? { port: parts[0], token: parts[1] } : null;
    }

    function connect() {
      if (window.closed || (ws && (ws.readyState === 0 || ws.readyState === 1))) {
        return;
      }
      var bridge = findBridge();
      if (!bridge) {
        setTimeout(connect, 1000);
        return;
      }
      var sock = new WebSocket('ws://127.0.0.1:' + bridge.port);
      ws = sock;
      sock.onopen = function () {
        sock.send(JSON.stringify({ type: 'hello', token: bridge.token }));
        P.connected = true;
      };
      sock.onmessage = function (e) {
        var msg;
        try {
          msg = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        if (msg && msg.type === 'state') {
          state = msg;
          P.state = msg;
          schedule();
        } else if (msg && msg.type === 'edit') {
          pendingEdit = { gid: msg.groupId, tries: 0 };
          schedule();
        } else if (msg && msg.type === 'click' && typeof msg.row === 'number' && typeof msg.index === 'number') {
          clickTab(msg);
        }
      };
      sock.onclose = function () {
        P.connected = false;
        if (ws === sock) {
          ws = null;
          state = null;
          P.state = null;
          schedule();
          // The extension host may have restarted with a new port: re-read the bridge.
          setTimeout(connect, 1500);
        }
      };
      sock.onerror = function () {};
    }

    function send(action, groupId, value) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'action', action: action, groupId: groupId, value: value }));
      }
    }

    // ---------------------------------------------------------------- helpers

    function el(tag, cls, text) {
      // Made by the main window even for another window: VS Code allows no other (so that its
      // `instanceof HTMLElement` checks keep working).
      var e = mainWindow.document.createElement(tag);
      if (cls) {
        e.className = cls;
      }
      if (text !== undefined) {
        e.textContent = text;
      }
      return e;
    }

    function toggle(node, cls, on) {
      if (node.classList.contains(cls) !== !!on) {
        node.classList.toggle(cls, !!on);
      }
    }

    function setVar(node, name, value) {
      if (node.style.getPropertyValue(name) !== value) {
        if (value) {
          node.style.setProperty(name, value);
        } else {
          node.style.removeProperty(name);
        }
      }
    }

    function parseColor(value) {
      value = (value || '').trim();
      var m = /^#([0-9a-f]{6})/i.exec(value);
      if (m) {
        var n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(value);
      return m ? [+m[1], +m[2], +m[3]] : null;
    }

    function luminance(rgb) {
      var c = rgb.map(function (v) {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    /**
     * Theme-dependent values, worked out once per theme: reading computed styles is slow, and
     * the tab bar redraws often. `themeChanged` drops them.
     */
    var theme = { fg: null, generation: 0 };
    function themeChanged() {
      theme.fg = null;
      theme.generation++;
      schedule();
    }

    /** Dark or white chip text, whichever reads better on the resolved group color. */
    function chipForegrounds() {
      var root = document.querySelector('.monaco-workbench') || document.body;
      var cs = getComputedStyle(root);
      var out = {};
      COLORS.forEach(function (c) {
        var rgb = parseColor(cs.getPropertyValue('--vscode-tabPalette-' + c));
        out[c] = rgb && luminance(rgb) < 0.28 ? '#ffffff' : '#202124';
      });
      return out;
    }

    function labelOf(tab) {
      var name = tab.querySelector('.label-name');
      return name ? name.textContent : tab.getAttribute('aria-label') || '';
    }

    // ---------------------------------------------------------------- tab rows
    //
    // One tab row of VS Code (an editor group) is usually one `.tabs-container`. With
    // `workbench.editor.pinnedTabsOnSeparateRow`, its pinned tabs get a tab bar of their own
    // above the others: then one row is two `.tabs-container`s in the same `.title`.

    function tabsIn(container) {
      return Array.prototype.filter.call(container.children, function (n) {
        return n.classList && n.classList.contains('tab');
      });
    }

    /** Every tab of the tab row that `container` belongs to, in order (pinned tabs first). */
    function rowTabs(container) {
      var title = container.closest('.title');
      var containers = title ? title.querySelectorAll('.tabs-container') : [container];
      return Array.prototype.reduce.call(
        containers,
        function (all, c) {
          return all.concat(tabsIn(c));
        },
        [],
      );
    }

    /** The tab rows on screen: the `.tabs-container`s of each editor group, and all their tabs. */
    function domRows() {
      var rows = [];
      var seen = [];
      document.querySelectorAll('.tabs-container').forEach(function (container) {
        var title = container.closest('.title') || container;
        var at = seen.indexOf(title);
        if (at < 0) {
          seen.push(title);
          rows.push({ containers: [container], tabs: tabsIn(container) });
        } else {
          rows[at].containers.push(container);
          rows[at].tabs = rows[at].tabs.concat(tabsIn(container));
        }
      });
      return rows;
    }

    // ---------------------------------------------------------------- rendering

    /** Draws the groups on every tab row; returns the tab rows (see domRows), for the reports. */
    function render() {
      P.renders++;
      var groups = {};
      (state ? state.groups : []).forEach(function (g) {
        groups[g.id] = g;
      });
      var fg = theme.fg || (theme.fg = chipForegrounds());
      var usedRows = {};
      var rows = domRows();
      for (var c = 0; c < rows.length; c++) {
        var tabs = rows[c].tabs;
        var labels = tabs.map(labelOf);
        // Match this tab row on screen to a tab row of the extension by its exact label sequence.
        var info = null;
        if (state) {
          for (var r = 0; r < state.rows.length; r++) {
            var row = state.rows[r].tabs;
            if (usedRows[r] || row.length !== labels.length) {
              continue;
            }
            var same = true;
            for (var k = 0; k < row.length && same; k++) {
              same = row[k].label === labels[k];
            }
            if (same) {
              usedRows[r] = true;
              info = row;
              break;
            }
          }
        }
        rows[c].containers.forEach(function (container) {
          if (info && container.dataset.tgRow !== String(r)) {
            container.dataset.tgRow = String(r);
          } else if (!info && container.dataset.tgRow !== undefined) {
            delete container.dataset.tgRow;
          }
        });
        for (var i = 0; i < tabs.length; i++) {
          var gid = info ? info[i].group : null;
          decorate(tabs[i], gid ? groups[gid] : null, info, i, fg);
        }
      }
      if (openEditorFor && !groups[openEditorFor]) {
        closeEditor();
      }
      // Open the editor bubble the extension asked for, once its chip is on screen. The chip can
      // take a moment: the tab bar may still be catching up with tabs VS Code just moved.
      if (pendingEdit) {
        var chip = document.querySelector('.tg-chip[data-gid="' + pendingEdit.gid + '"]');
        if (chip) {
          var gid = pendingEdit.gid;
          pendingEdit = null;
          openEditor(gid, chip);
        } else if (++pendingEdit.tries > 60) {
          pendingEdit = null;
        } else {
          setTimeout(schedule, 100);
        }
      }
      return rows;
    }

    var pendingEdit = null;

    function decorate(tab, g, info, i, fg) {
      var first = !!g && !(i > 0 && info[i - 1].group === g.id);
      var last = !!g && !(i < info.length - 1 && info[i + 1].group === g.id);
      toggle(tab, 'tg-member', !!g);
      toggle(tab, 'tg-first', first);
      toggle(tab, 'tg-last', last);
      toggle(tab, 'tg-collapsed', !!g && g.collapsed);
      toggle(tab, 'tg-head', first && g.collapsed);
      setVar(tab, '--tg-color', g ? 'var(--vscode-tabPalette-' + g.color + ')' : '');
      if ((tab.dataset.tgGid || '') !== (g ? g.id : '')) {
        if (g) {
          tab.dataset.tgGid = g.id;
        } else {
          delete tab.dataset.tgGid;
        }
      }

      // .tg-line: the group line along the bottom; .tg-u: Chrome's outline around the active tab.
      ['tg-line', 'tg-u'].forEach(function (cls) {
        var part = tab.querySelector(':scope > .' + cls);
        if (g && !part) {
          tab.appendChild(el('div', cls));
        } else if (!g && part) {
          part.remove();
        }
      });

      var chip = tab.querySelector(':scope > .tg-chip');
      if (!first) {
        if (chip) {
          chip.remove();
        }
        return;
      }
      if (!chip) {
        chip = el('div', 'tg-chip');
        wireChip(chip);
        tab.appendChild(chip);
      }
      var name = (g.name || '').trim();
      if (chip.dataset.gid !== g.id) {
        chip.dataset.gid = g.id;
      }
      if (chip.textContent !== name) {
        chip.textContent = name;
      }
      toggle(chip, 'tg-unnamed', !name);
      setVar(chip, '--tg-chip-fg', fg[g.color]);
      chip.title = (name || 'Unnamed group') + (g.collapsed ? ' (collapsed)' : '') + ' (click to ' + (g.collapsed ? 'expand' : 'collapse') + ', drag to move, right-click to edit)';
      // Measuring forces a layout, so a chip is measured again only when its text or the theme
      // changed. A chip that is not on screen measures 0: try again on the next redraw.
      var measured = name + '|' + theme.generation;
      if (chip.dataset.tgMeasured !== measured) {
        var width = chip.offsetWidth;
        if (width > 0) {
          chip.dataset.tgMeasured = measured;
          chip.dataset.tgWidth = String(width);
        }
      }
      setVar(tab, '--tg-chip-w', (chip.dataset.tgWidth || chip.offsetWidth) + 'px');
    }

    // ---------------------------------------------------------------- chip events

    var downOnChip = false;

    function wireChip(chip) {
      var swallow = function (e) {
        e.stopPropagation();
        if (e.type !== 'pointerdown' && e.type !== 'mousedown') {
          e.preventDefault();
        }
      };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick'].forEach(function (type) {
        chip.addEventListener(type, swallow);
      });
      chip.addEventListener('mousedown', function (e) {
        downOnChip = true;
        e.preventDefault(); // no text selection, no focus change
        if (e.button === 0) {
          startPress(chip, e);
        }
      });
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
      });
    }

    // ---------------------------------------------------------------- drag a chip = move the group (Chrome)

    var press = null;
    var indicator = null;

    function startPress(chip, e) {
      press = { chip: chip, gid: chip.dataset.gid, x: e.clientX, y: e.clientY, dragging: false, target: null };
      document.addEventListener('mousemove', onPressMove, true);
      document.addEventListener('mouseup', onPressUp, true);
    }

    function onPressMove(e) {
      if (!press) {
        return;
      }
      if (!press.dragging) {
        if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 6) {
          return;
        }
        press.dragging = true;
        closeEditor();
        toggle(press.chip, 'tg-dragging', true);
        toggle(document.body, 'tg-group-dragging', true);
      }
      e.preventDefault();
      e.stopPropagation();
      press.target = dropTarget(press, e.clientX);
      showIndicator(press.target);
    }

    function onPressUp(e) {
      document.removeEventListener('mousemove', onPressMove, true);
      document.removeEventListener('mouseup', onPressUp, true);
      var p = press;
      press = null;
      showIndicator(null);
      toggle(document.body, 'tg-group-dragging', false);
      if (!p) {
        return;
      }
      toggle(p.chip, 'tg-dragging', false);
      e.preventDefault();
      e.stopPropagation();
      if (!p.dragging) {
        closeEditor();
        send('toggleCollapse', p.gid);
      } else if (p.target) {
        send('moveGroup', p.gid, { row: p.target.row, index: p.target.index });
      }
    }

    /** Nearest gap between tabs where the group may land (never inside a group). */
    function dropTarget(p, x) {
      var container = p.chip.closest('.tabs-container');
      if (!container || container.dataset.tgRow === undefined) {
        return null;
      }
      // Gaps in this tab bar only (a group can't move among pinned tabs on a tab bar of their own);
      // `offset` turns a position in this bar into a position in the whole tab row.
      var tabs = tabsIn(container);
      var offset = rowTabs(container).indexOf(tabs[0]);
      var gids = tabs.map(function (t) {
        return t.dataset.tgGid || '';
      });
      var shown = function (t) {
        return t.getBoundingClientRect().width > 0 || !!t.querySelector(':scope > .tg-chip');
      };
      // Left edge of a tab, including the chip slot in front of a group's first tab.
      var leftEdge = function (t) {
        var chip = t.querySelector(':scope > .tg-chip');
        return chip ? chip.getBoundingClientRect().left - 6 : t.getBoundingClientRect().left;
      };
      var end = 0;
      tabs.forEach(function (t) {
        if (shown(t)) {
          end = Math.max(end, t.getBoundingClientRect().right);
        }
      });
      var best = null;
      for (var i = 0; i <= tabs.length; i++) {
        if (i < tabs.length && !shown(tabs[i])) {
          continue; // hidden tab of a collapsed group
        }
        var prev = i > 0 ? gids[i - 1] : '';
        var next = i < tabs.length ? gids[i] : '';
        if (prev && prev === next) {
          continue; // inside a group (another one, or its own)
        }
        var gapX = i < tabs.length ? leftEdge(tabs[i]) : end;
        var d = Math.abs(gapX - x);
        if (!best || d < best.d) {
          best = { row: +container.dataset.tgRow, index: offset + i, x: gapX, d: d, rect: container.getBoundingClientRect() };
        }
      }
      return best;
    }

    function showIndicator(t) {
      if (!t) {
        if (indicator) {
          indicator.remove();
          indicator = null;
        }
        return;
      }
      if (!indicator) {
        indicator = el('div', 'tg-drop');
        (document.querySelector('.monaco-workbench') || document.body).appendChild(indicator);
      }
      indicator.style.left = Math.round(t.x - 1) + 'px';
      indicator.style.top = Math.round(t.rect.top + 4) + 'px';
      indicator.style.height = Math.max(0, Math.round(t.rect.height - 8)) + 'px';
    }


    // Right-click on a chip opens the group editor. VS Code handles `contextmenu` for tabs
    // before it reaches the chip, so catch it first: this script loads before the
    // workbench, so a window capture listener runs ahead of VS Code's own.
    window.addEventListener(
      'contextmenu',
      function (e) {
        var chip = e.target && e.target.closest ? e.target.closest('.tg-chip') : null;
        if (!chip) {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (openEditorFor !== chip.dataset.gid) {
          openEditor(chip.dataset.gid, chip);
        }
      },
      true,
    );

    // A drag that starts on a chip must not drag the tab it sits in.
    document.addEventListener(
      'dragstart',
      function (e) {
        if (downOnChip) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        var tab = e.target && e.target.closest ? e.target.closest('.tabs-container > .tab') : null;
        var tabs = tab ? selectedWith(tab) : null;
        tabDrag = tab ? { tab: tab, tabs: tabs, labels: tabs.map(labelOf), join: null, leave: null } : null;
      },
      true,
    );

    // ---------------------------------------------------------------- selected tabs (Ctrl/Shift+click)
    //
    // The extension API cannot see which tabs are selected, but the tab bar can: VS Code marks
    // them with the `selected` class. Acting on a selected tab means acting on the whole
    // selection; acting on any other tab means just that tab (like VS Code's own tab commands).

    function selectedWith(tab) {
      var container = tab.parentElement;
      if (!container || !tab.classList.contains('selected')) {
        return [tab];
      }
      return rowTabs(container).filter(function (t) {
        return t.classList.contains('selected');
      });
    }

    /**
     * Reports the selected tabs of every tab row (VS Code also marks the active tab `selected`)
     * whenever they change: the side bar shows the same selection, and "selected tabs" commands
     * from a tab's right-click menu act on it.
     */
    var lastSelection = '';
    function reportTabSelection(dom) {
      if (!ws || ws.readyState !== 1) {
        lastSelection = '';
        return;
      }
      var rows = [];
      dom.forEach(function (row) {
        var at = row.containers[0].dataset.tgRow;
        if (at === undefined) {
          return;
        }
        var indexes = [];
        row.tabs.forEach(function (t, i) {
          if (t.classList.contains('selected')) {
            indexes.push(i);
          }
        });
        rows.push({ row: +at, indexes: indexes });
      });
      var sig = JSON.stringify(rows);
      if (sig !== lastSelection) {
        lastSelection = sig;
        ws.send(JSON.stringify({ type: 'tabSelection', rows: rows }));
      }
    }

    /**
     * Reports the icons of the tabs that show no file (marked `other` in the state): the
     * extension cannot read them, and the side bar shows them. VS Code draws them as a picture
     * (webviews like Git Graph or Claude Code bring their own), sent as a data: URL as the side
     * bar cannot load the workbench's files (each picture is read once), or as a symbol of its
     * icon font (Settings, Extension pages, Keyboard Shortcuts), sent as `{ codicon: char }`.
     */
    var iconData = {}; // picture URL -> data: URL ('' while it loads, or when it can't be read)
    var lastIcons = '';
    var MAX_ICON = 100000; // characters of a data: URL; a bigger picture is not sent
    function tabIcon(tab) {
      // An editor's own picture is in .monaco-icon-label-iconpath; a symbol (and, in older
      // versions, a picture) is on the label's ::before.
      var path = tab.querySelector('.monaco-icon-label-iconpath');
      var label = tab.querySelector('.monaco-icon-label');
      var before = !path && label ? getComputedStyle(label, '::before') : null;
      var image = path ? path.style.backgroundImage : before ? before.backgroundImage : '';
      var match = /^url\("?(.*?)"?\)$/.exec(image || '');
      if (match) {
        if (!(match[1] in iconData)) {
          loadIcon(match[1]);
        }
        return iconData[match[1]] || null;
      }
      var symbol = before && /codicon/.test(before.fontFamily) ? /^"(.{1,2})"$/.exec(before.content) : null;
      return symbol ? { codicon: symbol[1] } : null;
    }
    function loadIcon(url) {
      iconData[url] = '';
      fetch(url)
        .then(function (response) {
          return response.ok ? response.blob() : null;
        })
        .then(function (blob) {
          if (!blob || !/^image\//.test(blob.type)) {
            return;
          }
          var reader = new FileReader();
          reader.onload = function () {
            if (typeof reader.result === 'string' && reader.result.length <= MAX_ICON) {
              iconData[url] = reader.result;
              schedule();
            }
          };
          reader.readAsDataURL(blob);
        })
        .catch(function () {});
    }
    function reportTabIcons(dom) {
      if (!ws || ws.readyState !== 1) {
        lastIcons = '';
        return;
      }
      var rows = [];
      dom.forEach(function (row) {
        var at = row.containers[0].dataset.tgRow;
        var known = state && state.rows[+at];
        if (at === undefined || !known) {
          return;
        }
        var icons = row.tabs.map(function (t, i) {
          return known.tabs[i] && known.tabs[i].other ? tabIcon(t) : null;
        });
        rows.push({ row: +at, icons: icons });
      });
      var sig = JSON.stringify(rows);
      if (sig !== lastIcons) {
        lastIcons = sig;
        ws.send(JSON.stringify({ type: 'tabIcons', rows: rows }));
      }
    }

    /** A Ctrl/Shift+click in the side bar: click the same tab here, so VS Code selects it the same way. */
    function clickTab(msg) {
      var container = document.querySelector('.tabs-container[data-tg-row="' + msg.row + '"]');
      var tab = container ? rowTabs(container)[msg.index] : null;
      if (!tab || labelOf(tab) !== msg.label) {
        return;
      }
      var opts = { bubbles: true, cancelable: true, button: 0, view: window, ctrlKey: !!msg.ctrl, metaKey: !!msg.meta, shiftKey: !!msg.shift };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
        var Ev = type.indexOf('pointer') === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
        tab.dispatchEvent(new Ev(type, opts));
      });
    }

    // ---------------------------------------------------------------- dragging a tab onto / off a group (Chrome)
    //
    // VS Code drops a tab before or after the tab under the cursor. Like Chrome, dropping it
    // on any tab of a group adds it to that group (so even a group with one tab can be joined),
    // while dropping it on the chip, or in front of it, puts it before the group. While
    // joining, the drop line is drawn in the group's color. Dropping a grouped tab outside its
    // group (on an ungrouped tab, on a chip, or on the empty end of the tab bar) takes it out
    // of the group, even when the tab order does not change (e.g. the group's last tab dragged
    // to the right). A group's only tab carries its group along instead. The move itself is
    // VS Code's; on drop we tell the extension which group the tab joins or leaves.

    var tabDrag = null;

    /**
     * Dragging a grouped tab (or several selected tabs) and hovering outside its group: leave
     * it. When the drag holds all of the group's tabs in this row, they carry the group along.
     */
    function leaveTargetAt(e) {
      var own = tabDrag.tab.dataset.tgGid;
      var bar = e.target && e.target.closest ? e.target.closest('.tabs-and-actions-container') : null;
      var container = bar ? bar.querySelector('.tabs-container') : null;
      var source = tabDrag.tab.parentElement;
      // Over the tab bar of the dragged tab's own row (or that row's bar of pinned tabs).
      if (!own || !container || !source || container.closest('.title') !== source.closest('.title') || container.dataset.tgRow === undefined) {
        return null;
      }
      var mates = rowTabs(container).filter(function (t) {
        return tabDrag.tabs.indexOf(t) < 0 && t.dataset.tgGid === own;
      });
      if (mates.length === 0) {
        return null; // the drag holds the whole group: it takes its group with it
      }
      var tab = e.target.closest('.tabs-container > .tab');
      if (tab && tabDrag.tabs.indexOf(tab) >= 0) {
        return null; // over one of the dragged tabs
      }
      var overChip = !!tab && e.clientX < tab.getBoundingClientRect().left;
      if (tab && tab.dataset.tgGid && !overChip) {
        return null; // over a group tab: its own group (reorder) or another one (join)
      }
      return { gid: own, row: +container.dataset.tgRow, container: container };
    }

    function joinTargetAt(e) {
      var tab = e.target && e.target.closest ? e.target.closest('.tabs-container > .tab') : null;
      if (!tab || tabDrag.tabs.indexOf(tab) >= 0 || !tab.dataset.tgGid || tab.dataset.tgGid === tabDrag.tab.dataset.tgGid) {
        return null; // not a group tab, one of the dragged tabs, or the dragged tab's own group
      }
      if (e.clientX < tab.getBoundingClientRect().left) {
        return null; // over the chip (it sits in the margin in front of the group's first tab)
      }
      var container = tab.parentElement;
      if (!container || container.dataset.tgRow === undefined) {
        return null;
      }
      // On the left half of a group's first tab, the tab joins at the start of that group: the
      // line goes between its chip and the tab. Anywhere else the line stays where VS Code puts
      // it (e.g. at the end of the group, in front of the next group's chip).
      var rect = tab.getBoundingClientRect();
      var atStart = tab.classList.contains('tg-first') && e.clientX - rect.left <= rect.width / 2;
      return {
        gid: tab.dataset.tgGid,
        row: +container.dataset.tgRow,
        container: container,
        color: getComputedStyle(tab).getPropertyValue('--tg-color'),
        startTab: atStart ? tab : null,
      };
    }

    function showJoin(join) {
      var was = tabDrag && tabDrag.join;
      if (was && (!join || was.container !== join.container)) {
        toggle(was.container, 'tg-join', false);
        setVar(was.container, '--tg-join-color', '');
      }
      if (was && was.startTab && (!join || was.startTab !== join.startTab)) {
        toggle(was.startTab, 'tg-join-start', false);
      }
      if (join) {
        toggle(join.container, 'tg-join', true);
        setVar(join.container, '--tg-join-color', join.color);
        if (join.startTab) {
          toggle(join.startTab, 'tg-join-start', true);
        }
      }
      if (tabDrag) {
        tabDrag.join = join;
      }
    }

    document.addEventListener(
      'dragover',
      function (e) {
        if (tabDrag) {
          showJoin(joinTargetAt(e));
          showLeave(tabDrag.join ? null : leaveTargetAt(e));
        }
      },
      true,
    );
    document.addEventListener(
      'drop',
      function () {
        if (tabDrag && tabDrag.join) {
          send('joinOnDrop', tabDrag.join.gid, { row: tabDrag.join.row, labels: tabDrag.labels });
        } else if (tabDrag && tabDrag.leave) {
          send('leaveOnDrop', tabDrag.leave.gid, { row: tabDrag.leave.row, labels: tabDrag.labels });
        }
        endTabDrag();
      },
      true,
    );
    document.addEventListener('dragend', endTabDrag, true);

    /** Releasing now would take the tab out of its group: the drop line turns the "ungroup" color. */
    function showLeave(leave) {
      if (!tabDrag) {
        return;
      }
      var was = tabDrag.leave && tabDrag.leave.container;
      if (was && (!leave || leave.container !== was)) {
        toggle(was, 'tg-leave', false);
      }
      if (leave) {
        toggle(leave.container, 'tg-leave', true);
      }
      tabDrag.leave = leave;
    }

    function endTabDrag() {
      showJoin(null);
      showLeave(null);
      tabDrag = null;
    }
    document.addEventListener(
      'mouseup',
      function () {
        setTimeout(function () {
          downOnChip = false;
        }, 0);
      },
      true,
    );

    // ---------------------------------------------------------------- group editor (Chrome bubble)

    var editor = null;
    var openEditorFor = null;
    var renameTimer = null;

    function closeEditor() {
      if (editor) {
        editor.remove();
        editor = null;
        openEditorFor = null;
        document.removeEventListener('mousedown', onOutside, true);
        window.removeEventListener('blur', closeEditor);
      }
    }

    function onOutside(e) {
      if (editor && !editor.contains(e.target)) {
        closeEditor();
      }
    }

    function findGroup(gid) {
      var list = state ? state.groups : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === gid) {
          return list[i];
        }
      }
      return null;
    }

    function openEditor(gid, anchor) {
      closeEditor();
      var g = findGroup(gid);
      if (!g) {
        return;
      }
      var pop = el('div', 'tg-popup');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Edit tab group');
      ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown', 'contextmenu', 'wheel'].forEach(function (type) {
        pop.addEventListener(type, function (e) {
          e.stopPropagation();
          if (e.type === 'keydown' && e.key === 'Escape') {
            closeEditor();
          }
        });
      });

      var input = el('input', 'tg-name');
      input.type = 'text';
      input.value = g.name || '';
      input.placeholder = 'Name this group';
      input.spellcheck = false;
      input.addEventListener('input', function () {
        clearTimeout(renameTimer);
        var value = input.value;
        renameTimer = setTimeout(function () {
          send('rename', gid, value);
        }, 120);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          clearTimeout(renameTimer);
          send('rename', gid, input.value);
          closeEditor();
        }
      });
      pop.appendChild(input);

      var swatches = el('div', 'tg-colors');
      COLORS.forEach(function (c) {
        var b = el('button', 'tg-color');
        b.type = 'button';
        b.title = 'Color ' + c.slice('color'.length);
        b.setAttribute('aria-label', b.title);
        b.style.setProperty('--c', 'var(--vscode-tabPalette-' + c + ')');
        toggle(b, 'tg-selected', c === g.color);
        // A click must not move focus to the swatch: no focus ring, and typing keeps going to the name.
        b.addEventListener('mousedown', function (e) {
          e.preventDefault();
        });
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(swatches.children, function (s) {
            toggle(s, 'tg-selected', s === b);
          });
          send('setColor', gid, c);
        });
        swatches.appendChild(b);
      });
      pop.appendChild(swatches);

      var item = function (icon, text, action, shortcut) {
        var row = el('div', 'tg-item');
        row.setAttribute('role', 'menuitem');
        row.tabIndex = 0;
        row.appendChild(el('span', 'tg-icon codicon codicon-' + icon));
        row.appendChild(el('span', 'tg-text', text));
        if (shortcut) {
          row.appendChild(el('span', 'tg-key', shortcut));
        }
        var run = function () {
          clearTimeout(renameTimer);
          if (input.value !== (g.name || '')) {
            send('rename', gid, input.value);
          }
          closeEditor();
          send(action, gid);
        };
        row.addEventListener('click', run);
        row.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            run();
          }
        });
        pop.appendChild(row);
      };
      pop.appendChild(el('div', 'tg-sep'));
      item('add', 'New tab in group', 'newTab');
      item('multiple-windows', 'Move group to new window', 'moveToNewWindow');
      item('close-all', 'Close group', 'close', SHORTCUT_CLOSE);
      pop.appendChild(el('div', 'tg-sep'));
      item('ungroup-by-ref-type', 'Ungroup', 'ungroup');
      item('trash', 'Delete group', 'delete');

      (document.querySelector('.monaco-workbench') || document.body).appendChild(pop);
      var rect = anchor.getBoundingClientRect();
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8));
      var top = rect.bottom + 6;
      if (top + pop.offsetHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - pop.offsetHeight - 6);
      }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';

      editor = pop;
      openEditorFor = gid;
      setTimeout(function () {
        document.addEventListener('mousedown', onOutside, true);
        window.addEventListener('blur', closeEditor);
      }, 0);
      input.focus();
      input.select();
    }

    // ---------------------------------------------------------------- styles

    var T = '.monaco-workbench .part.editor .tabs-container > .tab';
    var CSS = [
      /* hidden handshake item */
      '.statusbar-item[aria-label^="' + PREFIX + '"] { display: none !important; }',

      /* group line under every tab of a group */
      '.tabs-container > .tab.tg-member { position: relative; }',
      '.tabs-container > .tab > .tg-line { position: absolute; left: 0; right: 0; bottom: 0; height: 0; box-sizing: content-box; border-bottom: 2px solid var(--tg-color); z-index: 11; pointer-events: none; }',
      /* the first tab's line also runs under the chip, like Chrome */
      '.tabs-container > .tab.tg-first > .tg-line { left: calc(-1 * (var(--tg-chip-w, 14px) + 8px)); border-top-left-radius: 2px; border-bottom-left-radius: 2px; }',
      '.tabs-container > .tab.tg-last > .tg-line { right: 6px; border-top-right-radius: 2px; border-bottom-right-radius: 2px; }',

      /* chip in its own slot just before the first tab (the tab is pushed right to make room) */
      T + '.tg-first, ' + T + '.tg-first.tg-first { margin-left: calc(var(--tg-chip-w, 14px) + 12px) !important; overflow: visible !important; }',
      /* VS Code's drop marker for "drop before this tab" sits at the tab's left edge, which for a
         group's first tab is after the chip and looks like "into the group". The drop lands
         before the group, so draw the marker in front of the chip, at the start of its slot. */
      T + '.tg-first.tg-first.tg-first.drop-target-right::before { left: calc(-1 * (var(--tg-chip-w, 14px) + 12px)) !important; }',
      /* Dropping onto a group's tab joins the group: the drop line takes the group's color. When
         joining at the start of a group (left half of its first tab), the line sits between that
         group's chip and its tab; when joining the end of a group, it stays in front of the next
         group's chip. */
      '.monaco-workbench .part.editor .tabs-container.tg-join > .tab.drop-target-left::after, ' +
        '.monaco-workbench .part.editor .tabs-container.tg-join > .tab.drop-target-right::before { background-color: var(--tg-join-color) !important; width: 3px !important; }',
      '.monaco-workbench .part.editor .tabs-container.tg-join > .tab.tg-first.tg-first.tg-join-start.drop-target-right::before { left: 0 !important; }',
      /* Releasing would take the dragged tab out of its group: the drop line shows the "ungroup"
         theme color (tabPalette.ungroupDropLine, red by default; change it in workbench.colorCustomizations). */
      '.monaco-workbench .part.editor .tabs-container.tg-leave > .tab.drop-target-left::after, ' +
        '.monaco-workbench .part.editor .tabs-container.tg-leave > .tab.drop-target-right::before' +
        ' { background-color: var(--vscode-tabPalette-ungroupDropLine, #F14C4C) !important; width: 3px !important; }',
      '.tg-chip { position: absolute; left: calc(-1 * (var(--tg-chip-w, 14px) + 6px)); top: 50%; transform: translateY(-50%); z-index: 12; box-sizing: border-box;' +
        ' height: 20px; line-height: 20px; padding: 0 8px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' +
        ' border-radius: 6px; background: var(--tg-color); color: var(--tg-chip-fg, #202124);' +
        ' font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; -webkit-user-select: none; }',
      '.tg-chip.tg-unnamed { width: 14px; height: 14px; padding: 0; border-radius: 50%; }',
      '.tg-chip:hover { filter: brightness(1.1); }',
      '.tg-chip.tg-dragging { opacity: .6; cursor: grabbing; }',
      'body.tg-group-dragging, body.tg-group-dragging * { cursor: grabbing !important; }',
      '.tg-drop { position: fixed; z-index: 2600; width: 2px; border-radius: 1px; background: var(--vscode-focusBorder); pointer-events: none; }',

      /* Chrome-style outline around the active tab of a group: up the left side, across the
         top, down the right side, then a small outward curve at each bottom end that meets the
         group line exactly at the tab's edge (everything stays inside the tab) */
      '.tabs-container > .tab > .tg-u { display: none; position: absolute; left: 4px; right: 4px; top: 3px; bottom: 5px; box-sizing: border-box;' +
        ' border: 2px solid var(--tg-color); border-bottom: none; border-radius: 8px 8px 0 0; pointer-events: none; z-index: 11; }',
      '.tabs-container > .tab > .tg-u::before, .tabs-container > .tab > .tg-u::after { content: ""; position: absolute; top: 100%; width: 6px; height: 5px;' +
        ' box-sizing: border-box; border: 0 solid var(--tg-color); border-bottom-width: 2px; }',
      '.tabs-container > .tab > .tg-u::before { left: -6px; border-right-width: 2px; border-bottom-right-radius: 4px; }',
      '.tabs-container > .tab > .tg-u::after { right: -6px; border-left-width: 2px; border-bottom-left-radius: 4px; }',
      /* last tab: the group line ends 6px before its edge, so the right side just drops straight down */
      '.tabs-container > .tab.tg-last > .tg-u { right: 6px; }',
      '.tabs-container > .tab.tg-last > .tg-u::after { right: -2px; width: 2px; border-bottom-width: 0; border-radius: 0; }',
      /* VS Code's own active-tab background fills exactly the inside of the U (no dark margin
         outside it), and its own active-tab outline is hidden */
      T + '.active.tg-member > .tab-fill, ' + T + '.active.tg-member.tg-member > .tab-fill { display: block !important; position: absolute !important;' +
        ' inset: 3px 4px 0 4px !important; border: 0 !important; border-radius: 8px 8px 0 0 !important; box-shadow: none !important; clip-path: none !important; }',
      T + '.active.tg-last.tg-member > .tab-fill { right: 6px !important; }',
      T + '.active.tg-member > .tab-fill::before, ' + T + '.active.tg-member > .tab-fill::after, ' +
        T + '.active.tg-member > .tab-connected-edge { display: none !important; }',
      '.tabs-container > .tab.active.tg-member > .tg-u { display: block; }',
      '.tabs-container > .tab.active.tg-member:not(.tg-first) > .tg-line { display: none; }',
      /* first tab active: the line stays only under the chip */
      '.tabs-container > .tab.active.tg-first > .tg-line { right: 100%; border-radius: 2px; }',
      '.tabs-container > .tab.tg-head > .tg-u { display: none !important; }',

      /* collapsed: only the chip remains */
      T + '.tg-collapsed:not(.tg-head) { display: none !important; }',
      /* collapsed: the first tab shrinks to nothing; only its chip (in the margin slot) stays */
      T + '.tg-head, ' + T + '.tg-head.tg-head { padding: 0 !important; width: 0 !important; min-width: 0 !important; max-width: 0 !important;' +
        ' flex: 0 0 0 !important; border: none !important; background: transparent !important; }',
      /* beats VS Code's own `padding-right: … !important` for tabs with an action button */
      T + '.tg-head'.repeat(8) + ' { padding: 0 !important; }',
      T + '.tg-head > :not(.tg-chip) { visibility: hidden !important; }',
      '.tabs-container > .tab.tg-head::before, .tabs-container > .tab.tg-head::after { display: none !important; }',

      /* group editor bubble */
      '.tg-popup { position: fixed; z-index: 2600; width: 300px; box-sizing: border-box; padding: 12px 0 6px;' +
        ' background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground));' +
        ' border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); border-radius: 10px;' +
        ' box-shadow: 0 6px 24px var(--vscode-widget-shadow, rgba(0,0,0,.4)); font-size: 13px; font-family: var(--vscode-font-family); }',
      '.tg-popup .tg-name { display: block; box-sizing: border-box; width: calc(100% - 24px); margin: 0 12px; height: 40px; padding: 0 12px;' +
        ' background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 2px solid var(--vscode-focusBorder);' +
        ' border-radius: 8px; outline: none; font: inherit; font-size: 14px; }',
      '.tg-popup .tg-name::placeholder { color: var(--vscode-input-placeholderForeground); }',
      '.tg-popup .tg-colors { display: flex; justify-content: space-between; padding: 14px 16px 12px; }',
      '.tg-popup .tg-color { width: 20px; height: 20px; padding: 0; border-radius: 50%; border: none; cursor: pointer; background: var(--c); }',
      '.tg-popup .tg-color.tg-selected { box-shadow: 0 0 0 2px var(--vscode-menu-background, #1f1f1f), 0 0 0 4px var(--c); }',
      /* no focus ring after a mouse click (VS Code outlines every focused button); keyboard focus (Tab) still shows one */
      '.monaco-workbench .tg-popup .tg-color:focus:not(:focus-visible) { outline: none !important; }',
      '.monaco-workbench .tg-popup .tg-color:focus-visible { outline: 2px solid var(--vscode-focusBorder) !important; outline-offset: 3px !important; }',
      '.tg-popup .tg-sep { height: 1px; margin: 6px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, rgba(128,128,128,.35))); }',
      '.tg-popup .tg-item { display: flex; align-items: center; gap: 14px; height: 40px; padding: 0 20px; cursor: pointer; outline: none; }',
      '.tg-popup .tg-item:hover, .tg-popup .tg-item:focus { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }',
      '.tg-popup .tg-icon { font-size: 16px; opacity: .9; }',
      '.tg-popup .tg-text { flex: 1; font-weight: 600; }',
      '.tg-popup .tg-key { opacity: .75; font-size: 12px; }',
    ].join('\n');

    // ---------------------------------------------------------------- lifecycle

    var pending = false;
    function schedule() {
      if (pending || window.closed) {
        return;
      }
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        try {
          var rows = render();
          reportTabSelection(rows);
          reportTabIcons(rows);
        } catch (err) {
          console.error('[TabPalette]', err);
        }
      });
    }
    function ours(node) {
      return (
        node &&
        node.nodeType === 1 &&
        (['tg-chip', 'tg-line', 'tg-u', 'tg-drop', 'tg-popup'].some(function (c) {
          return node.classList.contains(c);
        }) ||
          !!node.closest('.tg-popup'))
      );
    }

    function stripOurs(cls) {
      return (cls || '')
        .split(/\s+/)
        .filter(function (c) {
          return c && c.indexOf('tg-') !== 0;
        })
        .join(' ');
    }

    /** Inside a tab bar (with its editor actions; pinned tabs on a row of their own have a second one). */
    function inTabBar(node) {
      var e = node && (node.nodeType === 1 ? node : node.parentElement);
      return !!e && !!e.closest('.tabs-and-actions-container');
    }

    /** An editor group (with its tab bar) was added or removed, e.g. by splitting the editor. */
    function holdsTabBar(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.nodeType === 1 && (n.classList.contains('tabs-and-actions-container') || n.querySelector('.tabs-and-actions-container'))) {
          return true;
        }
      }
      return false;
    }

    /**
     * Whether a DOM change can change what we draw. Only the tab bars count: everything else in
     * the window (typing in the editor, the cursor blinking, the panels) is ignored, so the tab bar
     * is not redrawn for nothing.
     */
    function relevant(m) {
      if (ours(m.target)) {
        return false;
      }
      if (m.type === 'attributes') {
        if (m.target === document.body || m.target.classList.contains('monaco-workbench')) {
          // Theme type (dark, light, high contrast) is a class here.
          if (stripOurs(m.oldValue) !== stripOurs(m.target.getAttribute('class'))) {
            themeChanged();
          }
          return false;
        }
        // Ignore our own tg-* class toggles on tabs.
        return inTabBar(m.target) && stripOurs(m.oldValue) !== stripOurs(m.target.getAttribute('class'));
      }
      if (m.type === 'childList') {
        if (!inTabBar(m.target)) {
          return holdsTabBar(m.addedNodes) || holdsTabBar(m.removedNodes);
        }
        var all = Array.prototype.slice.call(m.addedNodes).concat(Array.prototype.slice.call(m.removedNodes));
        return all.length === 0 || !all.every(ours);
      }
      return inTabBar(m.target); // characterData: a tab's name changed
    }

    function start() {
      if (!document.body || !document.head) {
        setTimeout(start, 100);
        return;
      }
      if (!document.getElementById('tab-groups-patch-style')) {
        var style = el('style');
        style.id = 'tab-groups-patch-style';
        style.textContent = CSS;
        document.head.appendChild(style);
      }

      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (relevant(mutations[i])) {
            schedule();
            return;
          }
        }
      }).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'aria-label'],
        attributeOldValue: true,
      });
      // The theme's colors (and `workbench.colorCustomizations`) are a style sheet in <head>.
      new MutationObserver(themeChanged).observe(document.head, { subtree: true, childList: true, characterData: true });
      window.addEventListener('resize', schedule);
      // A closed window says goodbye to the extension at once.
      window.addEventListener('pagehide', function () {
        if (ws) {
          ws.close();
        }
      });
      connect();
      schedule();
    }

    start();
  }
})();
