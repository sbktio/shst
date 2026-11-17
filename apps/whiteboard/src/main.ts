import { WhiteboardService } from '@shst/whiteboard';
import {
  acceptWhiteboardPeer,
  answerDirectSession,
  createFrameChannel,
  createMemoryPipe,
  createRpcClient,
  createTailcatWhiteboardApi,
  joinWhiteboardSession,
  loadTailcatRuntime,
  offerDirectSession,
  serveRpc,
  unlockLocalAddresses,
} from '@shst/tailcat-transport';
import { BrowserWhiteboardStore } from './browserWhiteboardStore';
import { createOptionsControl } from './controls';
import { createAnnouncer } from './announce';
import { createCodeCopy } from './codeCopy';
import { createPingTooltip } from './pingTooltip';
import { createBoardStroke } from './boardStroke';
import { startRelayPing } from './relayPing';
import { createLiveView } from './liveView';
import { startLiveSync } from './liveSync';
import {
  describeConnection,
  describeLink,
  pingReading,
  renderPing,
  renderStatus,
} from './statusView';
import { whiteboardHostHandler } from './whiteboardHost';
import type {
  WhiteboardApi,
  WhiteboardDocument,
  WhiteboardObject,
} from '@shst/whiteboard';
import type {
  ByteStream,
  RpcHandler,
  RtcOptions,
  RtcPath,
  RtcSession,
  RtcSignal,
  TailcatWhiteboardApi,
} from '@shst/tailcat-transport';
import type { HostPeer } from './whiteboardHost';
import type { LiveSync } from './liveSync';
import type { LiveView } from './liveView';
import type { RelayPing } from './relayPing';
import type { RttMeasure, TransportLink } from './statusView';

/**
 * Two-tab Tailcat transport spike.
 *
 *   ?role=host&name=Henry            → hosts a board in this tab, prints a code
 *   ?role=join&name=Ada&code=tc…     → dials the code, drives the WhiteboardApi
 *
 * Changes are pushed: every participant keeps one `watch` open and sends its
 * cursor as it moves (liveSync.ts). The host joins its own board through an
 * in-memory pipe. In ?role= automation the joiner also runs a benchmark.
 */

interface Summary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

interface SpikeState {
  role: 'host' | 'join' | 'idle';
  phase:
    | 'idle'
    | 'loading'
    | 'hosting'
    | 'connecting'
    | 'running'
    | 'done'
    | 'failed';
  code?: string;
  /** Characters in the full tailcat address the code stands for. */
  addrLength?: number;
  region?: string;
  regionProbesMs?: Record<string, number>;
  allowRelay: boolean;
  /**
   * ?rtc=on (default) upgrades to a direct WebRTC data channel; off skips it;
   * blocked forces ICE to relay-only with no TURN servers, which leaves no
   * usable candidates and so simulates a network that blocks UDP.
   */
  rtc: 'on' | 'lan' | 'off' | 'blocked';
  /** Joiner: which path carries board data after setup. */
  transport?: 'webrtc-direct' | 'tailcat-relay';
  rtcPath?: RtcPath | null;
  /** Joiner: its link to the host. Host: one per joiner. */
  links: TransportLink[];
  /** The watch is failing and backing off. */
  retrying: boolean;
  /** Traffic counters: watch answers received and presence updates sent. */
  traffic: { watches: number; presences: number };
  /** The session's transport path, re-read each render. */
  path?: { direct: boolean; via: string };
  /** Host only: sessions the relay policy refused. */
  refused: { direct: boolean; via: string }[];
  boardId?: string;
  timings: Record<string, number>;
  summary: Record<string, Summary>;
  /** Host only: ms from a joiner's save being sent to the host's poll seeing it. */
  propagationMs: number[];
  people: string[];
  /** Everyone present except this tab. */
  others: string[];
  log: string[];
  errors: string[];
}

const query = new URLSearchParams(location.search);
/** Name, relay and rtc, mirrored in the URL. */
const options = createOptionsControl(document);

