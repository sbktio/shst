import type {
  WhiteboardDocument,
  WhiteboardEditingLease,
  WhiteboardOperation,
  WhiteboardProfile,
  WhiteboardSnapshot,
} from './types.ts';

/**
 * What a whiteboard client calls, whatever carries it. The Tailcat transport
 * implements it over a peer connection; an HTTP client could implement it
 * against a server.
 */
export interface WhiteboardApi {
  read(id: string, revision: number, signal: AbortSignal): Promise<WhiteboardSnapshot>;
  create(
    id: string,
    objects: WhiteboardDocument['objects'],
    title?: string
  ): Promise<WhiteboardDocument>;
  change(
    id: string,
    operations: WhiteboardOperation[],
    requestId: string,
    revision: number,
    sessionId?: string,
    asAgent?: boolean
  ): Promise<WhiteboardDocument>;
  editing(
    id: string,
    sessionId: string,
    objectId: string | null
  ): Promise<WhiteboardEditingLease[]>;
  presence(
    id: string,
    sessionId: string,
    cursor: { x: number; y: number } | null,
    reaction: string | null,
    signal: AbortSignal,
    profile?: WhiteboardProfile,
    reactionId?: string
  ): Promise<unknown>;
  agentPresence(
    id: string,
    sessionId: string,
    cursor: { x: number; y: number } | null,
    activity: string,
    reaction: string | null,
    signal: AbortSignal
  ): Promise<unknown>;
}
