import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  WhiteboardDocument,
  WhiteboardObject,
  WhiteboardOperation,
} from '../src/types.ts';
import { applyWhiteboardOperations } from '../src/operations.ts';
import { assertMatchObject } from './assertMatchObject.ts';
import { at } from './at.ts';

const actor = { id: 'alice', name: 'Alice' };
const board = (): WhiteboardDocument => ({
  id: 'sketches',
  title: 'Sketches',
  revision: 0,
  objects: [],
  timer: { endAt: null, remaining: 300 },
});
const object = (): WhiteboardObject => ({
  id: 'stroke',
  kind: 'drawing',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  color: 'cream',
  text: '',
  fontSize: 20,
  author: 'Untrusted',
  votes: {},
  drawing: {
    color: 'blue',
    width: 4,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  },
});

describe('authenticated shared drawing operations', () => {
  it('sanitizes shared ink, preserves geometry through resize, and accepts incremental patches', () => {
    const input = {
      ...object(),
      drawing: {
        ...object().drawing!,
        injected: 'discard',
        points: [
          { x: 0, y: 0, injected: 'discard' },
          { x: 1, y: 1 },
        ],
      },
    };
    const created = applyWhiteboardOperations(
      board(),
      [{ type: 'create', object: input }],
      actor,
      0
    );
    assert.strictEqual(at(created.objects, 0).author, 'Alice');
    assert.deepStrictEqual(at(created.objects, 0).drawing, object().drawing);
    const changed = applyWhiteboardOperations(
      created,
      [
        {
          type: 'patch',
          id: 'stroke',
          patch: {
            width: 240,
            height: 180,
            drawing: {
              color: 'pink',
              width: 8,
              points: [
                { x: 0, y: 0 },
                { x: 0.5, y: 0.25 },
                { x: 1, y: 1 },
              ],
            },
          },
        },
      ],
      actor,
      0
    );
    assert.strictEqual(at(changed.objects, 0).drawing?.points.length, 3);
    assert.strictEqual(at(changed.objects, 0).width, 240);
    assert.strictEqual(at(created.objects, 0).drawing?.color, 'blue');
  });

  it('rejects invalid ink atomically on create and patch', () => {
    const created = applyWhiteboardOperations(
      board(),
      [{ type: 'create', object: object() }],
      actor,
      0
    );
    for (const drawing of [
      null,
      { ...object().drawing, width: 13 },
      { ...object().drawing, color: 'url(javascript:bad)' },
      { ...object().drawing, points: [{ x: 0, y: 0 }] },
      {
        ...object().drawing,
        points: [
          { x: -0.1, y: 0 },
          { x: 1, y: 1 },
        ],
      },
      { ...object().drawing, points: [{ x: 0, y: 0 }, null] },
      {
        ...object().drawing,
        points: Array.from({ length: 513 }, () => ({ x: 0, y: 0 })),
      },
    ]) {
      const create: WhiteboardOperation[] = JSON.parse(
        JSON.stringify([{ type: 'create', object: { ...object(), drawing } }])
      );
      const patch: WhiteboardOperation[] = JSON.parse(
        JSON.stringify([{ type: 'patch', id: 'stroke', patch: { drawing } }])
      );
      assert.throws(() =>
        applyWhiteboardOperations(board(), create, actor, 0)
      );
      assert.throws(() =>
        applyWhiteboardOperations(created, patch, actor, 0)
      );
    }
    assertMatchObject(created.objects[0], { drawing: object().drawing });
    assert.throws(() =>
      applyWhiteboardOperations(
        board(),
        [{ type: 'create', object: { ...object(), kind: 'note' } }],
        actor,
        0
      )
    );
  });
});
