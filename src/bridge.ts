import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';
import { GroupStore } from './store';
import { tabUri } from './tabs';

/**
 * Connects this window's extension host to the workbench patch script running in
 * the same window's UI (resources/patch/tab-groups-patch.js).
 *
 * - Server: WebSocket on 127.0.0.1, random port. Accepts only VS Code's own window
 *   origin and clients that send the per-session secret token first.
 * - Handshake: port + token are published to *this window only* as the
 *   accessibility label of a hidden status bar item, which the patch reads from the DOM.
 * - Extension → UI: `state` (groups + each tab row's labels and group ids).
 * - UI → extension: `action` messages (collapse, rename, color, close, …), and
 *   `tabSelection` (the selected tabs of every tab row, sent whenever they change).
 * - Extension → UI, for the side bar: `click` (Ctrl/Shift+click a tab, to select it).
 */

export const BRIDGE_LABEL_PREFIX = 'tab-groups-bridge:';
export const WORKBENCH_ORIGIN = 'vscode-file://vscode-app';

export interface UiAction {
  type: 'action';
  action: string;
  groupId: string;
  value?: unknown;
}

export interface UiState {
  type: 'state';
  groups: { id: string; name: string; color: string; collapsed: boolean }[];
  rows: { tabs: { label: string; group: string | null }[] }[];
}

export function buildState(store: GroupStore, rows: readonly vscode.TabGroup[]): UiState {
  return {
    type: 'state',
    groups: store
      .all()
      .filter((g) => !g.closed)
      .map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed })),
    rows: rows.map((row) => ({
      tabs: row.tabs.map((t) => {
        const uri = tabUri(t)?.toString();
        return { label: t.label, group: (uri && store.groupOf(uri)?.id) || null };
      }),
    })),
  };
}

export class Bridge implements vscode.Disposable {
  readonly token = crypto.randomBytes(24).toString('hex');
  private server: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  private item: vscode.StatusBarItem | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The selected tabs of each tab row, kept up to date by the tab bar (positions in the row). */
  private tabSelection = new Map<number, number[]>();
  private readonly selectionEmitter = new vscode.EventEmitter<void>();
  /** The tab bar's selection changed (see selectedIndexes). */
  readonly onDidChangeSelection = this.selectionEmitter.event;

  constructor(
    private readonly store: GroupStore,
    private readonly onAction: (action: UiAction) => unknown,
    private readonly rows: () => readonly vscode.TabGroup[] = () => vscode.window.tabGroups.all,
  ) {}

  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  get connections(): number {
    return this.clients.size;
  }

  /**
   * The tabs (URI strings) a "selected tabs" command applies to, for the tab `anchor` it is
   * run on: all the selected tabs of its row when `anchor` is one of them, else just
   * `anchor`, like VS Code's own tab commands. Undefined when the tab bar has not reported
   * that row; callers then fall back to other ways.
   */
  selectedUris(anchor: string): string[] | undefined {
    const rows = this.rows();
    for (const [index, selected] of this.tabSelection) {
      const row = rows[index];
      const uris = row ? row.tabs.map((t) => tabUri(t)?.toString()) : [];
      if (uris.includes(anchor)) {
        const chosen = selected.map((i) => uris[i]).filter((u): u is string => !!u);
        return chosen.includes(anchor) ? chosen : [anchor];
      }
    }
    return undefined;
  }

  /** Positions of the tabs selected in the tab bar in tab row `row` (the active tab counts as selected). */
  selectedIndexes(row: number): number[] {
    return this.tabSelection.get(row) ?? [];
  }

  /** Clicks a tab in the tab bar with Ctrl or Shift held, so VS Code selects it (from the side bar). */
  clickTab(row: number, index: number, label: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean }): void {
    this.sendAll(JSON.stringify({ type: 'click', row, index, label, ctrl: !!modifiers.ctrl, meta: !!modifiers.meta, shift: !!modifiers.shift }));
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      maxPayload: 64 * 1024,
      verifyClient: (info: { origin: string }) => info.origin === WORKBENCH_ORIGIN,
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    server.on('connection', (socket) => this.accept(socket));

    this.subscriptions.push(
      this.store.onDidChange(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
    );

    const item = vscode.window.createStatusBarItem('tabPalette.bridge', vscode.StatusBarAlignment.Right, -100000);
    item.name = 'TabPalette (connection for group chips)';
    // Must have text to be rendered; the patch CSS hides it.
    item.text = '$(layers)';
    item.accessibilityInformation = { label: `${BRIDGE_LABEL_PREFIX}${this.port}:${this.token}`, role: 'none' };
    item.show();
    this.item = item;
  }

  private accept(socket: WebSocket): void {
    let authed = false;
    const timeout = setTimeout(() => !authed && socket.close(1008, 'auth timeout'), 5000);
    socket.on('message', (data) => {
      let msg: { type?: string; token?: string; action?: string; groupId?: string; value?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authed) {
        const ok =
          msg.type === 'hello' &&
          typeof msg.token === 'string' &&
          msg.token.length === this.token.length &&
          crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(this.token));
        if (!ok) {
          socket.close(1008, 'bad token');
          return;
        }
        authed = true;
        clearTimeout(timeout);
        this.clients.add(socket);
        socket.send(JSON.stringify(buildState(this.store, this.rows())));
        return;
      }
      if (msg.type === 'tabSelection') {
        const rows = Array.isArray(msg.rows) ? (msg.rows as { row?: unknown; indexes?: unknown }[]) : [];
        this.tabSelection = new Map(
          rows
            .filter((r) => Number.isInteger(r?.row) && Array.isArray(r.indexes))
            .map((r) => [r.row as number, (r.indexes as unknown[]).filter((i): i is number => Number.isInteger(i) && (i as number) >= 0)]),
        );
        this.selectionEmitter.fire();
        return;
      }
      if (msg.type === 'action' && typeof msg.action === 'string' && typeof msg.groupId === 'string') {
        try {
          void Promise.resolve(this.onAction(msg as UiAction)).catch((err) => console.error('[TabPalette] action failed', err));
        } catch (err) {
          console.error('[TabPalette] action failed', err);
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      this.clients.delete(socket);
      if (this.clients.size === 0 && this.tabSelection.size > 0) {
        this.tabSelection.clear();
        this.selectionEmitter.fire();
      }
    });
    socket.on('error', () => socket.close());
  }

  /** Sends fresh state to the UI (debounced; tab events come in bursts). */
  schedule(): void {
    if (this.clients.size === 0) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.broadcast();
    }, 20);
  }

  /** Asks the UI to open the group editor bubble on this group's chip (Chrome does this for new groups). */
  requestEdit(groupId: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.broadcast();
    this.sendAll(JSON.stringify({ type: 'edit', groupId }));
  }

  /** Sends the state to the tab bar, unless it already has this exact state (it would redraw for nothing). */
  broadcast(): void {
    if (this.clients.size === 0) {
      return;
    }
    const message = JSON.stringify(buildState(this.store, this.rows()));
    if (message !== this.lastState) {
      this.lastState = message;
      this.sendAll(message);
    }
  }

  private lastState: string | undefined;

  private sendAll(message: string): void {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.subscriptions.forEach((d) => d.dispose());
    this.selectionEmitter.dispose();
    this.item?.dispose();
    for (const client of this.clients) {
      client.close();
    }
    this.server?.close();
  }
}