const state: SpikeState = {
  role: 'idle',
  phase: 'idle',
  // relay=deny keeps board data off the relay: the Tailcat session then
  // carries only WebRTC signalling. Anything else allows relayed data.
  allowRelay: options.get().relay !== 'deny',
  rtc: options.get().rtc,
  links: [],
  retrying: false,
  traffic: { watches: 0, presences: 0 },
  refused: [],
  timings: {},
  summary: {},
  propagationMs: [],
  people: [],
  others: [],
  log: [],
  errors: [],
};
(window as unknown as { tailcatSpike: SpikeState }).tailcatSpike = state;

const samples = new Map<string, number[]>();
const output = document.getElementById('state') as HTMLPreElement;
const raw = document.getElementById('raw') as HTMLElement;
const rawToggle = document.getElementById('raw-toggle') as HTMLButtonElement;
const rawOpen = (): boolean => raw.matches(':popover-open');
const codeOutput = document.getElementById('code') as HTMLInputElement;
const chipsOutput = document.getElementById('chips') as HTMLElement;
const pingOutput = document.getElementById('ping') as HTMLElement;
const pingTooltip = createPingTooltip(
  pingOutput,
  document.getElementById('ping-tip') as HTMLElement
);
const boardWrap = document.querySelector('.board-wrap') as HTMLElement;
const optionsPanel = document.getElementById('options') as HTMLElement;
const announcer = createAnnouncer(
  document.getElementById('announce') as HTMLElement
);
const codeButton = document.getElementById('code-copy') as HTMLButtonElement;
const codeCopy = createCodeCopy(codeButton, announcer);

/** Transport changes go to the console rather than onto the page. */
function logLink(event: string, link: TransportLink): void {
  console.info(
    `[Collab Whiteboard] ${event} — ${describeLink(link, state.role)}`
  );
}

/** Who was present last poll, to announce arrivals and departures. */
let knownOthers: Set<string> | undefined;
function announcePresence(others: string[]): void {
  const now = new Set(others);
  const pathOf = (name: string): string => {
    const link =
      state.role === 'host'
        ? state.links.find((entry) => entry.name === name)
        : state.links[0];
    if (!link) return '';
    return link.direct ? ' · direct' : ' · relayed';
  };
  if (!knownOthers) {
    if (state.role === 'join' && others[0] !== undefined)
      announcer.announce(`Joined ${others.join(', ')}${pathOf(others[0])}`);
  } else {
    for (const name of now)
      if (!knownOthers.has(name)) {
        announcer.announce(
          `${name} joined${state.role === 'host' ? pathOf(name) : ''}`
        );
      }
    for (const name of knownOthers)
      if (!now.has(name)) announcer.announce(`${name} left`);
  }
  knownOthers = now;
}
const modeToggle = document.getElementById('mode') as HTMLElement;
const hostButton = document.getElementById('host') as HTMLButtonElement;
const joinButton = document.getElementById('join') as HTMLButtonElement;
const JOIN_PLACEHOLDER = codeOutput.placeholder;

/**
 * Started from the page's controls rather than a ?role= automation link: run
 * the room loop until the tab closes, draw the board, and let clicks add
 * notes, instead of the timed benchmark.
 */
const demo = !query.get('role');
/** The name this tab joined with; fixed once a session starts. */
let sessionName: string | undefined;
const displayName = (): string =>
  sessionName ?? (options.get().name.trim() || 'Guest');

options.onChange(() => render());

function setMode(mode: 'host' | 'join'): void {
  hostButton.setAttribute('aria-pressed', String(mode === 'host'));
  joinButton.setAttribute('aria-pressed', String(mode === 'join'));
}

/** Draw attention to Host/Join when the board is clicked before a session. */
function nudgeMode(): void {
  modeToggle.classList.remove('nudge');
  void modeToggle.offsetWidth; // restart the animation
  modeToggle.classList.add('nudge');
}
modeToggle.addEventListener('animationend', () =>
  modeToggle.classList.remove('nudge')
);

