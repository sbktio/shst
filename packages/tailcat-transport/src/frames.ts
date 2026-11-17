/**
 * Length-prefixed JSON frames over an ordered byte stream.
 *
 * A Tailcat connection is a TCP byte stream, so message boundaries have to be
 * carried in-band: a 4-byte big-endian length, then that many bytes of UTF-8
 * JSON. The cap sits above the API's 36 MiB board body limit so a board with
 * media can still cross in one message.
 */

/** The byte-level surface shared by Tailcat connections and test pipes. */
export interface ByteStream {
  /** The next chunk, or null once the peer has finished sending. */
  read(): Promise<Uint8Array | null>;
  write(chunk: Uint8Array): Promise<void>;
  close(): void;
}

export const MAX_FRAME_BYTES = 40 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  if (body.byteLength > MAX_FRAME_BYTES)
    throw new Error('This change is too large to send to the live session.');
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, 4);
  return frame;
}

export type FrameResult = { done: true } | { done: false; message: unknown };

/**
 * Reassembles frames from arbitrarily split chunks. Chunks are queued and
 * copied once per frame, so a large board does not cost a copy per chunk.
 */
export class FrameReader {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private expected: number | null = null;

  private readonly stream: Pick<ByteStream, 'read'>;

  constructor(stream: Pick<ByteStream, 'read'>) {
    this.stream = stream;
  }

  async next(): Promise<FrameResult> {
    for (;;) {
      if (this.expected === null && this.size >= 4) {
        const header = this.take(4);
        this.expected = new DataView(header.buffer).getUint32(0);
        if (this.expected > MAX_FRAME_BYTES)
          throw new Error('The live session sent an oversized message.');
      }
      if (this.expected !== null && this.size >= this.expected) {
        const body = this.take(this.expected);
        this.expected = null;
        return {
          done: false,
          message: JSON.parse(decoder.decode(body)) as unknown,
        };
      }
      const chunk = await this.stream.read();
      if (chunk === null) {
        if (this.size || this.expected !== null)
          throw new Error(
            'The live session closed in the middle of a message.'
          );
        return { done: true };
      }
      if (chunk.byteLength) {
        this.chunks.push(chunk);
        this.size += chunk.byteLength;
      }
    }
  }

  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const head = this.chunks[0];
      // Callers only take what `size` says is buffered.
      if (head === undefined)
        throw new Error('Frame reader took more bytes than it holds.');
      const used = Math.min(head.byteLength, count - offset);
      out.set(head.subarray(0, used), offset);
      offset += used;
      if (used === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(used);
    }
    this.size -= count;
    return out;
  }
}

/** A frame reader plus a writer that never interleaves two frames. */
export interface FrameChannel {
  readonly reader: FrameReader;
  send(message: unknown): Promise<void>;
  close(): void;
}

export function createFrameChannel(stream: ByteStream): FrameChannel {
  // Each Tailcat write runs on its own Go goroutine, so two unawaited writes
  // can reach the wire in either order. Chain them.
  let tail: Promise<void> = Promise.resolve();
  return {
    reader: new FrameReader(stream),
    send: (message: unknown): Promise<void> => {
      const frame = encodeFrame(message);
      const written = tail.then(() => stream.write(frame));
      tail = written.catch(() => undefined);
      return written;
    },
    close: (): void => stream.close(),
  };
}
