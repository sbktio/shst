import type {
  WhiteboardDocument,
  WhiteboardObject,
  WhiteboardOperation,
} from './types.ts';
import { PersistenceError } from './errors.ts';

const colors = new Set(['lemon', 'lilac', 'mint', 'peach', 'sky', 'cream']);
const kinds = new Set([
  'note',
  'text',
  'frame',
  'sticker',
  'stamp',
  'media',
  'drawing',
]);
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

function invalid(): never {
  throw new PersistenceError(400, 'This board change is invalid or too large.');
}

function validDrawing(drawing: WhiteboardObject['drawing']): boolean {
  return (
    !!drawing &&
    typeof drawing === 'object' &&
    ['ink', 'blue', 'pink', 'green', 'orange'].includes(drawing.color) &&
    finite(drawing.width, 1, 12) &&
    Array.isArray(drawing.points) &&
    drawing.points.length >= 2 &&
    drawing.points.length <= 512 &&
    drawing.points.every(
      (point) =>
        point &&
        typeof point === 'object' &&
        finite(point.x, 0, 1) &&
        finite(point.y, 0, 1)
    )
  );
}

function copyDrawing(
  drawing: NonNullable<WhiteboardObject['drawing']>
): NonNullable<WhiteboardObject['drawing']> {
  return {
    color: drawing.color,
    width: drawing.width,
    points: drawing.points.map(({ x, y }) => ({ x, y })),
  };
}

export function validMedia(media: WhiteboardObject['media']): boolean {
  if (
    !media ||
    typeof media.type !== 'string' ||
    !text(media.name, 200) ||
    !text(media.data, 14_000_000)
  )
    return false;
  const allowed: Record<string, string> = {
    'image/png': 'iVBORw0KGgo',
    'image/jpeg': '/9j/',
    'image/gif': 'R0lGOD',
    'image/webp': 'UklGR',
    'video/mp4': '',
    'video/webm': 'GkXf',
    'audio/mpeg': '',
    'audio/wav': 'UklGR',
    'audio/ogg': 'T2dnUw',
  };
  // hasOwn first, so an inherited name such as 'constructor' is not a type.
  const magic = Object.hasOwn(allowed, media.type)
    ? allowed[media.type]
    : undefined;
  if (magic === undefined) return false;
  const prefix = `data:${media.type};base64,`;
  if (!media.data.startsWith(prefix)) return false;
  const encoded = media.data.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  // atob, not Buffer, so the same check runs in a browser host. Each character
  // of the result is one byte; the magic numbers compared below are ASCII.
  let bytes: string;
  try {
    bytes = atob(encoded);
  } catch {
    return false;
  }
  if (bytes.length > 10 * 1024 * 1024) return false;
  if (media.type === 'video/mp4') return bytes.slice(4, 8) === 'ftyp';
  if (media.type === 'audio/mpeg') {
    return (
      bytes.slice(0, 3) === 'ID3' ||
      (bytes.charCodeAt(0) === 255 && (bytes.charCodeAt(1) & 224) === 224)
    );
  }
  return encoded.startsWith(magic);
}

function validateObject(object: WhiteboardObject): void {
  if (
    !object ||
    !text(object.id, 100) ||
    !object.id ||
    !kinds.has(object.kind) ||
    !colors.has(object.color) ||
    !text(object.text, 5000) ||
    !finite(object.x, -10000, 10000) ||
    !finite(object.y, -10000, 10000) ||
    !finite(object.width, 40, 3000) ||
    !finite(object.height, 40, 3000) ||
    !finite(object.rotation, -180, 180) ||
    !finite(object.fontSize, 8, 96) ||
    (object.media !== undefined &&
      (object.kind !== 'media' || !validMedia(object.media))) ||
    (object.kind === 'media' && !object.media) ||
    (object.drawing !== undefined &&
      (object.kind !== 'drawing' || !validDrawing(object.drawing))) ||
    (object.kind === 'drawing' && !object.drawing)
  )
    invalid();
  if (
    object.anchor !== undefined &&
    object.anchor !== null &&
    (typeof object.anchor !== 'object' ||
      object.kind !== 'stamp' ||
      !text(object.anchor.objectId, 100) ||
      !finite(object.anchor.x, 0, 1) ||
      !finite(object.anchor.y, 0, 1))
  )
    invalid();
  if (
    object.attachments !== undefined &&
    (object.kind !== 'note' ||
      !Array.isArray(object.attachments) ||
      object.attachments.length > 8 ||
      !object.attachments.every(validMedia))
  )
    invalid();
}

