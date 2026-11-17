import type {
  WhiteboardDocument,
  WhiteboardEditingLease,
  WhiteboardSnapshot,
} from '@shst/whiteboard';
import { createFrameChannel } from './frames.ts';
import { createRpcClient } from './rpc.ts';
import type { ByteStream, FrameChannel } from './frames.ts';
import type { RpcClient } from './rpc.ts';
import type { WhiteboardApi } from '@shst/whiteboard';

/**
 * `WhiteboardApi` carried over a peer-to-peer byte stream instead of HTTP.
 *
 * The room hook already takes its API as a parameter, so a participant who
 * joins a live session swaps this in and nothing above the transport changes.
 * The method names and parameter shapes deliberately mirror the REST routes so
 * the host can validate them the same way.
 */

export const WHITEBOARD_TAILCAT_PROTOCOL = 'shst-whiteboard/1';
/** The virtual Tailcat port the host answers on; any other port is refused. */
export const WHITEBOARD_TAILCAT_PORT = 7187;

export interface WhiteboardHello {
  t: 'hello';
  protocol: typeof WHITEBOARD_TAILCAT_PROTOCOL;
  name: string;
}

export interface WhiteboardWelcome {
  t: 'welcome';
  protocol: typeof WHITEBOARD_TAILCAT_PROTOCOL;
  /** The identity the host assigned this connection. Peers cannot pick it. */
  peerId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A snapshot from `watch`, with the presence version to send next time. */
export interface WatchSnapshot extends WhiteboardSnapshot {
  presenceVersion: number;
}

/**
 * The Whiteboard API plus `watch`: a request the host holds open until the
 * board or someone else's presence changes (or a timeout passes), so changes
 * are pushed instead of polled. See syncPacing.ts.
 */
export interface TailcatWhiteboardApi extends WhiteboardApi {
  watch(
    id: string,
    revision: number,
    presenceVersion: number,
    signal: AbortSignal
  ): Promise<WatchSnapshot>;
}

export interface TailcatWhiteboardSession {
  api: TailcatWhiteboardApi;
  peerId: string;
  rpc: RpcClient;
}

/** Introduce ourselves to a host and return an API bound to the connection. */
export async function joinWhiteboardSession(
  stream: ByteStream,
  name: string
): Promise<TailcatWhiteboardSession> {
  const channel = createFrameChannel(stream);
  const hello: WhiteboardHello = {
    t: 'hello',
    protocol: WHITEBOARD_TAILCAT_PROTOCOL,
    name,
  };
  await channel.send(hello);
  const frame = await channel.reader.next();
  if (
    frame.done ||
    !isRecord(frame.message) ||
    frame.message.t !== 'welcome' ||
    frame.message.protocol !== WHITEBOARD_TAILCAT_PROTOCOL ||
    typeof frame.message.peerId !== 'string'
  ) {
    channel.close();
    throw new Error('That code is not a compatible live whiteboard session.');
  }
  const rpc = createRpcClient(channel);
  return {
    api: createTailcatWhiteboardApi(rpc),
    peerId: frame.message.peerId,
    rpc,
  };
}

/**
 * Host side of the handshake. Returns the peer's requested display name, or
 * null (after closing) if the connection is not a whiteboard participant.
 */
export async function acceptWhiteboardPeer(
  channel: FrameChannel,
  assignPeerId: () => string
): Promise<{ peerId: string; name: string } | null> {
  const frame = await channel.reader
    .next()
    .catch(() => ({ done: true }) as const);
  if (
    frame.done ||
    !isRecord(frame.message) ||
    frame.message.t !== 'hello' ||
    frame.message.protocol !== WHITEBOARD_TAILCAT_PROTOCOL ||
    typeof frame.message.name !== 'string'
  ) {
    channel.close();
    return null;
  }
  const peerId = assignPeerId();
  const welcome: WhiteboardWelcome = {
    t: 'welcome',
    protocol: WHITEBOARD_TAILCAT_PROTOCOL,
    peerId,
  };
  await channel.send(welcome);
  return {
    peerId,
    name: frame.message.name.trim().slice(0, 60) || 'Creative human',
  };
}

export function createTailcatWhiteboardApi(
  rpc: RpcClient
): TailcatWhiteboardApi {
  return {
    watch: async (
      id,
      revision,
      presenceVersion,
      signal
    ): Promise<WatchSnapshot> =>
      (await rpc.call(
        'watch',
        { id, revision, presenceVersion },
        signal
      )) as WatchSnapshot,
    read: async (id, revision, signal): Promise<WhiteboardSnapshot> =>
      (await rpc.call('read', { id, revision }, signal)) as WhiteboardSnapshot,
    create: async (id, objects, title): Promise<WhiteboardDocument> =>
      (
        (await rpc.call('create', { id, objects, title })) as {
          board: WhiteboardDocument;
        }
      ).board,
    change: async (
      id,
      operations,
      requestId,
      revision,
      sessionId,
      asAgent = false
    ): Promise<WhiteboardDocument> =>
      (
        (await rpc.call('change', {
          id,
          operations,
          requestId,
          revision,
          sessionId,
          asAgent,
        })) as { board: WhiteboardDocument }
      ).board,
    editing: async (
      id,
      sessionId,
      objectId
    ): Promise<WhiteboardEditingLease[]> =>
      (
        (await rpc.call('editing', { id, sessionId, objectId })) as {
          editing: WhiteboardEditingLease[];
        }
      ).editing,
    presence: (
      id,
      sessionId,
      cursor,
      reaction,
      signal,
      profile,
      reactionId
    ): Promise<unknown> =>
      rpc.call(
        'presence',
        { id, sessionId, cursor, reaction, profile, reactionId },
        signal
      ),
    agentPresence: (
      id,
      sessionId,
      cursor,
      activity,
      reaction,
      signal
    ): Promise<unknown> =>
      rpc.call(
        'presence',
        { id, sessionId, cursor, agentActivity: activity, reaction },
        signal
      ),
  };
}
