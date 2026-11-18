import {
  PersistenceError,
  whiteboardCompanions,
} from '@shst/whiteboard';
import type {
  WhiteboardDocument,
  WhiteboardOperation,
  WhiteboardProfile,
  WhiteboardService,
} from '@shst/whiteboard';
import type { RpcHandler } from '@shst/tailcat-transport';
import { WATCH_WAIT_MS } from '@shst/whiteboard-tailcat';
import type { BrowserWhiteboardStore } from './browserWhiteboardStore';

/**
 * Maps one participant's RPC calls onto the real `WhiteboardService`, with the
 * same validation the REST routes apply (`apps/api/src/routes/whiteboards.ts`).
 *
 * The actor comes from the connection, never from the request: the host
 * assigned `peer.peerId` during the handshake. That stands in for the token
 * claims the HTTP API reads.
 *
 * Prototype note: this imports `apps/api` source directly. Productising the
 * transport means moving `WhiteboardService`, `applyWhiteboardOperations` and
 * these validators into a package that both the API and the browser host use.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REACTIONS = ['👏', '💡', '🎉', '❤️', '🔥', '👀'];

const validId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalid(message: string): never {
  throw new PersistenceError(400, message);
}

function validCursor(value: unknown): value is { x: number; y: number } | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.x === 'number' &&
      typeof value.y === 'number' &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Math.abs(value.x) <= 20000 &&
      Math.abs(value.y) <= 20000)
  );
}

function validProfile(value: unknown): value is WhiteboardProfile {
  return (
    isRecord(value) &&
    typeof value.displayName === 'string' &&
    value.displayName.length <= 40 &&
    (whiteboardCompanions as readonly unknown[]).includes(value.companion) &&
    ['pop', 'wave', 'none'].includes(String(value.entrance))
  );
}

export interface HostPeer {
  peerId: string;
  name: string;
}

export function whiteboardHostHandler(
  service: WhiteboardService,
  store: BrowserWhiteboardStore,
  boardId: string,
  peer: HostPeer
): RpcHandler {
  const actor = { id: peer.peerId, name: peer.name };
  return async (method, params) => {
    if (method === 'info') return { boardId };
    if (!isRecord(params) || !validId(params.id))
      invalid('Invalid whiteboard link.');
    // One host serves one room; a peer cannot reach other boards in the tab.
    if (params.id !== boardId)
      throw new PersistenceError(404, 'This live session hosts another board.');
    const id = params.id;
    switch (method) {
      case 'read': {
        const board = await service.read(id);
        return {
          ...(board.revision !== params.revision ? { board } : {}),
          people: await service.people(id),
          editing: await service.editing(id),
          capabilities: { canvasAgent: true },
          selfId: actor.id,
        };
      }
      case 'watch': {
        // Answer as soon as the board or someone else's presence differs
        // from what the watcher last saw; otherwise hold the request until
        // something changes or WATCH_WAIT_MS passes. The watcher's own cursor
        // never wakes it (it already knows where it is).
        const { revision, presenceVersion } = params;
        if (typeof revision !== 'number' || typeof presenceVersion !== 'number')
          invalid('A watch needs the last revision and presence version.');
        const self = `${actor.id}:`;
        const deadline = Date.now() + WATCH_WAIT_MS;
        for (;;) {
          const board = await service.read(id);
          const version = store.presenceVersion(id, self);
          const remaining = deadline - Date.now();
          if (
            board.revision !== revision ||
            version !== presenceVersion ||
            remaining <= 0
          )
            return {
              ...(board.revision !== revision ? { board } : {}),
              people: await service.people(id),
              editing: await service.editing(id),
              capabilities: { canvasAgent: true },
              selfId: actor.id,
              presenceVersion: version,
            };
          await store.waitForChange(id, self, remaining);
        }
      }
      case 'create': {
        if (!Array.isArray(params.objects))
          invalid('Initial objects are required.');
        const board: WhiteboardDocument = await service.create(
          id,
          actor,
          params.objects as WhiteboardDocument['objects'],
          typeof params.title === 'string' ? params.title : undefined
        );
        return { board };
      }
      case 'change': {
        const { operations, requestId, revision, sessionId, asAgent } = params;
        if (
          !validId(requestId) ||
          !Array.isArray(operations) ||
          typeof revision !== 'number' ||
          !Number.isSafeInteger(revision) ||
          revision < 0 ||
          (sessionId !== undefined && !validId(sessionId)) ||
          (asAgent !== undefined && typeof asAgent !== 'boolean') ||
          (asAgent === true && !validId(sessionId))
        )
          invalid('Operations, revision and request ID are required.');
        const board = await service.change(
          id,
          actor,
          operations as WhiteboardOperation[],
          requestId,
          revision,
          sessionId as string | undefined,
          asAgent === true
        );
        return { board };
      }
      case 'editing': {
        const { sessionId, objectId } = params;
        if (
          !validId(sessionId) ||
          (objectId !== null &&
            (typeof objectId !== 'string' ||
              !objectId ||
              objectId.length > 100))
        )
          invalid('Invalid editing lease.');
        return {
          editing: await service.edit(
            id,
            { id: `${actor.id}:${sessionId}`, name: actor.name },
            objectId as string | null
          ),
        };
      }
      case 'presence': {
        const {
          sessionId,
          cursor,
          reaction,
          reactionId,
          profile,
          agentActivity,
        } = params;
        if (
          !validId(sessionId) ||
          (cursor !== undefined && !validCursor(cursor)) ||
          (reaction !== undefined &&
            reaction !== null &&
            !REACTIONS.includes(String(reaction))) ||
          (reactionId !== undefined && !validId(reactionId)) ||
          (agentActivity !== undefined &&
            (typeof agentActivity !== 'string' ||
              !agentActivity.trim() ||
              agentActivity.length > 120)) ||
          (profile !== undefined && !validProfile(profile))
        )
          invalid('Invalid presence.');
        const point = cursor ? { x: cursor.x, y: cursor.y } : null;
        const emoji = typeof reaction === 'string' ? reaction : null;
        if (typeof agentActivity === 'string') {
          await service.agentPresence(
            id,
            actor,
            sessionId,
            point,
            agentActivity,
            emoji
          );
          return { success: true };
        }
        await service.presence(id, {
          id: `${actor.id}:${sessionId}`,
          name: actor.name,
          cursor: point,
          reaction: emoji,
          ...(emoji && typeof reactionId === 'string' ? { reactionId } : {}),
          ...(profile && validProfile(profile)
            ? {
                profile: {
                  displayName: profile.displayName.trim(),
                  companion: profile.companion,
                  entrance: profile.entrance,
                },
              }
            : {}),
        });
        return { success: true };
      }
      default:
        throw new PersistenceError(400, `Unknown request ${method}.`);
    }
  };
}
