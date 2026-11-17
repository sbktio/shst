import { describeRtcStack } from '@shst/tailcat-transport';
import type { RtcPath } from '@shst/tailcat-transport';

/**
 * Status for the spike page: a row of pills that only appear when they say
 * something, a ping meter whose hover text describes the connection, and a
 * one-line description of each transport (logged to the console).
 *
 * Pills keep their DOM node between renders and only their text changes, so
 * frequent updates do not make the layout jump.
 */

/** How one participant's board data reaches the host. */
export interface TransportLink {
  name: string;
  direct: boolean;
  /** Set once a WebRTC channel is up; cleared to undefined when it closes. */
  rtcPath?: RtcPath | null | undefined;
  /** The Tailcat path, e.g. "DERP(sfo)". */
  tailcatVia?: string;
  /** When the link opened (ms epoch), to bridge until presence arrives. */
  since?: number;
}

export interface StatusInput {
  role: 'host' | 'join' | 'idle';
  phase: string;
  region?: string | undefined;
  /** Other participants' names (not this tab). */
  others: string[];
  /** Joiner: its own link to the host. Host: one per joiner. */
  links: TransportLink[];
  /** A recent error, shown briefly. */
  error?: string | undefined;
}

interface Pill {
  key: string;
  label: string;
  value: string;
  tone?: 'error';
  title?: string;
  /** Eases in when it changes, dwells, then eases out (see DWELL_MS). */
  transient?: boolean;
}

/** How long a transient pill stays after it changes; matches the CSS. */
export const DWELL_MS = 4000;
/** Each transient pill's last label/value and when it changed. */
const transientSeen = new Map<string, { sig: string; at: number }>();

const pillSig = (pill: Pill): string => `${pill.label}|${pill.value}`;

/**
 * Keep transient pills only for their dwell after a change. A pill that
 * disappears and later returns counts as a change, so it shows again.
 */
function applyDwell(list: Pill[], now: number): Pill[] {
  const present = new Set(list.filter((p) => p.transient).map((p) => p.key));
  for (const key of transientSeen.keys())
    if (!present.has(key)) transientSeen.delete(key);
  return list.filter((pill) => {
    if (!pill.transient) return true;
    const sig = pillSig(pill);
    const seen = transientSeen.get(pill.key);
    if (!seen || seen.sig !== sig) {
      transientSeen.set(pill.key, { sig, at: now });
      return true;
    }
    return now - seen.at < DWELL_MS;
  });
}

/** Transitional and failed states are worth a pill; steady ones are not. */
const PHASE_PILLS: Record<string, Pick<Pill, 'label' | 'tone'>> = {
  loading: { label: 'Loading…' },
  connecting: { label: 'Connecting…' },
  failed: { label: 'Could not connect', tone: 'error' },
};

const REGIONS: Record<string, string> = {
  '301': 'nyc',
  '302': 'sfo',
  '303': 'fra',
  '304': 'tok',
};

/** "DERP(302)" or "DERP(sfo)" → "sfo". */
function relayRegion(via: string | undefined): string {
  const inner = /DERP\(([^)]*)\)/.exec(via ?? '')?.[1] ?? '';
  return REGIONS[inner] ?? inner;
}

function pills(input: StatusInput): Pill[] {
  const out: Pill[] = [];
  const phase = PHASE_PILLS[input.phase];
  if (phase) out.push({ key: 'phase', value: '', ...phase });
  // Just the names ("Brian", "Brian, Ada"); a presence dot (CSS) marks them
  // as the people here.
  if (input.others.length)
    out.push({ key: 'people', label: '', value: input.others.join(', ') });
  if (input.error)
    out.push({
      key: 'error',
      label: 'Issue',
      value: '',
      tone: 'error',
      title: input.error,
    });
  // Path pills come last, so easing them out never shifts the others.
  if (input.role === 'join' && input.links[0])
    out.push(
      input.links[0].direct
        ? { key: 'path', label: 'Direct', value: '', transient: true }
        : { key: 'path', label: 'Relayed', value: '', transient: true }
    );
  if (input.role === 'host') {
    const direct = input.links.filter((link) => link.direct).length;
    const relayed = input.links.length - direct;
    if (direct)
      out.push({
        key: 'direct',
        label: 'Direct',
        value: String(direct),
        transient: true,
      });
    if (relayed)
      out.push({
        key: 'relayed',
        label: 'Relayed',
        value: String(relayed),
        transient: true,
      });
  }
  return out;
}

export type PingLevel = 0 | 1 | 2 | 3 | 4;

/** One label/value line in the ping chip's tooltip. */
export interface DetailRow {
  label: string;
  value: string;
}

/** A group of rows; a host gets one per participant, titled with the name. */
export interface DetailSection {
  title?: string;
  rows: DetailRow[];
}

