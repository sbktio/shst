import type {
  StoredWhiteboard,
  WhiteboardPerson,
  WhiteboardStore,
} from '@shst/whiteboard';

/**
 * The workshop store's semantics in a browser tab: optimistic versions,
 * expiring presence, nothing written to browser storage. Closing the host tab
 * ends the session, exactly like stopping the workshop server.
 *
 * It also tells watchers when something changes, which is what lets the host
 * push changes instead of being polled (see `waitForChange`).
 */

type Listener = (change: { by?: string }) => void;

/** Presence entries live this long without a heartbeat. */
const PRESENCE_TTL_MS = 10_000;

export class BrowserWhiteboardStore implements WhiteboardStore {
  private readonly records = new Map<
    string,
    { value: StoredWhiteboard; version: string }
  >();
  private readonly participants = new Map<
    string,
    Map<string, { person: WhiteboardPerson; expiresAt: number; seq: number }>
  >();
  private readonly listeners = new Map<string, Set<Listener>>();
  private revision = 0;
  /** Increments on every presence change, for per-viewer versions. */
  private presenceSeq = 0;
  /** The last sequence at which someone left (everyone must see that). */
  private readonly departedSeq = new Map<string, number>();

  async read(
    id: string
  ): Promise<{ value: StoredWhiteboard; version: string } | null> {
    const saved = this.records.get(id);
    return saved
      ? { value: structuredClone(saved.value), version: saved.version }
      : null;
  }

  async write(
    id: string,
    value: StoredWhiteboard,
    version: string | null
  ): Promise<void> {
    const current = this.records.get(id);
    if (version === null ? Boolean(current) : current?.version !== version)
      throw Object.assign(new Error('Whiteboard changed before this write.'), {
        statusCode: 412,
      });
    this.records.set(id, {
      value: structuredClone(value),
      version: String(++this.revision),
    });
    this.notify(id, {});
  }

  async collectExpired(now: number): Promise<void> {
    for (const [id, people] of this.participants) {
      let removed = false;
      for (const [personId, entry] of people)
        if (entry.expiresAt <= now) {
          people.delete(personId);
          removed = true;
        }
      if (removed) {
        this.departedSeq.set(id, ++this.presenceSeq);
        this.notify(id, {});
      }
    }
  }

  async readPeople(id: string, now: number): Promise<WhiteboardPerson[]> {
    return [...(this.participants.get(id)?.values() ?? [])]
      .filter((entry) => entry.expiresAt > now)
      .map((entry) => structuredClone(entry.person));
  }

  async writePerson(
    id: string,
    person: WhiteboardPerson,
    now: number
  ): Promise<void> {
    const people = this.participants.get(id) ?? new Map();
    const previous = people.get(person.id);
    // A heartbeat that changes nothing keeps the entry alive silently.
    const changed =
      !previous || JSON.stringify(previous.person) !== JSON.stringify(person);
    people.set(person.id, {
      person: structuredClone(person),
      expiresAt: now + PRESENCE_TTL_MS,
      seq: changed ? ++this.presenceSeq : previous.seq,
    });
    this.participants.set(id, people);
    if (changed) this.notify(id, { by: person.id });
  }

  /**
   * The presence version a viewer cares about: the latest change made by
   * anyone else (or anyone leaving). `selfPrefix` matches the viewer's own
   * entries (`<peerId>:`), so their own cursor never wakes their watch.
   */
  presenceVersion(id: string, selfPrefix: string): number {
    let version = this.departedSeq.get(id) ?? 0;
    for (const [personId, entry] of this.participants.get(id) ?? [])
      if (!personId.startsWith(selfPrefix))
        version = Math.max(version, entry.seq);
    return version;
  }

  /**
   * Resolve on the next change to this board that is not only `selfPrefix`'s
   * own presence, or after `timeoutMs`. Returns true if something changed.
   */
  waitForChange(
    id: string,
    selfPrefix: string,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const listeners = this.listeners.get(id) ?? new Set<Listener>();
      this.listeners.set(id, listeners);
      const done = (changed: boolean): void => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(changed);
      };
      const listener: Listener = ({ by }) => {
        if (by === undefined || !by.startsWith(selfPrefix)) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      listeners.add(listener);
    });
  }

  private notify(id: string, change: { by?: string }): void {
    for (const listener of [...(this.listeners.get(id) ?? [])])
      listener(change);
  }
}
