import {
  candidatesFromSdp,
  describeCandidates,
  describePairs,
  explainFailure,
  pairResults,
} from './rtcDiagnostics.ts';
import { dataChannelStream } from './rtcStream.ts';
import type { ByteStream } from './frames.ts';

/**
 * Upgrades a live session from the Tailcat relay to a direct WebRTC data
 * channel, using the existing Tailcat session as the signalling channel.
 *
 * Why this is safe: the offer and answer travel inside the WireGuard tunnel
 * that the session code authenticated, and each SDP carries its side's DTLS
 * certificate fingerprint. The data channel therefore only completes with the
 * peer that holds the session, with no separate signalling server to trust.
 *
 * No TURN servers are configured, so a data channel that opens is always a
 * peer-to-peer path (host, server-reflexive or peer-reflexive candidates).
 */

/**
 * STUN only reports each side's public address; it never sees board data.
 * Tailcat's relay nodes do not answer STUN (tested: no reply on 3478), so
 * these are public servers. Self-host one to avoid any third party here.
 */
export const RTC_STUN_URLS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
];

export interface RtcOptions {
  /** Defaults to RTC_STUN_URLS. */
  stunUrls?: string[];
  /**
   * 'relay' allows only TURN candidates. With no TURN servers that leaves
   * none at all, which simulates a network that blocks UDP.
   */
  iceTransportPolicy?: RTCIceTransportPolicy;
  gatherTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Receives a line per negotiation step, and a verdict if it fails. */
  log?: (line: string) => void;
}

export interface RtcPath {
  /** e.g. "srflx/udp ↔ host/udp 192.0.2.1:50000" */
  pair: string;
  localType: string;
  remoteType: string;
  protocol: string;
  /** Selected candidates' address:port (empty if the browser hides them). */
  localAddress: string;
  remoteAddress: string;
  /**
   * ICE's own measured round trip on the selected pair; undefined if not
   * reported.
   */
  iceRttMs: number | undefined;
  /** e.g. "DTLS 1.2"; empty if not reported. */
  dtlsVersion: string;
  dtlsCipher: string;
  /**
   * Largest data channel message the peers agreed on (SCTP); undefined
   * without an SCTP transport.
   */
  maxMessageSize: number | undefined;
  bytesSent: number;
  bytesReceived: number;
  /** Local candidates gathered, by type. Shows whether STUN answered. */
  gathered: Record<string, number>;
}

/**
 * The stack a WebRTC data channel runs on, for display: the channel is an
 * SCTP association, encrypted with DTLS, carried over ICE-selected UDP (or
 * TCP, for ICE-TCP candidates).
 */
export function describeRtcStack(path: RtcPath): string {
  const dtls = [path.dtlsVersion || 'DTLS', path.dtlsCipher]
    .filter(Boolean)
    .join(' ');
  return `Data channel · SCTP over ${dtls} over ${path.protocol.toUpperCase()}`;
}

export interface RtcSession {
  stream: ByteStream;
  path(): Promise<RtcPath | null>;
  close(): void;
}

/** Where a joiner's upgrade spends its time. */
export interface RtcTimings {
  gatherMs: number;
  /** One round trip over the Tailcat session, including the host's gather. */
  signalMs: number;
  connectMs: number;
}

export interface RtcSignal {
  sdp: string;
}

export const MAX_SDP_LENGTH = 32 * 1024;

function newPeerConnection(options: RtcOptions): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [{ urls: options.stunUrls ?? RTC_STUN_URLS }],
    iceTransportPolicy: options.iceTransportPolicy ?? 'all',
  });
}

/**
 * Let WebRTC use this device's real network interfaces.
 *
 * Without camera or microphone permission, Chromium-based browsers offer only
 * the default route (here, a VPN tunnel if one is up) and hide LAN addresses
 * behind mDNS `.local` names, so two people on the same network often cannot
 * connect directly. Once a page holds media permission, every interface is
 * offered with its real address. This asks for microphone permission and
 * releases the microphone immediately: nothing is recorded or sent. Call it
 * from a user gesture, on both sides, and only when the person opted in.
 */
export async function unlockLocalAddresses(
  log: (line: string) => void = (): void => undefined
): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    log(
      "Microphone permission granted and the microphone released at once: WebRTC can now offer this device's LAN addresses (nothing is recorded)."
    );
    return true;
  } catch (error) {
    log(
      `Microphone permission not granted (${error instanceof Error ? error.name : String(error)}): only the default route and hidden .local addresses are available.`
    );
    return false;
  }
}

/** Stop gathering once no new address has appeared for this long. */
const GATHER_SETTLE_MS = 500;

/**
 * Non-trickle ICE: one signalling round trip carries every candidate. Waits
 * for gathering to complete, but settles early once candidates stop arriving
 * (some interfaces, such as VPN tunnels, never finish) and never waits longer
 * than `timeoutMs`.
 */
function gathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const cap = setTimeout(done, timeoutMs);
    let settle: ReturnType<typeof setTimeout> | undefined;
    function done(): void {
      clearTimeout(cap);
      clearTimeout(settle);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    }
    function check(): void {
      if (pc.iceGatheringState === 'complete') done();
    }
    function onCandidate(event: RTCPeerConnectionIceEvent): void {
      if (!event.candidate) return;
      clearTimeout(settle);
      settle = setTimeout(done, GATHER_SETTLE_MS);
    }
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

function opened(
  pc: RTCPeerConnection,
  channel: RTCDataChannel,
  timeoutMs: number
): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => fail('No direct WebRTC path opened in time.'),
      timeoutMs
    );
    const onState = (): void => {
      if (pc.connectionState === 'failed')
        fail('WebRTC could not find a direct path.');
    };
    function cleanup(): void {
      clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      pc.removeEventListener('connectionstatechange', onState);
    }
    function onOpen(): void {
      cleanup();
      resolve();
    }
    function fail(message: string): void {
      cleanup();
      reject(new Error(message));
    }
    channel.addEventListener('open', onOpen);
    pc.addEventListener('connectionstatechange', onState);
  });
}

async function describePath(pc: RTCPeerConnection): Promise<RtcPath | null> {
  const stats = await pc.getStats();
  const byId = new Map<string, Record<string, unknown>>();
  const gatheredTypes: Record<string, number> = {};
  stats.forEach((report: Record<string, unknown>) => {
    byId.set(String(report.id), report);
    if (report.type === 'local-candidate') {
      const type = String(report.candidateType);
      gatheredTypes[type] = (gatheredTypes[type] ?? 0) + 1;
    }
  });
  let pairId: string | undefined;
  let transport: Record<string, unknown> = {};
  stats.forEach((report: Record<string, unknown>) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pairId = String(report.selectedCandidatePairId);
      transport = report;
    }
  });
  const pair = pairId ? byId.get(pairId) : undefined;
  if (!pair) return null;
  const local = byId.get(String(pair.localCandidateId)) ?? {};
  const remote = byId.get(String(pair.remoteCandidateId)) ?? {};
  const localType = String(local.candidateType ?? '?');
  const remoteType = String(remote.candidateType ?? '?');
  const protocol = String(local.protocol ?? '?');
  const endpoint = (candidate: Record<string, unknown>): string => {
    const address = candidate.address ?? candidate.ip;
    return typeof address === 'string' && address
      ? `${address.includes(':') ? `[${address}]` : address}:${String(candidate.port ?? '?')}`
      : '';
  };
  const rtt = pair.currentRoundTripTime;
  return {
    pair: `${localType}/${protocol} ↔ ${remoteType}/${String(remote.protocol ?? '?')}`,
    localType,
    remoteType,
    protocol,
    localAddress: endpoint(local),
    remoteAddress: endpoint(remote),
    iceRttMs:
      typeof rtt === 'number' ? Math.round(rtt * 10000) / 10 : undefined,
    dtlsVersion: dtlsVersionName(transport.tlsVersion),
    dtlsCipher:
      typeof transport.dtlsCipher === 'string' ? transport.dtlsCipher : '',
    maxMessageSize: pc.sctp?.maxMessageSize,
    bytesSent: Number(pair.bytesSent ?? 0),
    bytesReceived: Number(pair.bytesReceived ?? 0),
    gathered: gatheredTypes,
  };
}

/** Stats report the DTLS version as the wire value, e.g. "FEFD". */
function dtlsVersionName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const known: Record<string, string> = {
    FEFF: 'DTLS 1.0',
    FEFD: 'DTLS 1.2',
    FEFC: 'DTLS 1.3',
  };
  return known[raw.toUpperCase()] ?? `DTLS ${raw}`;
}

function session(pc: RTCPeerConnection, channel: RTCDataChannel): RtcSession {
  const close = (): void => pc.close();
  return {
    stream: dataChannelStream(channel, close),
    path: () => describePath(pc),
    close: (): void => {
      channel.close();
      close();
    },
  };
}

/**
 * Log ICE progress. Returns a reporter that logs the connectivity checks and
 * a verdict; it runs once, on ICE failure or when the caller gives up.
 */