/** What carries this tab's board data, laid out for the ping tooltip. */
export interface ConnectionDetails {
  sections: DetailSection[];
  note: string;
}

/**
 * Which round trip the chip shows. On a direct path it is the WebRTC data
 * path's own (the selected ICE candidate pair's RTT); while the relay carries
 * board data it is the round trip through the relay.
 */
export type PingSource = 'webrtc' | 'relay';

export interface RttMeasure {
  source: PingSource;
  /** Undefined until there is a reading. */
  ms?: number | undefined;
  /** What the round trip is to, e.g. "the relay (sfo)" or "the host". */
  to: string;
}

export interface PingReading {
  level: PingLevel;
  /** The chip's number, e.g. "36 ms". */
  text: string;
  source: PingSource;
  /** The chip's source tag: "WebRTC" or "Relay". */
  sourceLabel: string;
  /** Tooltip heading, e.g. "36 ms · excellent". */
  heading: string;
  /** What the heading measures, e.g. "Round trip to the relay (sfo)". */
  subheading: string;
  /** The chip's accessible name: the heading and what it measures. */
  label: string;
  details: ConnectionDetails;
  tone?: 'error';
}

const QUALITY = ['', 'poor', 'fair', 'good', 'excellent'] as const;

/** Typical game thresholds: ≤50 ms excellent, ≤100 good, ≤150 fair. */
export function pingLevel(ms: number): Exclude<PingLevel, 0> {
  return ms <= 50 ? 4 : ms <= 100 ? 3 : ms <= 150 ? 2 : 1;
}

const BOUNDARIES = [150, 100, 50]; // between levels 1|2, 2|3, 3|4

/**
 * The level with hysteresis: a reading has to clear the boundary between the
 * shown level and the new one by 10% before the meter changes, so a round
 * trip sitting on 50 ms does not flicker between colours.
 */
export function steadyPingLevel(
  ms: number,
  shown: PingLevel
): Exclude<PingLevel, 0> {
  const next = pingLevel(ms);
  if (shown === 0 || next === shown) return next;
  // The boundary nearest the shown level, in the direction of the change.
  const boundary = BOUNDARIES[Math.min(shown, next) - 1];
  // Two different levels in 1–4 always have a boundary between them.
  if (boundary === undefined) return next;
  return Math.abs(ms - boundary) < boundary * 0.1 ? shown : next;
}

let shownLevel: PingLevel = 0;

function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

const hidden = (address: string): string => address || '(hidden)';

/** Path, stack, addresses and ICE round trip for one link. */
function linkRows(link: TransportLink): DetailRow[] {
  const path = link.rtcPath;
  if (!link.direct || !path)
    return [{ label: 'Path', value: 'Relayed, encrypted end to end' }];
  const rows: DetailRow[] = [
    { label: 'Path', value: 'Direct WebRTC' },
    { label: 'Stack', value: describeRtcStack(path) },
    {
      label: 'Addresses',
      value: `${path.localType} ${hidden(path.localAddress)} ↔ ${path.remoteType} ${hidden(path.remoteAddress)}`,
    },
  ];
  if (path.iceRttMs !== undefined)
    rows.push({ label: 'ICE RTT', value: formatMs(path.iceRttMs) });
  return rows;
}

/**
 * What carries this tab's board data, for the ping meter's tooltip: the
 * relay region, and per link the path, stack and addresses.
 */
export function describeConnection(
  role: StatusInput['role'],
  region: string | undefined,
  links: TransportLink[]
): ConnectionDetails {
  const top: DetailRow[] = [];
  const relay = region ?? relayRegion(links[0]?.tailcatVia);
  if (relay) top.push({ label: 'Region', value: relay });
  const sections: DetailSection[] = [];
  if (role === 'join' && links[0]) top.push(...linkRows(links[0]));
  if (top.length) sections.push({ rows: top });
  if (role === 'host')
    for (const link of links)
      sections.push({ title: link.name, rows: linkRows(link) });
  return { sections, note: 'Updates are pushed as they happen.' };
}

const SOURCE_LABEL: Record<PingSource, string> = {
  webrtc: 'WebRTC',
  relay: 'Relay',
};

/** "WebRTC round trip to the host (ICE)" / "Round trip to the relay (sfo)". */
function describeMeasure(measure: RttMeasure): string {
  return measure.source === 'webrtc'
    ? `Direct WebRTC round trip to ${measure.to} (ICE)`
    : `Round trip to ${measure.to}`;
}

/**
 * The ping meter: the round trip as signal bars and milliseconds, tagged with
 * the path it was measured on, with the connection laid out in its tooltip.
 */
