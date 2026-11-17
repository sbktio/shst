import type { WhiteboardDocument, WhiteboardPerson } from '@shst/whiteboard';

/**
 * A minimal live picture of the shared board for the spike page: notes as
 * coloured squares, everyone's cursor, click to add a note. Remote cursors
 * move as their updates are pushed (paced by the round trip, ~30/s direct).
 */

const SCALE = 0.36; // canvas px per board unit
const NOTE_COLORS: Record<string, string> = {
  lemon: '#ffe680',
  lilac: '#d7c4ff',
  mint: '#b8f0d2',
  peach: '#ffc9a8',
  sky: '#b9ddff',
  cream: '#fff4d6',
};
const PERSON_COLORS = [
  '#7c3aed',
  '#0e7490',
  '#c2410c',
  '#15803d',
  '#be185d',
] as const;

function personColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  // The modulo keeps the index in range; the fallback only satisfies the type.
  return (
    PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length] ?? PERSON_COLORS[0]
  );
}

export interface LiveView {
  /** Omitting people keeps the last known cursors. */
  update(board: WhiteboardDocument | null, people?: WhiteboardPerson[]): void;
  /** The local pointer in board coordinates, or null when outside. */
  cursor(): { x: number; y: number } | null;
}

export function createLiveView(
  canvas: HTMLCanvasElement,
  /** The local participant's name; may change until a session starts. */
  selfName: () => string,
  onPlace: (point: { x: number; y: number }) => void,
  /** Called when the local pointer moves or leaves, to send it promptly. */
  onPointer: () => void = (): void => undefined
): LiveView {
  const context = canvas.getContext('2d');
  let pointer: { x: number; y: number } | null = null;
  let board: WhiteboardDocument | null = null;
  let people: WhiteboardPerson[] = [];

  const toBoard = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((event.clientY - rect.top) / rect.height) * canvas.height;
    return {
      x: Math.round((px - canvas.width / 2) / SCALE),
      y: Math.round((py - canvas.height / 2) / SCALE),
    };
  };
  const toCanvas = (x: number, y: number): [number, number] => [
    canvas.width / 2 + x * SCALE,
    canvas.height / 2 + y * SCALE,
  ];

  const draw = (): void => {
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fafafa';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const object of board?.objects ?? []) {
      const [x, y] = toCanvas(object.x, object.y);
      const w = object.width * SCALE;
      const h = object.height * SCALE;
      context.fillStyle = NOTE_COLORS[object.color] ?? '#eee';
      context.strokeStyle = personColor(object.author);
      context.lineWidth = 2;
      context.fillRect(x, y, w, h);
      context.strokeRect(x, y, w, h);
      context.fillStyle = '#222';
      context.font = '12px system-ui, sans-serif';
      context.fillText(object.author, x + 6, y + 16, w - 12);
      context.font = '11px system-ui, sans-serif';
      context.fillText(object.text.slice(0, 24), x + 6, y + 32, w - 12);
    }
    const cursors = [
      ...people
        .filter((person) => person.cursor && person.name !== selfName())
        .map((person) => ({ name: person.name, point: person.cursor! })),
      ...(pointer ? [{ name: `${selfName()} (you)`, point: pointer }] : []),
    ];
    for (const { name, point } of cursors) {
      const [x, y] = toCanvas(point.x, point.y);
      context.fillStyle = personColor(name.replace(' (you)', ''));
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + 12, y + 5);
      context.lineTo(x + 5, y + 12);
      context.closePath();
      context.fill();
      context.font = 'bold 12px system-ui, sans-serif';
      context.fillText(name, x + 14, y + 18);
    }
  };

  canvas.addEventListener('mousemove', (event) => {
    pointer = toBoard(event);
    draw();
    onPointer();
  });
  canvas.addEventListener('mouseleave', () => {
    pointer = null;
    draw();
    onPointer();
  });
  canvas.addEventListener('click', (event) => onPlace(toBoard(event)));
  draw();

  return {
    update: (nextBoard, nextPeople): void => {
      board = nextBoard ?? board;
      people = nextPeople ?? people;
      draw();
    },
    cursor: () => pointer,
  };
}
