/**
 * Plain-language diagnostics for a WebRTC negotiation, for the console.
 *
 * Candidates are read from each side's SDP and labelled by what their address
 * means for reachability; when the connection fails, the connectivity-check
 * results and those labels produce a verdict ("checks to 100.64.x.x got no
 * reply: a VPN tunnel address…") instead of a bare timeout.
 */

export type AddressKind =
  | 'lan' // RFC 1918 private network
  | 'vpn' // 100.64.0.0/10 shared address space: VPNs, carrier NAT
  | 'hidden' // an mDNS .local name standing in for a LAN address
  | 'loopback'
  | 'link-local'
  | 'public';

export interface Candidate {
  /** host, srflx, prflx or relay */
  type: string;
  protocol: string;
  address: string;
  port: number;
  kind: AddressKind;
}

export function classifyAddress(address: string): AddressKind {
  if (address.endsWith('.local')) return 'hidden';
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
      return 'lan';
    if (a === 100 && b >= 64 && b <= 127) return 'vpn';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    return 'public';
  }
  const v6 = address.toLowerCase();
  if (v6 === '::1') return 'loopback';
  if (v6.startsWith('fe80:')) return 'link-local';
  if (v6.startsWith('fc') || v6.startsWith('fd')) return 'lan';
  return 'public';
}

const KIND_LABEL: Record<AddressKind, string> = {
  lan: 'LAN',
  vpn: 'VPN or carrier NAT',
  hidden: 'hidden LAN address',
  loopback: 'loopback',
  'link-local': 'link-local',
  public: 'public',
};

/** Parse `a=candidate:` lines (RFC 8839) from an SDP. */
export function candidatesFromSdp(sdp: string): Candidate[] {
  const out: Candidate[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(
      line
    );
    if (!match) continue;
    const [, protocol, address, port, type] = match;
    // Every group is required, so a match fills them all.
    if (!protocol || !address || !port || !type) continue;
    out.push({
      type,
      protocol: protocol.toLowerCase(),
      address,
      port: Number(port),
      kind: classifyAddress(address),
    });
  }
  return out;
}

export function describeCandidates(candidates: Candidate[]): string {
  if (!candidates.length) return 'none';
  return candidates
    .map(
      (c) =>
        `${c.type} ${c.address}:${c.port}/${c.protocol} (${KIND_LABEL[c.kind]})`
    )
    .join(', ');
}

export interface PairResult {
  local: string;
  remote: string;
  state: string;
  requestsSent: number;
  responsesReceived: number;
}

/** Connectivity-check results per candidate pair, from getStats(). */
export async function pairResults(
  pc: RTCPeerConnection
): Promise<PairResult[]> {
  const stats = await pc.getStats();
  const byId = new Map<string, Record<string, unknown>>();
  stats.forEach((report: Record<string, unknown>) =>
    byId.set(String(report.id), report)
  );
  const endpoint = (id: unknown): string => {
    const c = byId.get(String(id)) ?? {};
    return `${String(c.candidateType ?? '?')} ${String(c.address ?? c.ip ?? '?')}:${String(c.port ?? '?')}`;
  };
  const out: PairResult[] = [];
  stats.forEach((report: Record<string, unknown>) => {
    if (report.type !== 'candidate-pair') return;
    out.push({
      local: endpoint(report.localCandidateId),
      remote: endpoint(report.remoteCandidateId),
      state: String(report.state ?? '?'),
      requestsSent: Number(report.requestsSent ?? 0),
      responsesReceived: Number(report.responsesReceived ?? 0),
    });
  });
  return out;
}

export function describePairs(pairs: PairResult[]): string {
  if (!pairs.length) return 'no candidate pairs were formed';
  return pairs
    .slice(0, 6)
    .map(
      (p) =>
        `${p.local} → ${p.remote}: ${p.state}, ${p.requestsSent} checks sent, ${p.responsesReceived} answered`
    )
    .join('; ');
}

/**
 * Why a direct connection failed, as far as the evidence shows. Returns one
 * or more sentences; the most specific causes come first.
 */
export function explainFailure(
  local: Candidate[],
  remote: Candidate[],
  pairs: PairResult[]
): string {
  if (!local.length)
    return 'This browser offered no addresses, so there was nothing to try (UDP may be blocked, or the policy allows only relays).';
  if (!remote.length)
    return 'The other side offered no addresses, so there was nothing to try.';
  const reasons: string[] = [];
  const unanswered = pairs.filter(
    (p) => p.requestsSent > 0 && p.responsesReceived === 0
  );
  if (pairs.length && unanswered.length === pairs.length)
    reasons.push(
      `Every connectivity check went unanswered (${unanswered.reduce((n, p) => n + p.requestsSent, 0)} sent).`
    );
  const lanLike = (c: Candidate): boolean =>
    c.type === 'host' && (c.kind === 'lan' || c.kind === 'loopback');
  for (const [side, list] of [
    ['This browser', local],
    ['The other side', remote],
  ] as const) {
    const hosts = list.filter((c) => c.type === 'host');
    const [first] = hosts;
    if (first && hosts.every((c) => c.kind === 'vpn'))
      reasons.push(
        `${side}'s only local address is ${first.address}, a VPN or carrier-NAT address; its traffic is going through a VPN tunnel, which usually does not carry traffic between devices.`
      );
    if (first && hosts.every((c) => c.kind === 'hidden'))
      reasons.push(
        `${side} hid its LAN address behind ${first.address}; resolving that name needs both browsers on the same network with local-network (mDNS) access.`
      );
  }
  const publicLocal = new Set(
    local.filter((c) => c.type === 'srflx').map((c) => c.address)
  );
  const shared = remote.find(
    (c) => c.type === 'srflx' && publicLocal.has(c.address)
  );
  if (shared && !local.some(lanLike))
    reasons.push(
      `Both sides share the public address ${shared.address}; that network does not route traffic back to itself (no hairpinning), so a direct path needs LAN addresses.`
    );
  if (!reasons.length)
    reasons.push(
      'No candidate pair connected; a firewall or NAT between the two sides is likely dropping the traffic.'
    );
  return reasons.join(' ');
}