let place: ((point: { x: number; y: number }) => void) | undefined;
/** The running sync; the board nudges it when the pointer moves. */
let activeSync: LiveSync | undefined;
const view: LiveView = createLiveView(
  document.getElementById('board') as HTMLCanvasElement,
  displayName,
  (point) => (place ? place(point) : nudgeMode()),
  () => activeSync?.nudge()
);
const stroke = createBoardStroke(boardWrap);

/**
 * A closed tab's connection can take ~30 s to time out, so the host counts a
 * link only while that person is present, or for a few seconds after it
 * opens (before their first presence arrives).
 */
const LINK_GRACE_MS = 5000;
function activeLinks(): TransportLink[] {
  if (state.role !== 'host') return state.links;
  return state.links.filter(
    (link) =>
      state.others.includes(link.name) ||
      Date.now() - (link.since ?? 0) < LINK_GRACE_MS
  );
}

/** The host's round trip to its relay; set once hosting starts. */
let relayPing: RelayPing | undefined;

/**
 * The round trip the ping meter shows, for the path that carries board data.
 *
 * Direct WebRTC (a joiner's state.transport is 'webrtc-direct'; a host's
 * joiners are all direct): the data path's own round trip, the selected ICE
 * candidate pair's RTT that trackRtcPath re-reads every 2 s. A host with
 * several direct joiners shows the slowest.
 *
 * Relayed: a joiner times its presence updates to the host through the relay
 * (median of the last five; the first, which includes connection setup, is
 * skipped). The host's own requests never leave the tab, so it shows its
 * round trip to the relay instead.
 */
function measuredRtt(): RttMeasure {
  const links = activeLinks();
  const direct =
    state.role === 'join'
      ? state.transport === 'webrtc-direct' && Boolean(links[0]?.direct)
      : links.length > 0 && links.every((link) => link.direct);
  if (direct) {
    const rtts = links.map((link) => link.rtcPath?.iceRttMs);
    const known = rtts.filter((ms): ms is number => ms !== undefined);
    return {
      source: 'webrtc',
      ms: known.length === rtts.length ? Math.max(...known) : undefined,
      to:
        state.role === 'join'
          ? 'the host'
          : links.length === 1 && links[0]
            ? links[0].name
            : 'the slowest participant',
    };
  }
  if (state.role === 'join') {
    const settled = (samples.get('presence') ?? []).slice(1);
    const to = 'the host over the relay';
    if (!settled.length) return { source: 'relay', to };
    const recent = settled.slice(-5).sort((a, b) => a - b);
    return { source: 'relay', ms: recent[Math.floor(recent.length / 2)], to };
  }
  return {
    source: 'relay',
    ms: relayPing?.latestMs(),
    to: state.region ? `the relay (${state.region})` : 'the relay',
  };
}
let latestRevision = 0;
let saveQueue: Promise<void> = Promise.resolve();

/** Errors show briefly as a pill; the full list stays in raw state. */
const ERROR_SHOW_MS = 6000;
let errorsSeen = 0;
let errorAt = 0;

/**
 * Status renders at most every 200 ms, so a 50 ms poll does not rewrite the
 * page 20 times a second.
 */
