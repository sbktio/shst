import type {
  WhiteboardDocument,
  WhiteboardOperation,
  WhiteboardPerson,
  WhiteboardEditingLease,
} from './types.ts';
import { PersistenceError } from './errors.ts';
import { applyWhiteboardOperations } from './operations.ts';
import type { WhiteboardStore } from './whiteboardStore.ts';

export const WHITEBOARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class WhiteboardService {
  private readonly store: WhiteboardStore;

  constructor(store: WhiteboardStore) {
    this.store = store;
  }

  async read(id: string): Promise<WhiteboardDocument> {
    const saved = await this.store.read(id);
    if (!saved)
      throw new PersistenceError(
        404,
        'This whiteboard does not exist. Check the room link.'
      );
    if (saved.value.expiresAt < Date.now())
      throw new PersistenceError(
        410,
        'This whiteboard expired after 30 days without an edit.'
      );
    return saved.value.board;
  }

  async create(
    id: string,
    actor: { id: string; name: string },
    objects: WhiteboardDocument['objects'],
    title = 'The next big thing'
  ): Promise<WhiteboardDocument> {
    const now = Date.now();
    const empty: WhiteboardDocument = {
      id,
      title: 'The next big thing',
      objects: [],
      revision: 0,
      timer: { endAt: null, remaining: 300 },
    };
    let board = applyWhiteboardOperations(
      empty,
      [{ type: 'title', title }],
      actor,
      now
    );
    if (objects.length)
      board = applyWhiteboardOperations(
        board,
        objects.map(
          (object): WhiteboardOperation => ({ type: 'create', object })
        ),
        actor,
        now
      );
    board.revision = 0;
    try {
      await this.store.write(
        id,
        {
          board,
          owner: actor.id,
          expiresAt: now + WHITEBOARD_RETENTION_MS,
          receipts: [],
        },
        null
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'statusCode' in error &&
        error.statusCode === 412
      ) {
        throw new PersistenceError(
          409,
          'This room already exists. Start a new whiteboard.'
        );
      }
      throw error;
    }
    return board;
  }

  async change(
    id: string,
    actor: { id: string; name: string },
    operations: WhiteboardOperation[],
    requestId: string,
    revision: number,
    sessionId?: string,
    asAgent = false
  ): Promise<WhiteboardDocument> {
    // ETag retries reconcile independent API instances without a last-writer-wins save.
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await this.store.read(id);
      if (!saved)
        throw new PersistenceError(404, 'This whiteboard no longer exists.');
      if (saved.value.expiresAt < Date.now())
        throw new PersistenceError(410, 'This whiteboard has expired.');
      const receipt = `${actor.id}:${asAgent ? 'copilot:' : ''}${requestId}`;
      if (saved.value.receipts.includes(receipt)) return saved.value.board;
      if (saved.value.board.revision !== revision)
        throw new PersistenceError(
          409,
          'Someone changed the board before this edit was saved. Discard the pending change, review the latest board, and try again.'
        );
      const now = Date.now();
      const board = applyWhiteboardOperations(
        saved.value.board,
        operations,
        asAgent
          ? { id: `${actor.id}:copilot`, name: `Copilot (${actor.name})` }
          : actor,
        now
      );
      const personId = `${actor.id}:${asAgent ? 'copilot:' : ''}${sessionId ?? ''}`;
      const locked = (saved.value.editing ?? []).find(
        (lease) =>
          lease.expiresAt > now &&
          lease.personId !== personId &&
          operations.some(
            (op) =>
              (op.type === 'patch' || op.type === 'delete') &&
              (op.id === lease.objectId ||
                (op.type === 'delete' &&
                  saved.value.board.objects.some(
                    (object) =>
                      object.id === lease.objectId &&
                      object.anchor?.objectId === op.id
                  )))
          )
      );
      if (locked)
        throw new PersistenceError(
          409,
          `${locked.name} is editing this idea. Wait for them to finish.`
        );
      try {
        await this.store.write(
          id,
          {
            ...saved.value,
            board,
            expiresAt: now + WHITEBOARD_RETENTION_MS,
            receipts: [...saved.value.receipts.slice(-255), receipt],
          },
          saved.version
        );
        return board;
      } catch (error) {
        const conflict =
          typeof error === 'object' &&
          error &&
          'statusCode' in error &&
          error.statusCode === 412;
        if (!conflict) throw error;
      }
    }
    throw new PersistenceError(
      409,
      'The board is busy. Your change was not saved; try again.'
    );
  }

  collectExpired(): Promise<void> {
    return this.store.collectExpired(Date.now());
  }

  async editing(id: string): Promise<WhiteboardEditingLease[]> {
    const saved = await this.store.read(id);
    return (saved?.value.editing ?? []).filter(
      (lease) => lease.expiresAt > Date.now()
    );
  }

  async edit(
    id: string,
    person: { id: string; name: string },
    objectId: string | null
  ): Promise<WhiteboardEditingLease[]> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await this.store.read(id);
      if (!saved || saved.value.expiresAt < Date.now())
        throw new PersistenceError(404, 'This whiteboard is unavailable.');
      const now = Date.now();
      const active = (saved.value.editing ?? []).filter(
        (lease) => lease.expiresAt > now
      );
      if (objectId !== null) {
        const object = saved.value.board.objects.find(
          (item) => item.id === objectId
        );
        if (!object || !['note', 'text', 'frame'].includes(object.kind))
          throw new PersistenceError(400, 'Choose an editable idea.');
        const other = active.find(
          (lease) => lease.objectId === objectId && lease.personId !== person.id
        );
        if (other)
          throw new PersistenceError(
            409,
            `${other.name} is editing this idea.`
          );
      }
      const editing = active.filter((lease) => lease.personId !== person.id);
      if (objectId !== null)
        editing.push({
          objectId,
          personId: person.id,
          name: person.name,
          expiresAt: now + 15000,
        });
      try {
        await this.store.write(id, { ...saved.value, editing }, saved.version);
        return editing;
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error &&
            'statusCode' in error &&
            error.statusCode === 412
          )
        )
          throw error;
      }
    }
    throw new PersistenceError(409, 'The board is busy. Try editing again.');
  }

  async people(id: string): Promise<WhiteboardPerson[]> {
    return (await this.store.readPeople(id, Date.now())).filter(
      (person) => !person.agent || person.cursor !== null
    );
  }

  async agentPresence(
    id: string,
    actor: { id: string; name: string },
    sessionId: string,
    cursor: WhiteboardPerson['cursor'],
    activity: string,
    reaction: string | null
  ): Promise<void> {
    await this.presence(id, {
      id: `${actor.id}:copilot:${sessionId}`,
      name: `Copilot (${actor.name})`,
      cursor,
      reaction,
      agent: { ownerId: actor.id, activity },
    });
  }

  async presence(id: string, person: WhiteboardPerson): Promise<void> {
    await this.read(id);
    const now = Date.now();
    const people = await this.store.readPeople(id, now);
    if (people.length >= 100 && !people.some((peer) => peer.id === person.id))
      throw new PersistenceError(
        429,
        'This board has reached 100 participants.'
      );
    await this.store.writePerson(id, person, now);
  }
}
