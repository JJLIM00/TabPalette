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
 *   `selection` (which tabs are selected, sent when a tab is right-clicked).
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
  /** The tab selection the tab bar last reported (tab row + positions of the selected tabs). */
  private selection: { row: number; indexes: number[]; at: number } | undefined;

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
   * The selected tabs (URI strings), as the tab bar reported them when a tab was just
   * right-clicked. Undefined when there is no recent report, or `anchor` (the tab the
   * command is for) is not part of it; callers then fall back to other ways.
   */
  selectedUris(anchor: string, maxAgeMs = 60_000): string[] | undefined {
    const s = this.selection;
    const row = s ? this.rows()[s.row] : undefined;
    if (!s || !row || Date.now() - s.at > maxAgeMs) {
      return undefined;
    }
    const uris = s.indexes.map((i) => (row.tabs[i] ? tabUri(row.tabs[i])?.toString() : undefined)).filter((u): u is string => !!u);
    return uris.includes(anchor) ? uris : undefined;
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
      let msg: { type?: string; token?: string; action?: string; groupId?: string; value?: unknown; row?: unknown; indexes?: unknown };
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
      if (msg.type === 'selection') {
        const indexes = Array.isArray(msg.indexes) ? msg.indexes.filter((i): i is number => Number.isInteger(i) && i >= 0) : [];
        if (Number.isInteger(msg.row) && indexes.length > 0) {
          this.selection = { row: msg.row as number, indexes, at: Date.now() };
        }
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
    });
    socket.on('error', () => socket.close());
  }

  /** Sends fresh state to the UI (debounced; tab events come in bursts). */
  schedule(): void {
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
    const message = JSON.stringify({ type: 'edit', groupId });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  broadcast(): void {
    if (this.clients.size === 0) {
      return;
    }
    const message = JSON.stringify(buildState(this.store, this.rows()));
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
    this.item?.dispose();
    for (const client of this.clients) {
      client.close();
    }
    this.server?.close();
  }
}
