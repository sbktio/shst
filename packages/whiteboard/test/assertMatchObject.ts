import assert from 'node:assert/strict';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Partial deep match with the semantics of a `toMatchObject` matcher: every key
 * in `expected` must be present on `actual` and deep-match it, recursively;
 * extra keys on `actual` are ignored. Arrays must match length and elements.
 * Stands in for `assert.partialDeepStrictEqual`, which is experimental on Node 22.
 */
export function assertMatchObject(
  actual: unknown,
  expected: unknown,
  path = 'actual'
): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} should be an array`);
    assert.strictEqual(actual.length, expected.length, `${path}.length`);
    expected.forEach((item: unknown, index) =>
      assertMatchObject(actual[index], item, `${path}[${index}]`)
    );
    return;
  }
  if (isPlainObject(expected)) {
    assert.ok(
      typeof actual === 'object' && actual !== null,
      `${path} should be an object`
    );
    const record = actual as Record<string, unknown>;
    for (const key of Object.keys(expected)) {
      assert.ok(key in record, `${path}.${key} is missing`);
      assertMatchObject(record[key], expected[key], `${path}.${key}`);
    }
    return;
  }
  assert.deepStrictEqual(actual, expected, path);
}
