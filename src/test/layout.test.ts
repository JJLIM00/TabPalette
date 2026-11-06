import * as assert from 'assert';
import { groupInsertIndex, positionAfterGroup } from '../layout';

/*
 * Tab rows are written as short pictures: 'x G1 G2 y z'.
 * Tabs starting with G are the group being moved or edited; the rest are other tabs.
 */
const tabs = (row: string) => row.split(' ');
const inGroup = (tab: string) => tab.startsWith('G');

/** Number of other tabs that end up before the group when its chip is dropped before tab number `dropIndex`. */
const othersBeforeGroup = (row: string, dropIndex: number) => groupInsertIndex(tabs(row), inGroup, dropIndex);

/** Position (index) a removed tab `r` moves to, or undefined when it can stay. */
const whereRemovedTabGoes = (row: string) => positionAfterGroup(tabs(row), 'r', inGroup);

suite('Group layout rules', () => {
  suite('dragging a group chip', () => {
    test('dropped before the first tab: the group becomes first', () => {
      assert.strictEqual(othersBeforeGroup('x G1 G2 y z', 0), 0);
    });

    test('dropped between later tabs: the group lands there', () => {
      assert.strictEqual(othersBeforeGroup('x G1 G2 y z', 4), 2, 'x y G1 G2 z');
    });

    test('dropped past the last tab: the group becomes last', () => {
      assert.strictEqual(othersBeforeGroup('x G1 G2 y z', 5), 3, 'x y z G1 G2');
    });

    test('dropped on itself or right where it already is: nothing moves', () => {
      assert.strictEqual(othersBeforeGroup('x G1 G2 y z', 1), undefined);
      assert.strictEqual(othersBeforeGroup('x G1 G2 y z', 3), undefined);
    });
  });

  suite('removing a tab from a group', () => {
    test('a tab removed from the middle moves just past the group, so the group stays in one piece', () => {
      assert.strictEqual(whereRemovedTabGoes('x G1 r G2 G3 y'), 4, 'x G1 G2 G3 r y');
    });

    test('a tab already at the edge of the group stays where it is', () => {
      assert.strictEqual(whereRemovedTabGoes('G1 G2 r y'), undefined);
      assert.strictEqual(whereRemovedTabGoes('r G1'), undefined);
    });

    test('a tab that is not in this row is ignored', () => {
      assert.strictEqual(whereRemovedTabGoes('G1'), undefined);
    });
  });
});
