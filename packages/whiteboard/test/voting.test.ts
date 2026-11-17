import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WhiteboardDocument, WhiteboardObject } from '../src/types.ts';
import { applyWhiteboardOperations } from '../src/operations.ts';
import { PersistenceError } from '../src/errors.ts';
import { MemoryWhiteboardStore } from './memoryStore.ts';
import { WhiteboardService } from '../src/whiteboardService.ts';
import { assertMatchObject } from './assertMatchObject.ts';
import { at } from './at.ts';

const actor = { id: 'alice', name: 'Alice' };
const note: WhiteboardObject = {
  id: 'note',
  kind: 'note',
  text: 'Idea',
  color: 'lemon',
  author: 'Forged author',
  votes: { forged: 1 },
  voterNames: { forged: 'Forged name' },
  x: 0,
  y: 0,
  width: 220,
  height: 210,
  fontSize: 20,
  rotation: 0,
};
const empty = (): WhiteboardDocument => ({
  id: 'board',
  title: 'Board',
  objects: [],
  revision: 0,
  timer: { endAt: null, remaining: 300 },
});

describe('authenticated voter names', () => {
  it('ignores identity and voting metadata on create and stamps only the authenticated voter', () => {
    const created = applyWhiteboardOperations(
      empty(),
      [{ type: 'create', object: note }],
      actor,
      0
    );
    assert.deepStrictEqual(at(created.objects, 0).votes, {});
    assert.ok(!('voterNames' in at(created.objects, 0)));
    const untrustedVote = {
      type: 'vote' as const,
      id: 'note',
      direction: 1 as const,
      voterNames: { forged: 'Forged name' },
      name: 'Forged name',
    };
    const voted = applyWhiteboardOperations(created, [untrustedVote], actor, 0);
    assertMatchObject(voted.objects[0], {
      votes: { alice: 1 },
      voterNames: { alice: 'Alice' },
    });
    assert.deepStrictEqual(at(created.objects, 0).votes, {});
    assert.ok(!('voterNames' in at(created.objects, 0)));
    // A patch cannot forge voter names on a voted note.
    const forgedPatch = {
      type: 'patch' as const,
      id: 'note',
      patch: { text: 'Changed', voterNames: { alice: 'Forged name' } },
    };
    assert.throws(
      () => applyWhiteboardOperations(voted, [forgedPatch], actor, 0),
      PersistenceError
    );
  });

  for (const direction of [1, -1] as const) {
    it(`switches and withdraws a ${direction} vote without altering other voters`, () => {
      const current = empty();
      current.objects = [
        {
          ...note,
          votes: { alice: direction, bob: -1 },
          voterNames: { alice: 'Old Alice', bob: 'Bob' },
        },
      ];
      const switched = applyWhiteboardOperations(
        current,
        [{ type: 'vote', id: 'note', direction: direction === 1 ? -1 : 1 }],
        actor,
        0
      );
      assert.strictEqual(at(switched.objects, 0).votes.alice, -direction);
      assert.deepStrictEqual(at(switched.objects, 0).voterNames, {
        alice: 'Alice',
        bob: 'Bob',
      });
      const withdrawn = applyWhiteboardOperations(
        switched,
        [{ type: 'vote', id: 'note', direction: direction === 1 ? -1 : 1 }],
        actor,
        0
      );
      assert.deepStrictEqual(at(withdrawn.objects, 0).votes, {
        alice: 0,
        bob: -1,
      });
      assert.deepStrictEqual(at(withdrawn.objects, 0).voterNames, {
        bob: 'Bob',
      });
    });
  }

  it('persists human and Copilot names independently without relying on live presence', async () => {
    const store = new MemoryWhiteboardStore();
    const service = new WhiteboardService(store);
    await service.create('board', actor, [note]);
    await service.change(
      'board',
      actor,
      [{ type: 'vote', id: 'note', direction: 1 }],
      'human-vote',
      0
    );
    await service.change(
      'board',
      actor,
      [{ type: 'vote', id: 'note', direction: -1 }],
      'agent-vote',
      1,
      undefined,
      true
    );
    const reloaded = await new WhiteboardService(store).read('board');
    assertMatchObject(reloaded.objects[0], {
      votes: { alice: 1, 'alice:copilot': -1 },
      voterNames: { alice: 'Alice', 'alice:copilot': 'Copilot (Alice)' },
    });
    assert.deepStrictEqual(await service.people('board'), []);
  });
});