/** Atomic batches preserve Idea-board's grouped edits and local undo semantics. */
export function applyWhiteboardOperations(
  current: WhiteboardDocument,
  operations: WhiteboardOperation[],
  actor: { id: string; name: string },
  now: number
): WhiteboardDocument {
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 1000
  )
    invalid();
  const board = structuredClone(current);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') invalid();
    switch (operation.type) {
      case 'create': {
        validateObject(operation.object);
        const source = operation.object;
        if (
          board.objects.length >= 1000 ||
          board.objects.some((o) => o.id === source.id)
        )
          invalid();
        board.objects.push({
          id: source.id,
          kind: source.kind,
          color: source.color,
          text: source.text,
          x: source.x,
          y: source.y,
          width: source.width,
          height: source.height,
          rotation: source.rotation,
          fontSize: source.fontSize,
          author: actor.name,
          votes: {},
          ...(source.drawing ? { drawing: copyDrawing(source.drawing) } : {}),
          ...(source.media
            ? {
                media: {
                  data: source.media.data,
                  name: source.media.name,
                  type: source.media.type,
                },
              }
            : {}),
          ...(source.attachments
            ? {
                attachments: source.attachments.map(({ data, name, type }) => ({
                  data,
                  name,
                  type,
                })),
              }
            : {}),
          ...(source.anchor ? { anchor: { ...source.anchor } } : {}),
        });
        break;
      }
      case 'patch': {
        const object = board.objects.find((o) => o.id === operation.id);
        if (
          !object ||
          !operation.patch ||
          typeof operation.patch !== 'object' ||
          Array.isArray(operation.patch)
        )
          invalid();
        const permitted = new Set([
          'x',
          'y',
          'width',
          'height',
          'rotation',
          'fontSize',
          'text',
          'color',
          'anchor',
          'attachments',
          'drawing',
        ]);
        if (Object.keys(operation.patch).some((key) => !permitted.has(key)))
          invalid();
        const updated = { ...object, ...operation.patch };
        validateObject(updated);
        if (updated.drawing) updated.drawing = copyDrawing(updated.drawing);
        if (updated.attachments)
          updated.attachments = updated.attachments.map(
            ({ data, name, type }) => ({ data, name, type })
          );
        Object.assign(object, updated);
        break;
      }
      case 'delete':
        // A previous delete in this batch may already have removed an anchored stamp.
        if (
          !board.objects.some((o) => o.id === operation.id) &&
          !current.objects.some((o) => o.id === operation.id)
        )
          invalid();
        board.objects = board.objects.filter(
          (o) => o.id !== operation.id && o.anchor?.objectId !== operation.id
        );
        break;
      case 'vote': {
        const object = board.objects.find((o) => o.id === operation.id);
        if (
          !object ||
          !['note', 'media'].includes(object.kind) ||
          ![1, -1].includes(operation.direction)
        )
          invalid();
        object.votes[actor.id] =
          object.votes[actor.id] === operation.direction
            ? 0
            : operation.direction;
        if (object.votes[actor.id]) {
          object.voterNames ??= {};
          object.voterNames[actor.id] = actor.name;
        } else {
          delete object.voterNames?.[actor.id];
        }
        break;
      }
      case 'title':
        if (!text(operation.title, 100) || !operation.title.trim()) invalid();
        board.title = operation.title.trim();
        break;
      case 'timer':
        if (operation.action === 'start') {
          if (!board.timer.endAt)
            board.timer.endAt = now + board.timer.remaining * 1000;
        } else if (operation.action === 'pause') {
          board.timer.remaining = board.timer.endAt
            ? Math.max(0, Math.ceil((board.timer.endAt - now) / 1000))
            : board.timer.remaining;
          board.timer.endAt = null;
        } else if (
          operation.action === 'reset' &&
          finite(operation.seconds, 10, 3600)
        ) {
          board.timer = { endAt: null, remaining: operation.seconds };
        } else invalid();
        break;
      default:
        invalid();
    }
  }
  for (const object of board.objects) {
    if (
      object.anchor &&
      (object.anchor.objectId === object.id ||
        !board.objects.some(
          (parent) => parent.id === object.anchor!.objectId && !parent.anchor
        ))
    )
      invalid();
  }
  if (new TextEncoder().encode(JSON.stringify(board)).byteLength > 24 * 1024 * 1024) {
    throw new PersistenceError(
      413,
      'This board exceeds 24 MB. Remove some media before adding more.'
    );
  }
  board.revision++;
  return board;
}
