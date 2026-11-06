import * as assert from 'assert';
import { droppedNextToGroup, droppedOutOfGroup, groupInsertIndex, positionAfterGroup } from '../layout';

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

  suite('dropping a tab onto a group', () => {
    /** Finds the dropped tab `x` next to group G in `row` (labels and URIs are the same here). */
    const dropped = (row: string) =>
      droppedNextToGroup(
        tabs(row).map((t) => ({ label: t, uri: t })),
        'x',
        inGroup,
      );

    test('dropped after a group of one tab: it joins at the end', () => {
      assert.deepStrictEqual(dropped('a G1 x b'), { uri: 'x', before: undefined });
    });

    test('dropped in front of a group of one tab (between chip and tab): it joins at the start', () => {
      assert.deepStrictEqual(dropped('a x G1 b'), { uri: 'x', before: 'G1' });
    });

    test('not next to the group (yet): nothing to join', () => {
      assert.strictEqual(dropped('x a G1 b'), undefined);
    });

    test('a tab that is already in the group is not "dropped onto" it (when joining)', () => {
      assert.strictEqual(droppedNextToGroup([{ label: 'x', uri: 'G-x' }, { label: 'g', uri: 'G1' }], 'x', inGroup), undefined);
    });
  });

  suite('dropping grouped tabs outside their group', () => {
    /** Which of the dragged tabs (`dragged`, space-separated) leave their group (labels and URIs are the same here). */
    const leaving = (row: string, dragged: string) =>
      droppedOutOfGroup(
        tabs(row).map((t) => ({ label: t, uri: t })),
        tabs(dragged),
        inGroup,
      ).join(' ');

    test("the group's last tab dragged right (order unchanged) leaves the group", () => {
      assert.strictEqual(leaving('a G1 G2 b', 'G2'), 'G2');
      assert.strictEqual(leaving('a G1 G2', 'G2'), 'G2', 'also when the group is at the end of the tab bar');
    });

    test("the group's first tab dropped in front of the chip leaves the group", () => {
      assert.strictEqual(leaving('a G1 G2', 'G1'), 'G1');
    });

    test("a group's only tab keeps its group (it carries the group along)", () => {
      assert.strictEqual(leaving('a G1 b', 'G1'), '');
    });

    test('a tab that ended up between two of its group mates stays in the group', () => {
      assert.strictEqual(leaving('G1 G2 G3', 'G2'), '');
    });

    test('several selected tabs dragged out together all leave the group', () => {
      assert.strictEqual(leaving('G1 a G2 G3', 'G2 G3'), 'G2 G3');
    });

    test("dragging all of a group's tabs together keeps the group (they carry it along)", () => {
      assert.strictEqual(leaving('a G1 G2 b', 'G1 G2'), '');
    });

    test('ungrouped tabs in the selection are ignored', () => {
      assert.strictEqual(leaving('G1 G2 a b', 'G2 a'), 'G2');
    });
  });
});
