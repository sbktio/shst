import { TAILCAT_DERP_MAP_URL } from '@shst/tailcat-transport';

/**
 * The host's round trip to its relay, for the ping meter.
 *
 * The host's own polls never leave the tab, so they say nothing about the
 * network. Instead it times a tiny HTTPS request to its relay server's
 * latency endpoint every 2 s (5 s while hidden). The first request also sets
 * up the connection and is discarded; the meter shows the median of the last
 * five. `no-cors` keeps the probe from needing CORS headers; the opaque
 * response still resolves after a full round trip.
 */

export interface RelayPing {
  /** Median of recent round trips, or undefined until measured. */
  latestMs(): number | undefined;
  stop(): void;
}

const EVERY_MS = 2000;
const EVERY_HIDDEN_MS = 5000;
const WINDOW = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The first node's hostname for a region in the DERP map. */
async function relayHostname(
  regionId: number,
  derpMapURL: string
): Promise<string | undefined> {
  const map: unknown = await (await fetch(derpMapURL)).json();
  const regions = isRecord(map) && isRecord(map.Regions) ? map.Regions : {};
  const region = regions[String(regionId)];
  const nodes =
    isRecord(region) && Array.isArray(region.Nodes) ? region.Nodes : [];
  const host: unknown = isRecord(nodes[0]) ? nodes[0].HostName : undefined;
  return typeof host === 'string' && host ? host : undefined;
}

export async function startRelayPing(
  regionId: number,
  derpMapURL = TAILCAT_DERP_MAP_URL
): Promise<RelayPing> {
  const host = await relayHostname(regionId, derpMapURL);
  const recent: number[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warmed = false;

  const probe = async (): Promise<void> => {
    if (stopped || !host) return;
    try {
      const started = performance.now();
      await fetch(`https://${host}/derp/latency-check?t=${Date.now()}`, {
        mode: 'no-cors',
        cache: 'no-store',
      });
      const ms = performance.now() - started;
      if (warmed) {
        recent.push(ms);
        if (recent.length > WINDOW) recent.shift();
      }
      warmed = true;
    } catch {
      // A failed probe just leaves the last reading in place.
    }
    if (!stopped)
      timer = setTimeout(
        () => void probe(),
        document.hidden ? EVERY_HIDDEN_MS : EVERY_MS
      );
  };
  void probe();

  return {
    latestMs: () => {
      if (!recent.length) return undefined;
      const sorted = [...recent].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