const RENDER_EVERY_MS = 200;
let lastRender = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let errorTimer: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  const due = lastRender + RENDER_EVERY_MS - performance.now();
  if (due > 0) {
    renderTimer ??= setTimeout(() => {
      renderTimer = undefined;
      render();
    }, due);
    return;
  }
  lastRender = performance.now();
  for (const [key, values] of samples) state.summary[key] = summarize(values);
  if (rawOpen()) output.textContent = JSON.stringify(state, null, 2);
  if (state.errors.length !== errorsSeen) {
    errorsSeen = state.errors.length;
    errorAt = Date.now();
  }
  // In a session the code becomes a button that copies it: the host's
  // generated code, or the one a joiner typed once they are in.
  const sessionCode =
    state.role === 'host' && state.phase === 'hosting'
      ? state.code
      : state.role === 'join' &&
          (state.phase === 'running' || state.phase === 'done')
        ? codeOutput.value.trim()
        : undefined;
  if (state.role === 'host' && state.code && codeOutput.value !== state.code)
    codeOutput.value = state.code;
  const refocus = Boolean(sessionCode) && document.activeElement === codeOutput;
  codeOutput.hidden = Boolean(sessionCode);
  codeCopy.setCode(sessionCode);
  if (refocus) codeButton.focus();
  // Blue while waiting for someone to join, easing back once they do.
  codeButton.classList.toggle(
    'waiting',
    state.role === 'host' && activeLinks().length === 0
  );
  // In a session means hosting or joined; others present lifts it further.
  const connected =
    (state.role === 'host' && state.phase === 'hosting') ||
    (state.role === 'join' && state.phase === 'running');
  const company = connected && state.others.length > 0;
  boardWrap.dataset.elevation = company ? '4' : connected ? '2' : '0';
  stroke.setMode(company ? 'live' : connected ? 'waiting' : 'idle');
  // Session options only matter before a session: hide them once connected
  // (CSS eases them out after the settle delay), show them again otherwise.
  const open = String(!connected);
  if (optionsPanel.dataset.open !== open) {
    optionsPanel.dataset.open = open;
    optionsPanel.inert = connected;
  }
  const reading = pingReading(state.role, measuredRtt(), {
    retrying: state.retrying,
    details: describeConnection(state.role, state.region, activeLinks()),
  });
  renderPing(pingOutput, reading);
  pingTooltip.update(reading);
  renderStatus(chipsOutput, {
    role: state.role,
    phase: state.phase,
    region: state.region,
    others: state.others,
    links: activeLinks(),
    error:
      Date.now() - errorAt < ERROR_SHOW_MS ? state.errors.at(-1) : undefined,
  });
  // Let an error pill disappear on time even if nothing else changes.
  if (Date.now() - errorAt < ERROR_SHOW_MS) {
    clearTimeout(errorTimer);
    errorTimer = setTimeout(
      render,
      ERROR_SHOW_MS - (Date.now() - errorAt) + 20
    );
  }
}
raw.addEventListener('toggle', () => {
  rawToggle.setAttribute('aria-expanded', String(rawOpen()));
  if (rawOpen()) output.textContent = JSON.stringify(state, null, 2);
});

/** Re-read a WebRTC path every 2 s while it is open (RTT, bytes). */
function trackRtcPath(rtc: RtcSession, link: TransportLink): () => void {
  const timer = setInterval(() => {
    void rtc.path().then((path) => {
      link.rtcPath = path;
      if (state.role === 'join') state.rtcPath = path;
      render();
    });
  }, 2000);
  return () => clearInterval(timer);
}

function note(line: string): void {
  state.log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  render();
}

function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    );
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}

