import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { WhiteboardDocument, WhiteboardObject } from '../src/types.ts';
import { applyWhiteboardOperations } from '../src/operations.ts';
import {
  WhiteboardService,
  WHITEBOARD_RETENTION_MS,
} from '../src/whiteboardService.ts';
import { assertMatchObject } from './assertMatchObject.ts';
import { at } from './at.ts';
import { MemoryWhiteboardStore } from './memoryStore.ts';

const actor = { id: 'alice', name: 'Alice' };
const empty = (): WhiteboardDocument => ({
  id: 'board',
  title: 'Board',
  objects: [],
  revision: 0,
  timer: { endAt: null, remaining: 300 },
});
const note = (id = 'note'): WhiteboardObject => ({
  id,
  kind: 'note',
  text: 'An idea',
  color: 'lemon',
  author: 'Forged',
  votes: { other: 999 },
  x: 10,
  y: 20,
  width: 220,
  height: 210,
  fontSize: 20,
  rotation: -2,
});
/** The time APIs the service and these tests rely on; setImmediate stays real. */
const FAKE_TIME_APIS: ('setTimeout' | 'setInterval' | 'Date')[] = [
  'setTimeout',
  'setInterval',
  'Date',
];
afterEach(() => mock.timers.reset());

it('restores a full archive atomically and rejects over-limit archives without creating a room', async () => {
  const service = new WhiteboardService(new MemoryWhiteboardStore());
  const objects = Array.from({ length: 1000 }, (_, index) =>
    note(`note-${index}`)
  );
  const restored = await service.create(
    'full',
    actor,
    objects,
    'Restored board'
  );
  assertMatchObject(restored, { title: 'Restored board', revision: 0 });
  assert.strictEqual(restored.objects.length, 1000);
  await assert.rejects(
    service.create('oversize', actor, [...objects, note('extra')]),
    { status: 400 }
  );
  await assert.rejects(service.read('oversize'), { status: 404 });
});

it('serializes competing edit leases, enforces tab ownership, and recovers after release or expiry', async () => {
  // The fake clock starts at the real current time, as it did before.
  mock.timers.enable({ apis: FAKE_TIME_APIS, now: Date.now() });
  const service = new WhiteboardService(new MemoryWhiteboardStore());
  await service.create('board', actor, [note()]);
  const results = await Promise.allSettled([
    service.edit('board', { id: 'alice:tab-a', name: 'Alice' }, 'note'),
    service.edit('board', { id: 'bob:tab-b', name: 'Bob' }, 'note'),
  ]);
  assert.strictEqual(
    results.filter((result) => result.status === 'fulfilled').length,
    1
  );
  const [lease] = await service.editing('board');
  assert.ok(lease, 'one tab holds the lease');
  const winner = lease.personId.startsWith('alice')
    ? actor
    : { id: 'bob', name: 'Bob' };
  const tab = lease.personId.split(':')[1];
  await assert.rejects(
    service.change(
      'board',
      winner,
      [{ type: 'patch', id: 'note', patch: { text: 'Wrong tab' } }],
      'wrong',
      0,
      'another-tab'
    ),
    { status: 409 }
  );
  await service.change(
    'board',
    winner,
    [{ type: 'patch', id: 'note', patch: { text: 'Owned edit' } }],
    'owned',
    0,
    tab
  );
  await service.edit('board', { id: lease.personId, name: winner.name }, null);
  await service.edit('board', { id: 'other:tab', name: 'Other' }, 'note');
  await assert.rejects(
    service.change(
      'board',
      actor,
      [{ type: 'delete', id: 'note' }],
      'delete',
      1
    ),
    { status: 409 }
  );
  // Advance the clock past the lease, then let pending promises settle.
  mock.timers.tick(15001);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(await service.editing('board'), []);
  await service.change(
    'board',
    actor,
    [{ type: 'delete', id: 'note' }],
    'delete',
    1
  );
  assert.deepStrictEqual((await service.read('board')).objects, []);
});

