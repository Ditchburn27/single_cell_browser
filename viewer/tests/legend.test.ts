import { describe, it, expect } from 'vitest';
import { toggleHidden, isolate } from '../src/state/legend';

const vis = (hidden: Set<number>, n: number) => [...Array(n).keys()].filter((k) => !hidden.has(k));

describe('legend visibility', () => {
  it('click hides a group, clicking it again brings it back', () => {
    const h = new Set<number>();
    toggleHidden(h, 2, 5); expect(vis(h, 5)).toEqual([0, 1, 3, 4]);
    toggleHidden(h, 2, 5); expect(vis(h, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('hiding the last visible group shows all of them instead', () => {
    const h = new Set([0, 1, 2, 3]);           // only group 4 left
    toggleHidden(h, 4, 5);
    expect(vis(h, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('that rule only applies to the final one, not the second to last', () => {
    const h = new Set([0, 1, 2]);              // groups 3 and 4 visible
    toggleHidden(h, 3, 5);
    expect(vis(h, 5)).toEqual([4]);
  });

  it('double-click isolates a single group', () => {
    const h = new Set<number>();
    isolate(h, 1, 4);
    expect(vis(h, 4)).toEqual([1]);
  });

  it('double-clicking the already isolated group restores the full set', () => {
    const h = new Set<number>();
    isolate(h, 1, 4); expect(vis(h, 4)).toEqual([1]);
    isolate(h, 1, 4); expect(vis(h, 4)).toEqual([0, 1, 2, 3]);
  });

  it('isolating a different group while one is isolated switches to it', () => {
    const h = new Set<number>();
    isolate(h, 1, 4);
    isolate(h, 3, 4);
    expect(vis(h, 4)).toEqual([3]);
  });

  it('isolate after hand-hiding some groups still leaves exactly one', () => {
    const h = new Set([0]);
    isolate(h, 2, 4);
    expect(vis(h, 4)).toEqual([2]);
  });
});
