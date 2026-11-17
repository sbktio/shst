import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrameChannel } from '../src/frames.ts';
import { createRpcClient, serveRpc } from '../src/rpc.ts';
import { dataChannelStream, RTC_MESSAGE_BYTES } from '../src/rtcStream.ts';
import type { DataChannelLike } from '../src/rtcStream.ts';

type Listener = (event: Event) => void;

/** Two linked fake data channels that deliver messages asynchronously. */
function fakeChannelPair(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class FakeChannel implements DataChannelLike {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  peer?: FakeChannel;
  sent: number[] = [];
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: ArrayBuffer): void {
    this.sent.push(data.byteLength);
    const peer = this.peer;
    queueMicrotask(() =>
      peer?.emit('message', new MessageEvent('message', { data }))
    );
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close', new Event('close'));
    this.peer?.close();
  }
}

describe('dataChannelStream', () => {
  it('carries RPC frames, splitting large writes into small messages', async () => {
    const [a, b] = fakeChannelPair();
    void serveRpc(createFrameChannel(dataChannelStream(b)), async (_m, p) => p);
    const rpc = createRpcClient(createFrameChannel(dataChannelStream(a)));
    const big = { text: 'x'.repeat(100_000) };
    assert.deepStrictEqual(await rpc.call('echo', big), big);
    assert.strictEqual(a.binaryType, 'arraybuffer');
    assert.ok(Math.max(...a.sent) <= RTC_MESSAGE_BYTES);
    assert.ok(a.sent.length > 5);
  });

  it('ends reads when the channel closes and refuses later writes', async () => {
    const [a, b] = fakeChannelPair();
    const reader = dataChannelStream(b);
    const writer = dataChannelStream(a);
    const pending = reader.read();
    writer.close();
    assert.strictEqual(await pending, null);
    assert.strictEqual(await reader.read(), null);
    await assert.rejects(writer.write(new Uint8Array([1])), {
      message: /closed/,
    });
  });

  it('waits for the buffer to drain before writing more', async () => {
    const [a] = fakeChannelPair();
    a.bufferedAmount = 8 * 1024 * 1024;
    const stream = dataChannelStream(a);
    let done = false;
    const write = stream.write(new Uint8Array(10)).then(() => {
      done = true;
    });
    await Promise.resolve();
    assert.strictEqual(done, false);
    a.bufferedAmount = 0;
    a.emit('bufferedamountlow', new Event('bufferedamountlow'));
    await write;
    assert.strictEqual(done, true);
  });
});
