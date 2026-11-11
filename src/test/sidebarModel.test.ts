import * as assert from 'assert';
import { DropTarget, groupDropIndex, moveItem, planTabDrop, planTabsDrop } from '../sidebarModel';

/*
 * Tab rows are written as short pictures: 'x A1 A2 y'. Tabs starting with a capital letter
 * are in the group of that letter (A1 and A2 are in group A); lowercase tabs are in no group;
 * '#s' is a tab that is not a file (e.g. Settings).
 */
const row = (picture: string) => picture.split(' ');
const groupOf = (tab: string) => (/^[A-Z]/.test(tab) ? tab[0] : undefined);

/** The row after dropping `tab` on `target`, and the group the tab ends up in. */
function drop(picture: string, tab: string, target: DropTarget): { row: string; group: string | undefined } | 'nothing changes' {
  const tabs = row(picture);
  const plan = planTabDrop(tabs, tabs.indexOf(tab), target, groupOf);
  return plan ? { row: moveItem(tabs, tabs.indexOf(tab), plan.to).join(' '), group: plan.group } : 'nothing changes';
}
const on = (picture: string, tab: string, after = false): DropTarget => ({ index: row(picture).indexOf(tab), after });

suite('Side bar drop rules', () => {
  suite('dragging a tab', () => {
    test('dropped on a tab of a group: it joins that group, at that spot', () => {
      const r = 'x A1 A2 y';
      assert.deepStrictEqual(drop(r, 'y', on(r, 'A2')), { row: 'x A1 y A2', group: 'A' });
      assert.deepStrictEqual(drop(r, 'x', on(r, 'A2', true)), { row: 'A1 A2 x y', group: 'A' });
    });

    test("dropped on a group's header: it joins the group as its first tab", () => {
      assert.deepStrictEqual(drop('x A1 A2 y', 'y', { header: 'A' }), { row: 'x y A1 A2', group: 'A' });
    });

    test('a grouped tab dropped next to an ungrouped tab leaves its group', () => {
      const r = 'x A1 A2 y';
      assert.deepStrictEqual(drop(r, 'A1', on(r, 'y', true)), { row: 'x A2 y A1', group: undefined });
    });

    test('dropped below all tabs: it goes last and leaves its group', () => {
      assert.deepStrictEqual(drop('x A1 A2 y', 'A2', { end: true }), { row: 'x A1 y A2', group: undefined });
    });

    test("a group's only tab keeps its group wherever it goes (the group moves with it)", () => {
      const r = 'x A1 y z';
      assert.deepStrictEqual(drop(r, 'A1', on(r, 'z', true)), { row: 'x y z A1', group: 'A' });
    });

    test('a grouped tab dropped on another group moves to that group', () => {
      const r = 'A1 A2 B1 B2';
      assert.deepStrictEqual(drop(r, 'A1', on(r, 'B2', true)), { row: 'A2 B1 B2 A1', group: 'B' });
    });

    test('reordering inside its own group keeps the group', () => {
      const r = 'A1 A2 A3';
      assert.deepStrictEqual(drop(r, 'A3', on(r, 'A1')), { row: 'A3 A1 A2', group: 'A' });
    });

    test('a tab that is not a file moves, but never joins a group', () => {
      const r = '#s A1 A2';
      assert.deepStrictEqual(drop(r, '#s', on(r, 'A2', true)), { row: 'A1 A2 #s', group: undefined });
    });

    test('dropped where it already is: nothing changes', () => {
      const r = 'x A1 y';
      assert.strictEqual(drop(r, 'y', on(r, 'y')), 'nothing changes');
      assert.strictEqual(drop(r, 'y', { end: true }), 'nothing changes');
    });
  });

  suite('dragging several selected tabs', () => {
    /** The row after dropping `tabs` together on `target`, the group they join, and the tabs that leave a group. */
    function dropAll(picture: string, tabs: string[], target: DropTarget) {
      const r = row(picture);
      const plan = planTabsDrop(r, tabs.map((t) => r.indexOf(t)), target, groupOf);
      return plan ? { row: plan.order.join(' '), group: plan.group, leaving: plan.leaving.join(' ') } : 'nothing changes';
    }

    test('dropped on a tab of a group: they all join it, side by side, in their row order', () => {
      const r = 'x A1 A2 y z';
      assert.deepStrictEqual(dropAll(r, ['z', 'x'], on(r, 'A2')), { row: 'A1 x z A2 y', group: 'A', leaving: '' });
    });

    test("dropped on a group's header: they become the group's first tabs", () => {
      assert.deepStrictEqual(dropAll('x A1 y z', ['y', 'z'], { header: 'A' }), { row: 'x y z A1', group: 'A', leaving: '' });
    });

    test('grouped tabs dropped outside their group leave it', () => {
      const r = 'A1 A2 A3 x';
      assert.deepStrictEqual(dropAll(r, ['A1', 'A3'], on(r, 'x', true)), { row: 'A2 x A1 A3', group: undefined, leaving: 'A1 A3' });
    });

    test('all of a group’s tabs dragged together carry the group along', () => {
      const r = 'A1 A2 x y';
      assert.deepStrictEqual(dropAll(r, ['A1', 'A2'], { end: true }), { row: 'x y A1 A2', group: undefined, leaving: '' });
    });

    test('tabs that are not files move along but never join a group', () => {
      const r = 'x #s A1';
      assert.deepStrictEqual(dropAll(r, ['x', '#s'], on(r, 'A1', true)), { row: 'A1 x #s', group: 'A', leaving: '' });
    });

    test('dropped on one of the dragged tabs, or where they already are: nothing changes', () => {
      const r = 'x y z';
      assert.strictEqual(dropAll(r, ['x', 'y'], on(r, 'y')), 'nothing changes');
      assert.strictEqual(dropAll(r, ['y', 'z'], { end: true }), 'nothing changes');
    });
  });

  suite('dragging a group by its header', () => {
    const before = (picture: string, target: DropTarget) => groupDropIndex(row(picture), target, groupOf);

    test('dropped on an ungrouped tab: before or after that tab', () => {
      const r = 'x A1 A2 y';
      assert.strictEqual(before(r, on(r, 'x')), 0);
      assert.strictEqual(before(r, on(r, 'y', true)), 4);
    });

    test('dropped on a tab of another group: before or after that whole group', () => {
      const r = 'B1 B2 x A1';
      assert.strictEqual(before(r, on(r, 'B2')), 0, 'never inside group B');
      assert.strictEqual(before(r, on(r, 'B1', true)), 2);
    });

    test("dropped on another group's header or below all tabs", () => {
      const r = 'x B1 B2 A1';
      assert.strictEqual(before(r, { header: 'B' }), 1);
      assert.strictEqual(before(r, { end: true }), 4);
    });
  });
});
