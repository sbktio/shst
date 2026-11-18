import type { ByteStream } from './frames.ts';

/**
 * An RTCDataChannel as a `ByteStream`, so the frame/RPC layers run over a
 * direct WebRTC path unchanged.
 *
 * Data channels are message-based; frames.ts already reassembles arbitrary
 * chunks, so writes are split into small messages (well under every
 * browser's SCTP message limit) and reads hand messages through as chunks.
 * Writes wait on `bufferedAmount` so a large write stalls the writer rather
 * than filling browser memory.
 */

/** The subset of RTCDataChannel used here, so tests can supply a fake. */
export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(
    type: 'message' | 'close' | 'bufferedamountlow' | 'error',
    listener: (event: Event) => void
  ): void;
  removeEventListener(
    type: 'bufferedamountlow' | 'close',
    listener: (event: Event) => void
  ): void;
}

export const RTC_MESSAGE_BYTES = 16 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

export function dataChannelStream(
  channel: DataChannelLike,
  onClose?: () => void
): ByteStream {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_WATER;
  const inbox: (Uint8Array | null)[] = [];
  const waiters: ((chunk: Uint8Array | null) => void)[] = [];
  let ended = false;
  const deliver = (chunk: Uint8Array | null): void => {
    if (ended) return;
    if (chunk === null) ended = true;
    const waiter = waiters.shift();
    if (waiter) waiter(chunk);
    else inbox.push(chunk);
    // Wake every other reader on end, too.
    if (chunk === null) while (waiters.length) waiters.shift()?.(null);
  };
  channel.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data;
    if (data instanceof ArrayBuffer) deliver(new Uint8Array(data));
  });
  channel.addEventListener('close', () => deliver(null));
  channel.addEventListener('error', () => deliver(null));

  const drained = (): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        channel.removeEventListener('bufferedamountlow', done);
        channel.removeEventListener('close', done);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', done);
      channel.addEventListener('close', done);
    });

  return {
    read: (): Promise<Uint8Array | null> =>
      inbox.length
        ? Promise.resolve(inbox.shift() ?? null)
        : ended
          ? Promise.resolve(null)
          : new Promise((resolve) => waiters.push(resolve)),
    write: async (chunk: Uint8Array): Promise<void> => {
      for (let offset = 0; offset < chunk.byteLength; ) {
        if (channel.bufferedAmount > HIGH_WATER) await drained();
        if (channel.readyState !== 'open')
          throw new Error('The direct connection closed.');
        const end = Math.min(offset + RTC_MESSAGE_BYTES, chunk.byteLength);
        channel.send(chunk.slice(offset, end).buffer);
        offset = end;
      }
    },
    close: (): void => {
      channel.close();
      deliver(null);
      onClose?.();
    },
  };
}
