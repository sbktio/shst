import type { ByteStream } from './frames.ts';

/**
 * An in-memory duplex pair with the same surface as a Tailcat connection.
 *
 * The host joins its own session through one of these, so its tab exercises
 * exactly the RPC path remote participants use, minus the network.
 * `splitWrites` delivers each write in two pieces to exercise reassembly.
 */
export function createMemoryPipe(
  options: { splitWrites?: boolean } = {}
): [ByteStream, ByteStream] {
  interface End {
    inbox: (Uint8Array | null)[];
    waiters: ((chunk: Uint8Array | null) => void)[];
  }
  const a: End = { inbox: [], waiters: [] };
  const b: End = { inbox: [], waiters: [] };
  const make = (self: End, peer: End): ByteStream => {
    let closed = false;
    const deliver = (chunk: Uint8Array | null): void => {
      const waiter = peer.waiters.shift();
      if (waiter) waiter(chunk);
      else peer.inbox.push(chunk);
    };
    return {
      read: (): Promise<Uint8Array | null> =>
        self.inbox.length
          ? Promise.resolve(self.inbox.shift() ?? null)
          : new Promise((resolve) => self.waiters.push(resolve)),
      write: async (chunk: Uint8Array): Promise<void> => {
        if (closed) throw new Error('The connection is closed.');
        if (options.splitWrites && chunk.byteLength > 1) {
          const middle = Math.floor(chunk.byteLength / 2);
          deliver(chunk.slice(0, middle));
          deliver(chunk.slice(middle));
        } else {
          deliver(chunk.slice());
        }
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        deliver(null);
      },
    };
  };
  return [make(a, b), make(b, a)];
}
