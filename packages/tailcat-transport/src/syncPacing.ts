/**
 * Pacing for a live session, replacing fixed-interval polling.
 *
 * Board and presence changes are pushed: each participant keeps one `watch`
 * request open and the host answers it when something changes (or after
 * `WATCH_WAIT_MS`, so a dead connection is noticed). Changes therefore arrive
 * in about one network trip, and an idle room sends nothing but heartbeats.
 *
 * Outgoing presence (the cursor) is paced by `PresencePacer`:
 *   - send only when it changed, with at most one update in flight;
 *   - space updates by the measured round trip (clamped to 33–250 ms), so a
 *     fast direct link gets ~30 updates/s and a slow relay is never queued
 *     faster than it can answer;
 *   - otherwise send a heartbeat every 2 s (5 s while hidden) so the host
 *     keeps this participant present.
 *
 * Failures back off exponentially, from 250 ms to 5 s.
 */

/** How long the host holds a watch open when nothing changes. */
export const WATCH_WAIT_MS = 20_000;
/** A watch not answered by then counts as failed (the host is gone). */
export const WATCH_DEADLINE_MS = WATCH_WAIT_MS + 5_000;
/** A presence send not answered by then counts as failed. */
export const PRESENCE_DEADLINE_MS = 5_000;

export const HEARTBEAT_MS = 2_000;
export const HIDDEN_HEARTBEAT_MS = 5_000;
export const MIN_GAP_MS = 33;
export const MAX_GAP_MS = 250;
export const MAX_BACKOFF_MS = 5_000;

export class Backoff {
  private failures = 0;

  /** The wait before the next attempt after another failure. */
  next(): number {
    this.failures++;
    return Math.min(MAX_BACKOFF_MS, 250 * 2 ** (this.failures - 1));
  }

  reset(): void {
    this.failures = 0;
  }

  get failing(): boolean {
    return this.failures > 0;
  }
}

/** Median of the last few samples, robust to a single slow one. */
export class RttWindow {
  private readonly samples: number[] = [];

  private readonly size: number;

  constructor(size = 5) {
    this.size = size;
  }

  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  median(): number | undefined {
    if (!this.samples.length) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}

export interface PresenceState {
  now: number;
  /** When the last update was sent (0 if never). */
  lastSentAt: number;
  /** Whether there is a change not yet sent. */
  changed: boolean;
  hidden: boolean;
}

export class PresencePacer {
  readonly rtt = new RttWindow();

  /** The spacing between change-driven updates. */
  gapMs(): number {
    const rtt = this.rtt.median() ?? MAX_GAP_MS;
    return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, rtt));
  }

  /** Milliseconds to wait before sending; 0 means send now. */
  delay({ now, lastSentAt, changed, hidden }: PresenceState): number {
    const heartbeat = hidden ? HIDDEN_HEARTBEAT_MS : HEARTBEAT_MS;
    const due =
      changed && !hidden ? lastSentAt + this.gapMs() : lastSentAt + heartbeat;
    return Math.max(0, due - now);
  }
}
