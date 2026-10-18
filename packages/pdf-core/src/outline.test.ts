import { describe, expect, it } from 'vitest';
import {
  MAX_OUTLINE_ITEMS,
  resolveDestination,
  resolveOutline,
  type RawOutlineNode,
} from './outline';

const resolver = {
  pageCount: 10,
  getDestination: async (name: string) =>
    name === 'known' ? [{ num: 7, gen: 0 }, { name: 'Fit' }] : null,
  getPageIndex: async (ref: { num: number }) => (ref.num === 7 ? 3 : ref.num === 99 ? 50 : 0),
};

describe('resolveDestination', () => {
  it('handles named, explicit and numeric targets', async () => {
    expect(await resolveDestination('known', resolver)).toEqual({
      pageIndex: 3,
      left: null,
      top: null,
    });
    expect(await resolveDestination('missing', resolver)).toEqual({
      pageIndex: null,
      left: null,
      top: null,
    });
    expect(
      await resolveDestination([{ num: 7, gen: 0 }, { name: 'FitR' }, 1, 2, 3, 4], resolver),
    ).toEqual({
      pageIndex: 3,
      left: 1,
      top: 4,
    });
    expect(await resolveDestination([2, { name: 'XYZ' }, null, 300, 0], resolver)).toEqual({
      pageIndex: 2,
      left: null,
      top: 300,
    });
  });

  it('rejects destinations outside the document and malformed ones', async () => {
    expect(
      (await resolveDestination([{ num: 99, gen: 0 }, { name: 'Fit' }], resolver)).pageIndex,
    ).toBeNull();
    expect((await resolveDestination([-1, { name: 'Fit' }], resolver)).pageIndex).toBeNull();
    expect((await resolveDestination(['bogus'], resolver)).pageIndex).toBeNull();
    expect((await resolveDestination(null, resolver)).pageIndex).toBeNull();
    const throwing = { ...resolver, getPageIndex: () => Promise.reject(new Error('bad ref')) };
    expect((await resolveDestination([{ num: 1, gen: 0 }], throwing)).pageIndex).toBeNull();
  });
});

describe('resolveOutline', () => {
  it('caps hostile outlines', async () => {
    const node = (title: string): RawOutlineNode => ({ title, dest: null, url: null, items: [] });
    const huge = Array.from({ length: MAX_OUTLINE_ITEMS + 100 }, (_, index) => node(`${index}`));
    const resolved = await resolveOutline(huge, resolver);
    expect(resolved).toHaveLength(MAX_OUTLINE_ITEMS);

    let deep: RawOutlineNode = node('leaf');
    for (let depth = 0; depth < 40; depth += 1) deep = { ...node(`${depth}`), items: [deep] };
    let depth = 0;
    let current = (await resolveOutline([deep], resolver))[0];
    while (current?.children[0]) {
      current = current.children[0];
      depth += 1;
    }
    expect(depth).toBeLessThan(20);
  });

  it('cleans titles', async () => {
    const [item] = await resolveOutline(
      [{ title: ' Title\u0000 ', dest: null, url: null, items: [], bold: true }],
      resolver,
    );
    expect(item).toMatchObject({ title: 'Title', bold: true, italic: false });
  });
});