function narrate(
  pc: RTCPeerConnection,
  log: (line: string) => void,
  remoteSdp: () => string
): () => Promise<void> {
  let reported = false;
  const report = async (): Promise<void> => {
    if (reported) return;
    reported = true;
    const local = candidatesFromSdp(pc.localDescription?.sdp ?? '');
    const remote = candidatesFromSdp(remoteSdp());
    const pairs = await pairResults(pc).catch(() => []);
    log(`Checks: ${describePairs(pairs)}`);
    log(`Why no direct path: ${explainFailure(local, remote, pairs)}`);
  };
  pc.addEventListener('iceconnectionstatechange', () => {
    log(`ICE ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') void report();
  });
  return report;
}

/**
 * Joiner side. `signal` delivers the offer over the existing session and
 * returns the host's answer.
 */
export async function offerDirectSession(
  signal: (offer: RtcSignal) => Promise<RtcSignal>,
  options: RtcOptions = {}
): Promise<RtcSession & { timings: RtcTimings }> {
  const log = options.log ?? ((): void => undefined);
  const pc = newPeerConnection(options);
  const timings: RtcTimings = { gatherMs: 0, signalMs: 0, connectMs: 0 };
  let answerSdp = '';
  const reportFailure = narrate(pc, log, () => answerSdp);
  try {
    const channel = pc.createDataChannel('whiteboard', { ordered: true });
    let mark = performance.now();
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, options.gatherTimeoutMs ?? 3000);
    timings.gatherMs = Math.round(performance.now() - mark);
    const sdp = pc.localDescription?.sdp ?? '';
    const local = candidatesFromSdp(sdp);
    log(
      `Offer: this browser gathered ${local.length} address(es) in ${timings.gatherMs} ms: ${describeCandidates(local)}`
    );
    // Nothing to try (e.g. relay-only policy with no TURN): fail now rather
    // than waiting out the connect timeout.
    if (!local.length) {
      log(`Why no direct path: ${explainFailure(local, [], [])}`);
      throw new Error('This browser found no candidates for a direct path.');
    }
    mark = performance.now();
    const answer = await signal({ sdp });
    timings.signalMs = Math.round(performance.now() - mark);
    if (typeof answer.sdp !== 'string' || answer.sdp.length > MAX_SDP_LENGTH)
      throw new Error('The host sent an invalid WebRTC answer.');
    answerSdp = answer.sdp;
    log(
      `Answer in ${timings.signalMs} ms (over the relay): the host offered ${describeCandidates(candidatesFromSdp(answer.sdp))}`
    );
    mark = performance.now();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    try {
      await opened(pc, channel, options.connectTimeoutMs ?? 6000);
    } catch (error) {
      await reportFailure();
      throw error;
    }
    timings.connectMs = Math.round(performance.now() - mark);
    const result = session(pc, channel);
    const path = await result.path();
    log(
      `Direct path open in ${timings.connectMs} ms: ${path?.localType} ${path?.localAddress} ↔ ${path?.remoteType} ${path?.remoteAddress} over ${path?.protocol.toUpperCase()}`
    );
    return { ...result, timings };
  } catch (error) {
    pc.close();
    throw error;
  }
}

/**
 * Host side: answer an offer. `onSession` receives the direct session once
 * its data channel opens; if it never opens, the peer connection is closed.
 */
export async function answerDirectSession(
  offer: unknown,
  onSession: (session: RtcSession) => void,
  options: RtcOptions = {}
): Promise<RtcSignal> {
  if (
    typeof offer !== 'object' ||
    offer === null ||
    !('sdp' in offer) ||
    typeof offer.sdp !== 'string' ||
    offer.sdp.length > MAX_SDP_LENGTH
  )
    throw Object.assign(new Error('Invalid WebRTC offer.'), { status: 400 });
  const log = options.log ?? ((): void => undefined);
  const offerSdp = offer.sdp;
  const pc = newPeerConnection(options);
  const reportFailure = narrate(pc, log, () => offerSdp);
  log(
    `Offer received: the joiner offered ${describeCandidates(candidatesFromSdp(offerSdp))}`
  );
  const giveUp = async (why: string): Promise<void> => {
    if (pc.connectionState === 'closed') return;
    log(`No direct path (${why})`);
    await reportFailure();
    pc.close();
  };
  const timeout = setTimeout(
    () => void giveUp('timed out'),
    (options.connectTimeoutMs ?? 6000) + 5000
  );
  pc.addEventListener('datachannel', (event) => {
    const channel = event.channel;
    if (channel.label !== 'whiteboard') {
      channel.close();
      return;
    }
    void opened(pc, channel, options.connectTimeoutMs ?? 6000).then(
      async () => {
        clearTimeout(timeout);
        const result = session(pc, channel);
        const path = await result.path();
        log(
          `Direct path open: ${path?.localType} ${path?.localAddress} ↔ ${path?.remoteType} ${path?.remoteAddress} over ${path?.protocol.toUpperCase()}`
        );
        onSession(result);
      },
      (error: unknown) =>
        void giveUp(error instanceof Error ? error.message : String(error))
    );
  });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc, options.gatherTimeoutMs ?? 3000);
    const sdp = pc.localDescription?.sdp ?? '';
    log(`Answering with ${describeCandidates(candidatesFromSdp(sdp))}`);
    return { sdp };
  } catch (error) {
    clearTimeout(timeout);
    pc.close();
    throw error;
  }
}