async function timed<T>(key: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  const list = samples.get(key) ?? [];
  list.push(performance.now() - start);
  if (list.length > 2000) list.splice(0, list.length - 2000);
  samples.set(key, list);
  return result;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const WASM_BASE = '/tailcat/';

/** Console narration for one WebRTC negotiation. */
const rtcLog =
  (who: string) =>
  (line: string): void =>
    console.info(`[Collab Whiteboard] WebRTC ${who}: ${line}`);

/**
 * Keep this tab in sync with the session (see liveSync.ts): one open watch
 * for pushed changes, and the cursor sent as it moves.
 */
function runSync(
  api: TailcatWhiteboardApi,
  boardId: string,
  name: string,
  onBoard: (board: WhiteboardDocument) => void
): LiveSync {
  const sync = startLiveSync({
    api,
    boardId,
    name,
    cursor: () =>
      demo
        ? view.cursor()
        : {
            x: Math.round(Math.random() * 800),
            y: Math.round(Math.random() * 600),
          },
    onSnapshot: (snapshot, sessionId) => {
      state.traffic.watches++;
      if (snapshot.board) {
        latestRevision = Math.max(latestRevision, snapshot.board.revision);
        onBoard(snapshot.board);
      }
      state.people = snapshot.people.map((person) => person.name);
      state.others = snapshot.people
        .filter((person) => !person.id.endsWith(`:${sessionId}`))
        .map((person) => person.name);
      announcePresence(state.others);
      view.update(snapshot.board ?? null, snapshot.people);
      render();
    },
    onPresenceRtt: (ms) => {
      state.traffic.presences++;
      const list = samples.get('presence') ?? [];
      list.push(ms);
      if (list.length > 2000) list.splice(0, list.length - 2000);
      samples.set('presence', list);
    },
    onError: (message) => {
      state.errors.push(message);
      render();
    },
    onRetrying: (retrying) => {
      state.retrying = retrying;
      render();
    },
  });
  activeSync = sync;
  return sync;
}

async function host(name: string): Promise<void> {
  state.role = 'host';
  state.phase = 'loading';
  codeOutput.value = '';
  codeOutput.placeholder = 'Finding relay…';
  render();
  const loadStart = performance.now();
  const tailcat = await loadTailcatRuntime(WASM_BASE);
  state.timings.wasmLoadMs = Math.round(performance.now() - loadStart);

  const store = new BrowserWhiteboardStore();
  const service = new WhiteboardService(store);
  const boardId = crypto.randomUUID();
  state.boardId = boardId;
  // Expire presence promptly, so departures reach open watches.
  const sweep = setInterval(() => void store.collectExpired(Date.now()), 1000);
  window.addEventListener('pagehide', () => clearInterval(sweep));

  const serveDirect = async (
    rtc: RtcSession,
    peer: HostPeer,
    link: TransportLink
  ): Promise<void> => {
    link.rtcPath = await rtc.path();
    link.direct = true;
    note(`${peer.name} moved to WebRTC ${link.rtcPath?.pair ?? ''}`);
    logLink(`${peer.name} moved to WebRTC`, link);
    const stopTracking = trackRtcPath(rtc, link);
    try {
      await serveRpc(
        createFrameChannel(rtc.stream),
        whiteboardHostHandler(service, store, boardId, peer)
      );
    } finally {
      stopTracking();
      rtc.close();
      link.direct = false;
      link.rtcPath = undefined;
      note(`${peer.name}'s WebRTC channel closed`);
      logLink(`${peer.name}'s WebRTC channel closed`, link);
    }
  };

  const servePeer = async (
    stream: ByteStream,
    via: string,
    overRelay: boolean
  ): Promise<void> => {
    const channel = createFrameChannel(stream);
    const peer = await acceptWhiteboardPeer(channel, () => crypto.randomUUID());
    if (!peer) {
      note(`refused a ${via} connection that did not speak the protocol`);
      return;
    }
    note(`${peer.name} joined via ${via}`);
    const link: TransportLink = {
      name: peer.name,
      direct: false,
      tailcatVia: via.replace(/^tailcat /, ''),
      since: Date.now(),
    };
    if (overRelay) {
      state.links.push(link);
      logLink(`${peer.name} connected`, link);
    }
    const board = whiteboardHostHandler(service, store, boardId, peer);
    // The Tailcat session is the signalling channel. The WebRTC channel it
    // negotiates is served with the same peer identity.
    const handler: RpcHandler = async (method, params) => {
      if (overRelay && method === 'rtcOffer')
        return answerDirectSession(
          params,
          (rtc) => {
            void serveDirect(rtc, peer, link);
          },
          { log: rtcLog(`with ${peer.name}`) }
        );
      if (overRelay && !state.allowRelay && method !== 'info')
        throw Object.assign(
          new Error(
            'Board data only travels over a direct path in this session.'
          ),
          { status: 403 }
        );
      return board(method, params);
    };
    try {
      await serveRpc(channel, handler);
    } catch (error) {
      note(
        `${peer.name} errored: ${error instanceof Error ? error.message : error}`
      );
    } finally {
      channel.close();
      state.links = state.links.filter((entry) => entry !== link);
      if (overRelay) console.info(`[Collab Whiteboard] ${peer.name} left`);
      note(`${peer.name} left`);
    }
  };

  // The host is a participant too, over the same RPC path with no network.
  const [hostEnd, serverEnd] = createMemoryPipe();
  void servePeer(serverEnd, 'memory', false);
  const self = await joinWhiteboardSession(hostEnd, name);
  await self.api.create(boardId, [], 'Collab Whiteboard');

  const listenStart = performance.now();
  const session = await tailcat.host({
    // Relay policy for board data is enforced above; the Tailcat session
    // itself must be allowed on the relay to carry signalling.
    allowRelay: true,
    onConnection: (conn) => {
      state.path = conn.path();
      void servePeer(conn, `tailcat ${conn.path().via}`, true);
    },
    onRefused: (path) => {
      state.refused.push(path);
      note(`refused a session via ${path.via}: relay is denied`);
    },
  });
  state.timings.listenMs = Math.round(performance.now() - listenStart);
  state.code = session.code;
  state.addrLength = session.addr.length;
  state.region = session.region;
  state.regionProbesMs = session.regionProbes;
  void startRelayPing(session.regionId).then(
    (ping) => {
      relayPing = ping;
      window.addEventListener('pagehide', () => ping.stop());
    },
    (error: unknown) =>
      console.info('[Collab Whiteboard] Could not ping the relay', error)
  );
  state.phase = 'hosting';
  note(`hosting on ${session.region}; share the code`);
  window.addEventListener('pagehide', () => session.close());
  place = (point): void => addNote(self.api, boardId, name, point);

  const seen = new Set<string>();
  runSync(self.api, boardId, name, (board) => {
    for (const object of board.objects) {
      const sent = /^spike:(\d+)$/.exec(object.text);
      if (!sent || seen.has(object.id)) continue;
      seen.add(object.id);
      state.propagationMs.push(Date.now() - Number(sent[1]));
    }
  });
}

/** Save a note at a clicked point over whichever transport is in use. */
function addNote(
  api: WhiteboardApi,
  boardId: string,
  author: string,
  point: { x: number; y: number }
): void {
  const object: WhiteboardObject = {
    ...spikeNote(author, new Date().toLocaleTimeString()),
    x: Math.max(-10000, Math.min(10000, point.x - 90)),
    y: Math.max(-10000, Math.min(10000, point.y - 90)),
  };
  const save = (revision: number): Promise<WhiteboardDocument> =>
    timed('change', () =>
      api.change(
        boardId,
        [{ type: 'create', object }],
        crypto.randomUUID(),
        revision
      )
    );
  // Saves are optimistic on the revision. Queue this tab's saves, as the room
  // hook does, and if the other person saved first, re-read and try again
  // (adding a note never conflicts with anyone's content).
  const attempt = async (): Promise<WhiteboardDocument> => {
    for (let tries = 0; ; tries++) {
      try {
        return await save(latestRevision);
      } catch (error) {
        if (
          tries >= 3 ||
          !(error instanceof Error && /changed the board/.test(error.message))
        )
          throw error;
        const fresh = await api.read(boardId, -1, new AbortController().signal);
        latestRevision = fresh.board?.revision ?? latestRevision;
      }
    }
  };
  const queued = saveQueue.then(attempt);
  saveQueue = queued.then(
    () => undefined,
    () => undefined
  );
  void queued.then(
    (board) => {
      latestRevision = Math.max(latestRevision, board.revision);
      view.update(board);
      render();
    },
    (error: unknown) => {
      state.errors.push(error instanceof Error ? error.message : String(error));
      render();
    }
  );
}

function spikeNote(author: string, text: string): WhiteboardObject {
  return {
    id: crypto.randomUUID(),
    kind: 'note',
    x: Math.round(Math.random() * 2000 - 1000),
    y: Math.round(Math.random() * 2000 - 1000),
    width: 180,
    height: 180,
    rotation: 0,
    color: 'lemon',
    text,
    author,
    fontSize: 18,
    votes: {},
  };
}

/** A note with a ~1 MB base64 PNG-shaped attachment, to measure bulk transfer. */
function bulkNote(author: string): WhiteboardObject {
  const bytes = new Uint8Array(768 * 1024);
  for (let offset = 0; offset < bytes.length; offset += 65536)
    crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return {
    ...spikeNote(author, 'bulk'),
    attachments: [
      {
        name: 'noise.png',
        type: 'image/png',
        data: `data:image/png;base64,iVBORw0KGgo${btoa(binary)}`,
      },
    ],
  };
}

async function join(
  name: string,
  code: string,
  seconds: number
): Promise<void> {
  state.role = 'join';
  state.phase = 'loading';
  render();
  const loadStart = performance.now();
  const tailcat = await loadTailcatRuntime(WASM_BASE);
  state.timings.wasmLoadMs = Math.round(performance.now() - loadStart);

  state.phase = 'connecting';
  render();
  const dialStart = performance.now();
  const { conn, timings } = await tailcat.join({
    code,
    // Signalling always rides the Tailcat session; board data is gated below.
    allowRelay: true,
    directTimeoutMs: 15000,
  });
  state.timings.dialMs = Math.round(performance.now() - dialStart);
  for (const [key, value] of Object.entries(timings))
    state.timings[`join.${key}`] = value;
  state.path = conn.path();
  const link: TransportLink = {
    name: 'host',
    direct: false,
    tailcatVia: conn.path().via,
  };
  state.links = [link];
  logLink('Connected to the host', link);
  const pathTimer = setInterval(() => {
    state.path = conn.path();
    link.tailcatVia = state.path.via;
  }, 1000);
  const handshakeStart = performance.now();
  const session = await joinWhiteboardSession(conn, name);
  state.timings.handshakeMs = Math.round(performance.now() - handshakeStart);
  const { boardId } = (await session.rpc.call('info', {})) as {
    boardId: string;
  };
  state.boardId = boardId;
  note(`joined as ${session.peerId}`);

  // Move board data to a direct WebRTC channel, signalled over the session.
  // Resolves to the direct API, or undefined if no direct path was found.
  state.transport = 'tailcat-relay';
  const upgrade = async (): Promise<TailcatWhiteboardApi | undefined> => {
    if (state.rtc === 'off') return undefined;
    const rtcOptions: RtcOptions = {
      log: rtcLog('to the host'),
      ...(state.rtc === 'blocked' ? { iceTransportPolicy: 'relay' } : {}),
    };
    const upgradeStart = performance.now();
    try {
      const direct = await offerDirectSession(
        async (offer) =>
          (await session.rpc.call('rtcOffer', offer)) as RtcSignal,
        rtcOptions
      );
      state.transport = 'webrtc-direct';
      state.rtcPath = await direct.path();
      link.direct = true;
      link.rtcPath = state.rtcPath;
      trackRtcPath(direct, link);
      for (const [key, value] of Object.entries(direct.timings))
        state.timings[`rtc.${key}`] = value;
      note(`moved to WebRTC ${state.rtcPath?.pair ?? ''}`);
      logLink('Moved to WebRTC', link);
      return createTailcatWhiteboardApi(
        createRpcClient(createFrameChannel(direct.stream))
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      note(`WebRTC upgrade failed: ${reason}`);
      console.info(
        `[Collab Whiteboard] WebRTC upgrade failed (${reason}); ${state.allowRelay ? 'staying on the relay' : 'relay not allowed for board data'}`
      );
      return undefined;
    } finally {
      state.timings.upgradeMs = Math.round(performance.now() - upgradeStart);
      render();
    }
  };
  const refuse = (): never => {
    throw new Error(
      'no direct path to the host; board data is not sent over the relay in this session'
    );
  };

  if (demo && state.allowRelay) {
    // Start on the relay straight away; switch to WebRTC if it connects.
    let api: TailcatWhiteboardApi = session.api;
    place = (point): void => addNote(api, boardId, name, point);
    const sync = runSync(api, boardId, name, () => render());
    state.phase = 'running';
    note('live: move over the board to share your cursor, click to add a note');
    render();
    const direct = await upgrade();
    if (direct) {
      api = direct;
      sync.setApi(direct);
    }
    await sync.done;
    return;
  }

  // Relay denied (or a benchmark run): settle the path before syncing.
  const direct = await upgrade();
  if (!direct && !state.allowRelay) refuse();
  const api: TailcatWhiteboardApi = direct ?? session.api;
  state.phase = 'running';
  render();

  if (demo) {
    place = (point): void => addNote(api, boardId, name, point);
    note('live: move over the board to share your cursor, click to add a note');
    await runSync(api, boardId, name, () => render()).done;
    return;
  }

  // 1. Back-to-back small round trips: the transport's floor.
  let latest = await api.read(boardId, -1, new AbortController().signal);
  for (let index = 0; index < 30; index++)
    latest = await timed('probe', () =>
      api.read(
        boardId,
        latest.board?.revision ?? -1,
        new AbortController().signal
      )
    ).then((snapshot) => (snapshot.board ? snapshot : latest));
  render();

  // 2. Live sync with saves interleaved.
  let revision = latest.board?.revision ?? 0;
  const sync = runSync(api, boardId, name, (board) => {
    revision = Math.max(revision, board.revision);
  });
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      const board = await timed('change', () =>
        api.change(
          boardId,
          [{ type: 'create', object: spikeNote(name, `spike:${Date.now()}`) }],
          crypto.randomUUID(),
          revision
        )
      );
      revision = board.revision;
    } catch (error) {
      // A 409 means a read raced the save; the room would retry the same way.
      state.errors.push(error instanceof Error ? error.message : String(error));
    }
    render();
  }

  // 3. One bulk save, about 1 MB on the wire.
  try {
    const board = await timed('bulk1MB', () =>
      api.change(
        boardId,
        [{ type: 'create', object: bulkNote(name) }],
        crypto.randomUUID(),
        revision
      )
    );
    revision = board.revision;
  } catch (error) {
    state.errors.push(error instanceof Error ? error.message : String(error));
  }
  sync.stop();
  await sync.done;
  clearInterval(pathTimer);
  state.path = conn.path();
  state.phase = 'done';
  note('done');
}

