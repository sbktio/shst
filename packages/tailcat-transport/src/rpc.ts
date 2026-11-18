import type { FrameChannel } from './frames.ts';

/**
 * Request/response multiplexing over one frame channel.
 *
 * A client usually has several calls in flight at once (a long poll, a
 * heartbeat, a save), so calls are tagged with an id and may complete out of
 * order. One long-lived connection carries them all: dialing Tailcat per
 * request would repeat the DERP rendezvous and handshake every 900 ms.
 */

interface RpcRequest {
  t: 'req';
  id: number;
  method: string;
  params: unknown;
}

type RpcResponse =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; status: number; error: string };

export class RpcError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'RpcError';
  }
}

export const RPC_TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 32;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isResponse(value: unknown): value is RpcResponse {
  return (
    isObject(value) &&
    value.t === 'res' &&
    typeof value.id === 'number' &&
    typeof value.ok === 'boolean'
  );
}

function isRequest(value: unknown): value is RpcRequest {
  return (
    isObject(value) &&
    value.t === 'req' &&
    Number.isSafeInteger(value.id) &&
    typeof value.method === 'string'
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export interface RpcClient {
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Settles when the connection ends; the error is null for a clean close. */
  readonly closed: Promise<Error | null>;
  close(): void;
}

export function createRpcClient(
  channel: FrameChannel,
  timeoutMs = RPC_TIMEOUT_MS
): RpcClient {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  let nextId = 1;
  let ended: Error | null = null;

  const finish = (error: Error): Error => {
    ended ??= error;
    for (const entry of pending.values()) entry.reject(ended);
    pending.clear();
    return ended;
  };

  const closed = (async (): Promise<Error | null> => {
    try {
      for (;;) {
        const frame = await channel.reader.next();
        if (frame.done) break;
        if (!isResponse(frame.message)) continue;
        const response = frame.message;
        const entry = pending.get(response.id);
        if (!entry) continue; // Aborted or timed out; the late answer is dropped.
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.result);
        else entry.reject(new RpcError(response.status, response.error));
      }
      finish(new Error('The live session ended.'));
      return null;
    } catch (error) {
      return finish(
        error instanceof Error ? error : new Error('The live session failed.')
      );
    }
  })();

  return {
    closed,
    close: (): void => {
      finish(new Error('The live session was closed.'));
      channel.close();
    },
    call: (method, params, signal): Promise<unknown> => {
      if (ended) return Promise.reject(ended);
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('The live session host did not answer in time.'));
        }, timeoutMs);
        const settle =
          <T>(fn: (value: T) => void) =>
          (value: T): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            fn(value);
          };
        const onAbort = (): void => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          reject(abortReason(signal!));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        const request: RpcRequest = { t: 'req', id, method, params };
        channel.send(request).catch((error: unknown) => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          entry.reject(error);
        });
      });
    },
  };
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

/**
 * Answer requests until the peer disconnects. Handlers run concurrently, like
 * HTTP requests; ordering between them is the handler's concern.
 */
export async function serveRpc(
  channel: FrameChannel,
  handle: RpcHandler
): Promise<void> {
  let inFlight = 0;
  const respond = (response: RpcResponse): void => {
    channel.send(response).catch(() => {
      // The peer is gone; the read loop below observes the close.
    });
  };
  for (;;) {
    const frame = await channel.reader.next();
    if (frame.done) return;
    if (!isRequest(frame.message)) continue;
    const { id, method, params } = frame.message;
    if (inFlight >= MAX_IN_FLIGHT) {
      respond({
        t: 'res',
        id,
        ok: false,
        status: 429,
        error: 'Too many requests are waiting. Slow down and try again.',
      });
      continue;
    }
    inFlight++;
    void handle(method, params)
      .then(
        (result): RpcResponse => ({ t: 'res', id, ok: true, result }),
        (error: unknown): RpcResponse => {
          // Only deliberate, status-carrying failures reach the peer verbatim.
          const status =
            isObject(error) &&
            typeof error.status === 'number' &&
            error.status >= 400 &&
            error.status < 600
              ? error.status
              : 500;
          return {
            t: 'res',
            id,
            ok: false,
            status,
            error:
              status !== 500 && error instanceof Error
                ? error.message
                : 'The live session host could not complete that request.',
          };
        }
      )
      .then((response) => {
        inFlight--;
        respond(response);
      });
  }
}
