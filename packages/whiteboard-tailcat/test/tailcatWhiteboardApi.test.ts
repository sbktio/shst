import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFrameChannel,
  createMemoryPipe,
  serveRpc,
  type ByteStream,
} from '@shst/tailcat-transport';
import {
  acceptWhiteboardPeer,
  joinWhiteboardSession,
} from '../src/tailcatWhiteboardApi.ts';

/** Every write arrives in two pieces, proving frames are reassembled. */
const pipe = (): [ByteStream, ByteStream] =>
  createMemoryPipe({ splitWrites: true });

describe('whiteboard session handshake', () => {
  it('assigns the peer identity on the host and maps the API onto RPC', async () => {
    const [client, server] = pipe();
    const seen: { method: string; params: unknown; peer: string }[] = [];
    void (async () => {
      const channel = createFrameChannel(server);
      const peer = await acceptWhiteboardPeer(channel, () => 'peer-1');
      if (!peer) return;
      await serveRpc(channel, async (method, params) => {
        seen.push({ method, params, peer: peer.peerId });
        if (method === 'read') return { people: [], selfId: peer.peerId };
        return { board: { id: 'b', revision: 2 } };
      });
    })();
    const session = await joinWhiteboardSession(client, '  Ada  ');
    assert.strictEqual(session.peerId, 'peer-1');
    const controller = new AbortController();
    assert.deepStrictEqual(await session.api.read('b', 1, controller.signal), {
      people: [],
      selfId: 'peer-1',
    });
    assert.deepStrictEqual(
      await session.api.change(
        'b',
        [{ type: 'title', title: 'T' }],
        'r',
        1,
        's'
      ),
      { id: 'b', revision: 2 }
    );
    await session.api.agentPresence(
      'b',
      's',
      null,
      'Thinking',
      null,
      controller.signal
    );
    assert.deepStrictEqual(seen.map((call) => call.method), [
      'read',
      'change',
      'presence',
    ]);
    // Partial match: params is an object whose agentActivity is 'Thinking'.
    const presence = seen[2]?.params;
    assert.ok(typeof presence === 'object' && presence !== null);
    assert.ok('agentActivity' in presence);
    assert.strictEqual(presence.agentActivity, 'Thinking');
  });

  it('refuses a peer that does not speak the protocol', async () => {
    const [client, server] = pipe();
    const accepted = acceptWhiteboardPeer(
      createFrameChannel(server),
      () => 'x'
    );
    await createFrameChannel(client).send({
      t: 'hello',
      protocol: 'other/1',
      name: 'x',
    });
    assert.strictEqual(await accepted, null);
  });
});
