import * as assert from 'assert';
import { decideMembership, movedItem } from '../membership';

/*
 * Tab rows are written as short pictures: 'A1 A2 x A3'.
 * Tabs named with a capital letter belong to that group (A1, A2 → group A);
 * lowercase tabs (x, y, new) are not in any group.
 */
const tabs = (row: string) => row.split(' ');
const groupOf = (tab: string) => (/^[A-Z]/.test(tab) ? tab[0] : undefined);

/** What happens to `tab` after it was dropped where it is in `row`. */
function afterDrop(row: string, tab: string, isNewTab = false) {
  const order = tabs(row);
  return decideMembership(order, order.indexOf(tab), groupOf, !isNewTab);
}

suite('Drag and drop rules (like Chrome)', () => {
  suite('finding which tab was dragged', () => {
    test('finds the one tab that moved', () => {
      assert.strictEqual(movedItem(tabs('a b c x'), tabs('a x b c')), 'x');
      assert.strictEqual(movedItem(tabs('x a b'), tabs('a b x')), 'x');
    });

    test('nothing moved, a tab closed, or several tabs moved: no single dragged tab', () => {
      assert.strictEqual(movedItem(tabs('a b'), tabs('a b')), undefined);
      assert.strictEqual(movedItem(tabs('a b c'), tabs('a b')), undefined);
      assert.strictEqual(movedItem(tabs('a b c d'), tabs('b a d c')), undefined);
    });

    test('when two neighbours swap, the active tab is the one that was dragged', () => {
      assert.strictEqual(movedItem(tabs('a b'), tabs('b a'), 'a'), 'a');
      assert.strictEqual(movedItem(tabs('a b'), tabs('b a'), 'b'), 'b');
    });
  });

  suite('joining a group', () => {
    test('dropping a tab between two tabs of a group adds it to the group', () => {
      assert.deepStrictEqual(afterDrop('A1 x A2', 'x'), { join: 'A' });
    });

    test('dropping a tab from another group between them moves it to this group', () => {
      assert.deepStrictEqual(afterDrop('A1 B1 A2 B2', 'B1'), { join: 'A' });
    });

    test('dropping next to a group (at its edge) does not add it', () => {
      assert.strictEqual(afterDrop('A1 A2 x', 'x'), undefined);
      assert.strictEqual(afterDrop('x A1 A2', 'x'), undefined);
    });

    test('a newly opened tab that lands inside a group joins it', () => {
      assert.deepStrictEqual(afterDrop('A1 new A2', 'new', true), { join: 'A' });
    });
  });

  suite('leaving a group', () => {
    test('dragging a tab away from all its group mates removes it from the group', () => {
      assert.deepStrictEqual(afterDrop('A1 A2 x A3', 'A3'), { leave: 'A' });
      assert.deepStrictEqual(afterDrop('A3 x A1 A2', 'A3'), { leave: 'A' });
    });

    test('moving a tab around inside its own group keeps it in the group', () => {
      assert.strictEqual(afterDrop('A2 A1 A3 x', 'A2'), undefined);
    });

    test('the only tab of a group keeps its group wherever it goes', () => {
      assert.strictEqual(afterDrop('x B1 y', 'B1'), undefined);
    });

    test('a newly opened tab never counts as leaving a group', () => {
      assert.strictEqual(afterDrop('A1 A2 x A3', 'A3', true), undefined);
    });
  });
});