export function pingReading(
  role: StatusInput['role'],
  measure: RttMeasure,
  options: { details: ConnectionDetails; retrying?: boolean }
): PingReading | undefined {
  if (role === 'idle') return undefined;
  const base = {
    source: measure.source,
    sourceLabel: SOURCE_LABEL[measure.source],
    details: options.details,
  };
  const subheading = describeMeasure(measure);
  if (options.retrying)
    return {
      ...base,
      level: 1,
      text: 'retrying',
      heading: 'Retrying',
      subheading: 'Lost contact with the host; retrying.',
      label: 'Lost contact with the host; retrying.',
      tone: 'error',
    };
  if (measure.ms === undefined)
    return {
      ...base,
      level: 0,
      text: '—',
      heading: 'Measuring…',
      subheading,
      label: `${subheading}: measuring`,
    };
  const level = steadyPingLevel(measure.ms, shownLevel);
  shownLevel = level;
  const heading = `${formatMs(measure.ms)} · ${QUALITY[level]}`;
  return {
    ...base,
    level,
    text: formatMs(measure.ms),
    heading,
    subheading,
    label: `${subheading}: ${formatMs(measure.ms)} (${QUALITY[level]})`,
  };
}

export function renderPing(
  element: HTMLElement,
  reading: PingReading | undefined
): void {
  element.hidden = !reading;
  if (!reading) return;
  element.dataset.level = String(reading.level);
  element.dataset.source = reading.source;
  if (reading.tone) element.dataset.tone = reading.tone;
  else delete element.dataset.tone;
  const via = element.querySelector('.via');
  if (via) setText(via, reading.sourceLabel);
  const text = element.querySelector('.ms');
  if (text) setText(text, reading.text);
  if (element.getAttribute('aria-label') !== reading.label)
    element.setAttribute('aria-label', reading.label);
}

/** One line describing what carries a link's board data. */
export function describeLink(
  link: TransportLink,
  role: StatusInput['role']
): string {
  const who = role === 'host' ? `${link.name}: ` : '';
  const path = link.rtcPath;
  if (link.direct && path) {
    const ends = [
      `${path.localType} ${path.localAddress || '(hidden)'}`,
      `${path.remoteType} ${path.remoteAddress || '(hidden)'}`,
    ].join(' ↔ ');
    const extras = [
      path.iceRttMs !== undefined ? `ICE RTT ${path.iceRttMs} ms` : '',
      path.maxMessageSize
        ? `max message ${Math.round(path.maxMessageSize / 1024)} KB`
        : '',
      `${formatBytes(path.bytesSent)} sent, ${formatBytes(path.bytesReceived)} received`,
    ].filter(Boolean);
    return `${who}${describeRtcStack(path)} · ${ends} · ${extras.join(' · ')} · signalled over Tailcat`;
  }
  const region = relayRegion(link.tailcatVia);
  return `${who}Tailcat relay${region ? ` ${region}` : ''} · WireGuard (userspace) inside WebSocket over TLS · carries signalling and board data`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Keep one element per key, updating text in place. */
function reconcile<T>(
  root: HTMLElement,
  items: T[],
  key: (item: T) => string,
  create: () => HTMLElement,
  update: (element: HTMLElement, item: T) => void
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(root.children))
    if (child instanceof HTMLElement && child.dataset.key)
      existing.set(child.dataset.key, child);
  const wanted: HTMLElement[] = items.map((item) => {
    const k = key(item);
    const element = existing.get(k) ?? create();
    element.dataset.key = k;
    existing.delete(k);
    update(element, item);
    return element;
  });
  for (const stale of existing.values()) stale.remove();
  wanted.forEach((element, index) => {
    if (root.children[index] !== element)
      root.insertBefore(element, root.children[index] ?? null);
  });
}

function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

export function renderStatus(pillsRoot: HTMLElement, input: StatusInput): void {
  reconcile(
    pillsRoot,
    applyDwell(pills(input), Date.now()),
    (pill) => pill.key,
    () => {
      const element = document.createElement('span');
      element.className = 'pill';
      element.append(
        document.createElement('b'),
        document.createElement('span')
      );
      return element;
    },
    (element, pill) => {
      const [label, value] = Array.from(element.children);
      if (!label || !value)
        throw new Error('A status pill lost its label or value.');
      setText(label, pill.label);
      setText(value, pill.value);
      if (pill.tone) element.dataset.tone = pill.tone;
      else delete element.dataset.tone;
      element.title = pill.title ?? '';
      // Restart the ease-in/dwell/ease-out whenever a transient pill changes.
      const sig = pill.transient ? pillSig(pill) : '';
      if (element.dataset.sig !== sig) {
        element.dataset.sig = sig;
        element.classList.remove('transient');
        if (sig) {
          void element.offsetWidth;
          element.classList.add('transient');
        }
      }
    }
  );
}
