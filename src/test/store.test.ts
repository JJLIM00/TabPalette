import * as assert from 'assert';
import { STORAGE_KEY, GroupStore, StateStorage } from '../store';

/** In-memory stand-in for VS Code's workspaceState. */
class FakeStorage implements StateStorage {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }
}

const file = (name: string) => `file:///ws/${name}`;
const A = file('a.ts');
const B = file('b.ts');
const C = file('c.ts');

/** Member file names of a group, e.g. ['a.ts', 'b.ts']. */
function members(store: GroupStore, id: string): string[] {
  return store.get(id)!.uris.map((u) => u.slice(u.lastIndexOf('/') + 1));
}

suite('Group store', () => {
  let store: GroupStore;
  setup(() => {
    store = new GroupStore(new FakeStorage());
  });

  suite('creating groups', () => {
    test('new groups get the next unused color slot (color1, color2 … Chrome\'s order by default)', () => {
      assert.strictEqual(store.create('Main').color, 'color1');
      assert.strictEqual(store.create('Work').color, 'color2');
      assert.strictEqual(store.create('Bugs', 'color3').color, 'color3');
      assert.strictEqual(store.nextColor(), 'color4');
    });

    test('colors start over once all nine are used', () => {
      for (let i = 0; i < 9; i++) {
        store.create(`G${i}`);
      }
      assert.strictEqual(store.nextColor(), 'color1');
    });

    test('names are trimmed when created, but kept as typed when renamed (so live typing keeps spaces)', () => {
      const g = store.create('  Main  ');
      assert.strictEqual(store.get(g.id)!.name, 'Main');
      store.rename(g.id, 'My ');
      assert.strictEqual(store.get(g.id)!.name, 'My ');
    });

    test('a new group starts expanded and open', () => {
      const g = store.create('Main');
      assert.strictEqual(g.collapsed, false);
      assert.strictEqual(g.closed, false);
    });
  });

  suite('tabs in groups', () => {
    test('a file belongs to at most one group: adding it elsewhere moves it', () => {
      const main = store.create('Main', 'color1', [A, B]);
      const work = store.create('Work', 'color2', [B]);
      assert.deepStrictEqual(members(store, main.id), ['a.ts']);
      assert.deepStrictEqual(members(store, work.id), ['b.ts']);

      store.addUris(work.id, [A]);
      assert.strictEqual(store.groupOf(A)!.id, work.id);
    });

    test('a group whose last tab moves to another group is deleted', () => {
      const main = store.create('Main', 'color1', [A]);
      const work = store.create('Work', 'color2', [B]);
      store.addUris(work.id, [A]);
      assert.strictEqual(store.get(main.id), undefined, 'Main had no tabs left');
      assert.deepStrictEqual(members(store, work.id), ['b.ts', 'a.ts']);
    });

    test('a group whose last tab goes into a new group is deleted', () => {
      const main = store.create('Main', 'color1', [A]);
      const fresh = store.create('Fresh', 'color2', [A]);
      assert.strictEqual(store.get(main.id), undefined);
      assert.deepStrictEqual(members(store, fresh.id), ['a.ts']);
    });

    test('a group that still has tabs, a closed group, and other empty groups are not touched', () => {
      const main = store.create('Main', 'color1', [A, B]);
      const closed = store.create('Closed', 'color3', [C]);
      store.setClosed(closed.id, true);
      const empty = store.create('Empty');
      const work = store.create('Work', 'color2');
      store.addUris(work.id, [A, C]);
      assert.deepStrictEqual(members(store, main.id), ['b.ts']);
      assert.ok(store.get(closed.id), 'a closed group is kept until it is reopened or deleted');
      assert.ok(store.get(empty.id), 'only groups emptied by this move are deleted');
    });

    test('a tab can be inserted before a given member, or reordered inside its group', () => {
      const g = store.create('Main', 'color1', [A, B]);
      store.addUris(g.id, [C], B);
      assert.deepStrictEqual(members(store, g.id), ['a.ts', 'c.ts', 'b.ts']);
      store.addUris(g.id, [B], A);
      assert.deepStrictEqual(members(store, g.id), ['b.ts', 'a.ts', 'c.ts']);
    });

    test('removing tabs leaves an empty group until it is pruned', () => {
      const g = store.create('Main', 'color1', [A]);
      store.removeUris([A]);
      assert.deepStrictEqual(members(store, g.id), []);
      store.pruneEmpty();
      assert.strictEqual(store.get(g.id), undefined);
    });

    test('pruning keeps a closed group even though none of its tabs are open', () => {
      const open = store.create('Open', 'color1', [A]);
      const closed = store.create('Closed', 'color2', [B]);
      store.setClosed(closed.id, true);
      store.removeUris([A]);
      store.pruneEmpty();
      assert.strictEqual(store.get(open.id), undefined);
      assert.ok(store.get(closed.id));
    });
  });

  suite('group state', () => {
    test('rename, recolor, collapse and close are saved on the group', () => {
      const g = store.create('Main', 'color1', [A]);
      store.rename(g.id, 'Work');
      store.setColor(g.id, 'color7');
      store.setCollapsed(g.id, true);
      assert.deepStrictEqual(
        { name: store.get(g.id)!.name, color: store.get(g.id)!.color, collapsed: store.get(g.id)!.collapsed },
        { name: 'Work', color: 'color7', collapsed: true },
      );
    });

    test('closing a group clears its collapsed state (it reopens expanded)', () => {
      const g = store.create('Main', 'color1', [A]);
      store.setCollapsed(g.id, true);
      store.setClosed(g.id, true);
      assert.strictEqual(store.get(g.id)!.closed, true);
      assert.strictEqual(store.get(g.id)!.collapsed, false);
    });

    test('every change notifies listeners (the tab bar redraws on it)', () => {
      let changes = 0;
      store.onDidChange(() => changes++);
      const g = store.create('G');
      store.rename(g.id, 'H');
      store.setColor(g.id, 'color3');
      store.remove(g.id);
      assert.strictEqual(changes, 4);
    });
  });

  suite('file renames and deletes', () => {
    test('a renamed file or folder keeps its group membership', () => {
      const g = store.create('G', 'color1', [file('src/x.ts'), file('srcx/y.ts'), A]);
      store.renameUri(file('src'), file('lib'));
      store.renameUri(A, file('a2.ts'));
      assert.deepStrictEqual(store.get(g.id)!.uris, [file('lib/x.ts'), file('srcx/y.ts'), file('a2.ts')]);
    });

    test('deleting a folder removes the files inside it from their groups', () => {
      const g = store.create('G', 'color1', [file('src/x.ts'), A]);
      store.removeUriTree(file('src'));
      assert.deepStrictEqual(members(store, g.id), ['a.ts']);
    });
  });

  suite('saving per workspace', () => {
    test('groups are saved and come back after a reload', () => {
      const storage = new FakeStorage();
      const first = new GroupStore(storage);
      const g = first.create('Main', 'color1', [A]);
      first.rename(g.id, 'Renamed');
      first.setColor(g.id, 'color7');
      first.setCollapsed(g.id, true);

      assert.deepStrictEqual(new GroupStore(storage).all(), [
        { id: g.id, name: 'Renamed', color: 'color7', uris: [A], collapsed: true, closed: false },
      ]);
    });

    test('damaged saved data is repaired on load instead of breaking the extension', () => {
      const storage = new FakeStorage();
      storage.data.set(STORAGE_KEY, [
        { id: 'g1', name: 'One', color: 'not-a-color', uris: [A, A, 5] },
        { id: 'g2', uris: [A, B] },
        { name: 'no id' },
        null,
      ]);
      assert.deepStrictEqual(new GroupStore(storage).all(), [
        { id: 'g1', name: 'One', color: 'color1', uris: [A], collapsed: false, closed: false },
        { id: 'g2', name: '', color: 'color1', uris: [B], collapsed: false, closed: false },
      ]);
    });
  });
});
