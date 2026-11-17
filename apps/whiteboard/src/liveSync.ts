import {
  Backoff,
  PRESENCE_DEADLINE_MS,
  PresencePacer,
  WATCH_DEADLINE_MS,
} from '@shst/tailcat-transport';
import type {
  TailcatWhiteboardApi,
  WatchSnapshot,
} from '@shst/tailcat-transport';

/**
 * Keeps one participant in sync with a live session, replacing the poll
 * loop (see syncPacing.ts for the rules):
 *
 *  - one `watch` is always open; the host answers it when the board or
 *    someone else's presence changes, so changes arrive in one network trip;
 *  - the cursor is sent when it changes, one update in flight, spaced by the
 *    measured round trip, with a heartbeat when nothing changes;
 *  - the transport can be swapped mid-session (relay → WebRTC) without
 *    losing state: the open watch is cancelled and re-opened on the new one.
 */

export interface LiveSyncOptions {
  api: TailcatWhiteboardApi;
  boardId: string;
  name: string;
  /** The local pointer in board coordinates, or null. */
  cursor(): { x: number; y: number } | null;
  onSnapshot(snapshot: WatchSnapshot, sessionId: string): void;
  /** Each presence round trip, for the ping meter. */
  onPresenceRtt(ms: number): void;
  onError(message: string): void;
  /** Called when the watch starts or stops failing. */
  onRetrying(retrying: boolean): void;
}

export interface LiveSync {
  readonly sessionId: string;
  /** The cursor moved; send it as soon as pacing allows. */
  nudge(): void;
  /** Continue over another transport. */
  setApi(api: TailcatWhiteboardApi): void;
  stop(): void;
  /** Resolves when stopped. */
  readonly done: Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export function startLiveSync(options: LiveSyncOptions): LiveSync {
  const sessionId = crypto.randomUUID();
  const stopped = new AbortController();
  let api = options.api;

  // --- Watch: one open request, answered when something changes. ---
  let current: AbortController | undefined;
  let revision = -1;
  let presenceVersion = -1;
  const backoff = new Backoff();
  const watchLoop = async (): Promise<void> => {
    while (!stopped.signal.aborted) {
      const switched = new AbortController();
      current = switched;
      const deadline = AbortSignal.timeout(WATCH_DEADLINE_MS);
      const signal = AbortSignal.any([
        stopped.signal,
        switched.signal,
        deadline,
      ]);
      try {
        const snapshot = await api.watch(
          options.boardId,
          revision,
          presenceVersion,
          signal
        );
        if (snapshot.board) revision = snapshot.board.revision;
        presenceVersion = snapshot.presenceVersion;
        if (backoff.failing) options.onRetrying(false);
        backoff.reset();
        options.onSnapshot(snapshot, sessionId);
      } catch (error) {
        if (stopped.signal.aborted) return;
        if (switched.signal.aborted) continue; // moved to another transport
        if (!backoff.failing) options.onRetrying(true);
        options.onError(
          deadline.aborted
            ? 'The host did not answer.'
            : error instanceof Error
              ? error.message
              : String(error)
        );
        await sleep(backoff.next(), stopped.signal);
      }
    }
  };

  // --- Presence: on change, one in flight, spaced by the round trip. ---
  const pacer = new PresencePacer();
  let lastSent: string | undefined;
  let lastSentAt = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cursorKey = (): string => JSON.stringify(options.cursor());

  const schedule = (): void => {
    clearTimeout(timer);
    if (stopped.signal.aborted || inFlight) return;
    const wait = pacer.delay({
      now: performance.now(),
      lastSentAt,
      changed: cursorKey() !== lastSent,
      hidden: document.hidden,
    });
    timer = setTimeout(() => void send(), wait);
  };

  const send = async (): Promise<void> => {
    if (inFlight || stopped.signal.aborted) return;
    inFlight = true;
    const key = cursorKey();
    const started = performance.now();
    lastSentAt = started;
    try {
      await api.presence(
        options.boardId,
        sessionId,
        options.cursor(),
        null,
        AbortSignal.any([
          stopped.signal,
          AbortSignal.timeout(PRESENCE_DEADLINE_MS),
        ]),
        { displayName: options.name, companion: '🦊', entrance: 'none' }
      );
      lastSent = key;
      const ms = performance.now() - started;
      pacer.rtt.add(ms);
      options.onPresenceRtt(ms);
    } catch (error) {
      if (!stopped.signal.aborted)
        options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight = false;
      schedule();
    }
  };

  const onVisibility = (): void => schedule();
  document.addEventListener('visibilitychange', onVisibility);
  void send(); // announce ourselves straight away
  const done = watchLoop();

  return {
    sessionId,
    nudge: schedule,
    setApi: (next): void => {
      api = next;
      current?.abort();
      void send();
    },
    stop: (): void => {
      stopped.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
    done,
  };
}
