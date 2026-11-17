/** HTTP-style statuses the whiteboard service can fail with. */
export type PersistenceStatus = 503 | 413 | 400 | 403 | 404 | 409 | 410 | 429;

/**
 * A rule the whiteboard service enforces, with the status a host should answer
 * with: an oversized board, a stale revision, a missing or expired room.
 *
 * One class rather than one per case, because the only thing a caller does with
 * these is read `status`.
 */
export class PersistenceError extends Error {
  readonly status: PersistenceStatus;

  constructor(
    status: PersistenceStatus,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.status = status;
    this.name = 'PersistenceError';
  }
}
