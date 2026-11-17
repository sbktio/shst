import assert from 'node:assert/strict';

/** `items[index]`, failing the test when there is no item there. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `no item at index ${index} of ${items.length}`);
  return item;
}