describe('whiteboard operations', () => {
  it('stamps identity, rejects forged votes, and applies batches atomically', () => {
    const original = empty();
    const created = applyWhiteboardOperations(
      original,
      [{ type: 'create', object: note() }],
      actor,
      0
    );
    assertMatchObject(created.objects[0], { author: 'Alice', votes: {} });
    assert.deepStrictEqual(original.objects, []);
    assert.throws(() =>
      applyWhiteboardOperations(
        created,
        [
          { type: 'patch', id: 'note', patch: { text: 'Changed' } },
          { type: 'patch', id: 'note', patch: { width: -1 } },
        ],
        actor,
        0
      )
    );
    assert.strictEqual(at(created.objects, 0).text, 'An idea');
  });

  it('keeps per-person votes independent and toggles a repeated vote off', () => {
    const created = applyWhiteboardOperations(
      empty(),
      [{ type: 'create', object: note() }],
      actor,
      0
    );
    const alice = applyWhiteboardOperations(
      created,
      [{ type: 'vote', id: 'note', direction: 1 }],
      actor,
      0
    );
    const bob = applyWhiteboardOperations(
      alice,
      [{ type: 'vote', id: 'note', direction: -1 }],
      { id: 'bob', name: 'Bob' },
      0
    );
    const unvoted = applyWhiteboardOperations(
      bob,
      [{ type: 'vote', id: 'note', direction: 1 }],
      actor,
      0
    );
    assert.deepStrictEqual(at(unvoted.objects, 0).votes, { alice: 0, bob: -1 });
  });

  it('validates attachment contents and limits and prevents dangling or cyclic stamps', () => {
    const stamp = {
      ...note('stamp'),
      kind: 'stamp' as const,
      anchor: { objectId: 'note', x: 0.5, y: 0.5 },
    };
    const created = applyWhiteboardOperations(
      empty(),
      [
        { type: 'create', object: stamp },
        { type: 'create', object: note() },
      ],
      actor,
      0
    );
    assert.deepStrictEqual(
      applyWhiteboardOperations(
        created,
        [
          { type: 'delete', id: 'note' },
          { type: 'delete', id: 'stamp' },
        ],
        actor,
        0
      ).objects,
      []
    );
    assert.throws(() =>
      applyWhiteboardOperations(
        empty(),
        [{ type: 'create', object: stamp }],
        actor,
        0
      )
    );
    assert.throws(() =>
      applyWhiteboardOperations(
        created,
        [
          {
            type: 'patch',
            id: 'stamp',
            patch: { anchor: { objectId: 'stamp', x: 0, y: 0 } },
          },
        ],
        actor,
        0
      )
    );
    const image = {
      name: 'test.png',
      type: 'image/png',
      data: 'data:image/png;base64,iVBORw0KGgo=',
    };
    const attached = applyWhiteboardOperations(
      created,
      [{ type: 'patch', id: 'note', patch: { attachments: [image] } }],
      actor,
      0
    );
    assert.deepStrictEqual(
      attached.objects.find((o) => o.id === 'note')?.attachments,
      [image]
    );
    assert.throws(() =>
      applyWhiteboardOperations(
        created,
        [
          {
            type: 'patch',
            id: 'note',
            patch: { attachments: Array.from({ length: 9 }, () => image) },
          },
        ],
        actor,
        0
      )
    );
    assert.throws(() =>
      applyWhiteboardOperations(
        created,
        [
          {
            type: 'patch',
            id: 'note',
            patch: { attachments: [{ ...image, type: 'image/svg+xml' }] },
          },
        ],
        actor,
        0
      )
    );
  });

  it('pauses and resets a shared timer using server time', () => {
    const started = applyWhiteboardOperations(
      empty(),
      [{ type: 'timer', action: 'start' }],
      actor,
      1000
    );
    assert.strictEqual(started.timer.endAt, 301000);
    const paused = applyWhiteboardOperations(
      started,
      [{ type: 'timer', action: 'pause' }],
      actor,
      11000
    );
    assert.deepStrictEqual(paused.timer, { endAt: null, remaining: 290 });
    assert.throws(() =>
      applyWhiteboardOperations(
        paused,
        [{ type: 'timer', action: 'reset', seconds: 0 }],
        actor,
        0
      )
    );
  });
});

describe('whiteboard collaboration', () => {
  it('deduplicates response-loss retries even after a peer edit and rejects stale edits', async () => {
    const service = new WhiteboardService(new MemoryWhiteboardStore());
    await service.create('board', actor, []);
    await service.change(
      'board',
      actor,
      [{ type: 'create', object: note() }],
      'first',
      0
    );
    await service.change(
      'board',
      { id: 'bob', name: 'Bob' },
      [{ type: 'title', title: 'Team board' }],
      'second',
      1
    );
    const retry = await service.change(
      'board',
      actor,
      [{ type: 'create', object: note() }],
      'first',
      0
    );
    assertMatchObject(retry, { revision: 2, title: 'Team board' });
    assert.strictEqual(retry.objects.length, 1);
    await assert.rejects(
      service.change(
        'board',
        actor,
        [{ type: 'title', title: 'Stale' }],
        'third',
        1
      ),
      { status: 409 }
    );
  });

  it('protects concurrent instances with ETags and reports room collisions', async () => {
    const store = new MemoryWhiteboardStore();
    const first = new WhiteboardService(store),
      second = new WhiteboardService(store);
    await first.create('board', actor, []);
    await assert.rejects(second.create('board', actor, []), {
      status: 409,
    });
    const results = await Promise.allSettled([
      first.change(
        'board',
        actor,
        [{ type: 'create', object: note('a') }],
        'a',
        0
      ),
      second.change(
        'board',
        actor,
        [{ type: 'create', object: note('b') }],
        'b',
        0
      ),
    ]);
    assert.deepStrictEqual(results.map((result) => result.status).sort(), [
      'fulfilled',
      'rejected',
    ]);
    assert.strictEqual((await first.read('board')).objects.length, 1);
  });

  it('shares expiring presence across instances without rewriting the board', async () => {
    mock.timers.enable({ apis: FAKE_TIME_APIS });
    mock.timers.setTime(1000);
    const store = new MemoryWhiteboardStore();
    const first = new WhiteboardService(store),
      second = new WhiteboardService(store);
    await first.create('board', actor, []);
    const version = (await store.read('board'))?.version;
    await first.presence('board', {
      id: 'alice-session',
      name: 'Alice',
      cursor: { x: 1, y: 2 },
      reaction: null,
    });
    assert.strictEqual((await second.people('board')).length, 1);
    assert.strictEqual((await store.read('board'))?.version, version);
    mock.timers.tick(11000);
    assert.deepStrictEqual(await second.people('board'), []);
    mock.timers.tick(WHITEBOARD_RETENTION_MS);
    await assert.rejects(first.read('board'), { status: 410 });
    await first.collectExpired();
    await assert.rejects(first.read('board'), { status: 404 });
  });
});
