export type WhiteboardColor =
  | 'lemon'
  | 'lilac'
  | 'mint'
  | 'peach'
  | 'sky'
  | 'cream';
export type WhiteboardKind =
  | 'note'
  | 'text'
  | 'frame'
  | 'sticker'
  | 'stamp'
  | 'media'
  | 'drawing';

export interface WhiteboardDrawing {
  points: { x: number; y: number }[];
  color: 'ink' | 'blue' | 'pink' | 'green' | 'orange';
  width: number;
}

export interface WhiteboardObject {
  id: string;
  kind: WhiteboardKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: WhiteboardColor;
  text: string;
  author: string;
  fontSize: number;
  drawing?: WhiteboardDrawing;
  votes: Record<string, number>;
  /** Authenticated voter names retained when room presence expires. */
  voterNames?: Record<string, string>;
  media?: { data: string; name: string; type: string };
  attachments?: { data: string; name: string; type: string }[];
  anchor?: { objectId: string; x: number; y: number } | null;
}

export interface WhiteboardDocument {
  id: string;
  title: string;
  objects: WhiteboardObject[];
  revision: number;
  timer: { endAt: number | null; remaining: number };
}

export interface WhiteboardPerson {
  id: string;
  name: string;
  cursor: { x: number; y: number } | null;
  reaction: string | null;
  reactionId?: string;
  profile?: WhiteboardProfile;
  agent?: { ownerId: string; activity: string };
}

export const whiteboardCompanions = [
  '🦊',
  '🐱',
  '🦉',
  '🤖',
  '🐸',
  '🦄',
] as const;
export interface WhiteboardProfile {
  displayName: string;
  companion: (typeof whiteboardCompanions)[number];
  entrance: 'pop' | 'wave' | 'none';
}

export interface WhiteboardEditingLease {
  objectId: string;
  personId: string;
  name: string;
  expiresAt: number;
}

export interface WhiteboardSnapshot {
  board?: WhiteboardDocument;
  people: WhiteboardPerson[];
  editing?: WhiteboardEditingLease[];
  capabilities?: { canvasAgent: true };
  selfId?: string;
}

export type WhiteboardPatch = Partial<
  Pick<
    WhiteboardObject,
    | 'x'
    | 'y'
    | 'width'
    | 'height'
    | 'rotation'
    | 'color'
    | 'text'
    | 'fontSize'
    | 'anchor'
    | 'attachments'
    | 'drawing'
  >
>;

export type WhiteboardOperation =
  | { type: 'create'; object: WhiteboardObject }
  | { type: 'patch'; id: string; patch: WhiteboardPatch }
  | { type: 'delete'; id: string }
  | { type: 'vote'; id: string; direction: 1 | -1 }
  | { type: 'title'; title: string }
  | { type: 'timer'; action: 'start' | 'pause' | 'reset'; seconds?: number };
