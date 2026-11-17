import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFrameChannel,
  encodeFrame,
  FrameReader,
  MAX_FRAME_BYTES,
  type ByteStream,
} from '../src/frames.ts';
import { createMemoryPipe } from '../src/memoryPipe.ts';
import { createRpcClient, RpcError, serveRpc } from '../src/rpc.ts';

/** Every write arrives in two pieces, proving frames are reassembled. */
const pipe = (): [ByteStream, ByteStream] =>
  createMemoryPipe({ splitWrites: true });

function chunked(bytes: Uint8Array, size: number): ByteStream {
  let offset = 0;
  return {
    read: async (): Promise<Uint8Array | null> => {
      if (offset >= bytes.byteLength) return null;
      const chunk = bytes.slice(offset, offset + size);
      offset += size;
      return chunk;
    },
    write: async (): Promise<void> => undefined,
    close: (): void => undefined,
  };
}

describe('frames', () => {
  it('reassembles frames split at every byte boundary', async () => {
    const messages = [
      { a: 1 },
      { text: 'héllo 🎉' },
      [],
      { big: 'x'.repeat(9000) },
    ];
    const bytes = new Uint8Array(
      messages.reduce((n, m) => n + encodeFrame(m).byteLength, 0)
    );
    let offset = 0;
    for (const message of messages) {
      const frame = encodeFrame(message);
      bytes.set(frame, offset);
      offset += frame.byteLength;
    }
    for (const size of [1, 3, 4, 5, 64, bytes.byteLength]) {
      const reader = new FrameReader(chunked(bytes, size));
      const read: unknown[] = [];
      for (;;) {
        const frame = await reader.next();
        if (frame.done) break;
        read.push(frame.message);
      }
      assert.deepStrictEqual(read, messages);
    }
  });

  it('rejects a truncated frame and an oversized header', async () => {
    const frame = encodeFrame({ hello: 'world' });
    await assert.rejects(
      new FrameReader(chunked(frame.slice(0, -2), 4)).next(),
      { message: /middle of a message/ }
    );
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    await assert.rejects(new FrameReader(chunked(header, 4)).next(), {
      message: /oversized/,
    });
  });
});

describe('rpc', () => {
  it('multiplexes concurrent calls that finish out of order', async () => {
    const [client, server] = pipe();
    void serveRpc(createFrameChannel(server), async (method, params) => {
      const { delay } = params as { delay: number };
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (method === 'fail')
        throw Object.assign(new Error('Not yours.'), { status: 409 });
      if (method === 'crash') throw new Error('secret internals');
      return { method, delay };
    });
    const rpc = createRpcClient(createFrameChannel(client));
    const order: number[] = [];
    const calls = [30, 1, 15].map((delay) =>
      rpc.call('echo', { delay }).then((result) => {
        order.push(delay);
        return result;
      })
    );
    assert.deepStrictEqual(await Promise.all(calls), [
      { method: 'echo', delay: 30 },
      { method: 'echo', delay: 1 },
      { method: 'echo', delay: 15 },
    ]);
    assert.deepStrictEqual(order, [1, 15, 30]);
    // Same class, name, message and status as a freshly built RpcError.
    await assert.rejects(rpc.call('fail', { delay: 0 }), (error: unknown) => {
      assert.deepStrictEqual(error, new RpcError(409, 'Not yours.'));
      return true;
    });
    await assert.rejects(rpc.call('crash', { delay: 0 }), {
      status: 500,
      message: 'The live session host could not complete that request.',
    });
  });

  it('honours abort signals and fails pending calls when the host leaves', async () => {
    const [client, server] = pipe();
    const serverChannel = createFrameChannel(server);
    void serveRpc(serverChannel, () => new Promise(() => undefined));
    const rpc = createRpcClient(createFrameChannel(client));
    const controller = new AbortController();
    const aborted = rpc.call('read', {}, controller.signal);
    controller.abort();
    await assert.rejects(aborted, { name: 'AbortError' });
    const stranded = rpc.call('read', {});
    serverChannel.close();
    await assert.rejects(stranded, { message: /ended/ });
    await assert.rejects(rpc.call('read', {}), { message: /ended/ });
    assert.strictEqual(await rpc.closed, null);
  });

  it('times out a host that never answers', async () => {
    const [client, server] = pipe();
    void serveRpc(
      createFrameChannel(server),
      () => new Promise(() => undefined)
    );
    const rpc = createRpcClient(createFrameChannel(client), 20);
    await assert.rejects(rpc.call('read', {}), { message: /did not answer/ });
  });
});
