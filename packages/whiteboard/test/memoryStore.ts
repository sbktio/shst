import type { WhiteboardPerson } from '../src/types.ts';
import type { StoredWhiteboard, WhiteboardStore } from '../src/whiteboardStore.ts';

/** Hermetic persistence with the same conditional-write contract as Blob storage. */
export class MemoryWhiteboardStore implements WhiteboardStore {
  records = new Map<string, { value: StoredWhiteboard; version: string }>();
  participants = new Map<
    string,
    Map<string, { person: WhiteboardPerson; expiresAt: number }>
  >();
  private revision = 0;

  async read(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }

  async write(
    id: string,
    value: StoredWhiteboard,
    version: string | null
  ): Promise<void> {
    const current = this.records.get(id);
    if (version === null ? Boolean(current) : current?.version !== version)
      throw { statusCode: 412 };
    this.records.set(id, {
      value: structuredClone(value),
      version: String(++this.revision),
    });
  }

  async collectExpired(now: number): Promise<void> {
    for (const [id, record] of this.records)
      if (record.value.expiresAt < now) this.records.delete(id);
    for (const people of this.participants.values()) {
      for (const [id, person] of people)
        if (person.expiresAt < now) people.delete(id);
    }
  }

  async readPeople(id: string, now: number): Promise<WhiteboardPerson[]> {
    return [...(this.participants.get(id)?.values() ?? [])]
      .filter((value) => value.expiresAt > now)
      .map((value) => structuredClone(value.person));
  }

  async writePerson(
    id: string,
    person: WhiteboardPerson,
    now: number
  ): Promise<void> {
    const people = this.participants.get(id) ?? new Map();
    people.set(person.id, {
      person: structuredClone(person),
      expiresAt: now + 10000,
    });
    this.participants.set(id, people);
  }
}