const params = query;

/** Begin a session with the current options, locking the ones it uses. */
function begin(
  mode: 'host' | 'join',
  work: (name: string) => Promise<void>
): void {
  if (state.role !== 'idle' && state.phase !== 'failed') return;
  const current = options.get();
  sessionName = current.name.trim() || 'Guest';
  state.role = 'idle';
  state.phase = 'idle';
  state.allowRelay = current.relay !== 'deny';
  state.rtc = current.rtc;
  setMode(mode);
  options.lockSession(true);
  hostButton.disabled = true;
  joinButton.disabled = true;
  codeOutput.readOnly = true;
  // Opted in to LAN addresses: ask now, while the click still counts as a
  // user gesture (see unlockLocalAddresses).
  const unlocked =
    state.rtc === 'lan'
      ? unlockLocalAddresses(rtcLog('setup'))
      : Promise.resolve(false);
  unlocked
    .then(() => work(sessionName ?? 'Guest'))
    .catch((error: unknown) => {
      state.phase = 'failed';
      state.errors.push(error instanceof Error ? error.message : String(error));
      // A failed start can be retried with different options.
      sessionName = undefined;
      options.lockSession(false);
      hostButton.disabled = false;
      joinButton.disabled = false;
      codeOutput.readOnly = false;
      if (mode === 'host') {
        codeOutput.value = '';
        codeOutput.placeholder = JOIN_PLACEHOLDER;
        setMode('join');
      }
      render();
    });
}

const seconds = Number(params.get('seconds') ?? 20);
const joinWithTypedCode = (): void => {
  const code = codeOutput.value.trim();
  if (!code) {
    setMode('join');
    codeOutput.focus();
    return;
  }
  begin('join', (name) => join(name, code, seconds));
};
hostButton.addEventListener('click', () => begin('host', (name) => host(name)));
joinButton.addEventListener('click', joinWithTypedCode);
codeOutput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !codeOutput.readOnly) {
    event.preventDefault();
    joinWithTypedCode();
  }
});
if (params.get('role') === 'host') begin('host', (name) => host(name));
if (params.get('role') === 'join' && params.get('code'))
  begin('join', (name) => join(name, params.get('code') ?? '', seconds));
render();
