import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  candidatesFromSdp,
  classifyAddress,
  describeCandidates,
  explainFailure,
} from '../src/rtcDiagnostics.ts';

const sdp = (lines: string[]): string =>
  ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', ...lines].join(
    '\r\n'
  );

describe('classifyAddress', () => {
  it('labels what each address means for reachability', () => {
    assert.strictEqual(classifyAddress('10.13.17.157'), 'lan');
    assert.strictEqual(classifyAddress('192.168.1.4'), 'lan');
    assert.strictEqual(classifyAddress('172.20.0.1'), 'lan');
    assert.strictEqual(classifyAddress('100.64.209.181'), 'vpn');
    assert.strictEqual(classifyAddress('131.107.1.221'), 'public');
    assert.strictEqual(
      classifyAddress('4eff20cd-ebe8-45f2-95c7-4406ba1a1330.local'),
      'hidden'
    );
    assert.strictEqual(classifyAddress('fe80::1'), 'link-local');
  });
});

describe('candidatesFromSdp', () => {
  it('reads type, protocol, address and port', () => {
    const list = candidatesFromSdp(
      sdp([
        'a=candidate:1 1 udp 2113937151 100.64.209.181 59193 typ host generation 0',
        'a=candidate:2 1 UDP 1677729535 131.107.1.221 48377 typ srflx raddr 0.0.0.0 rport 0',
      ])
    );
    assert.deepStrictEqual(list, [
      {
        type: 'host',
        protocol: 'udp',
        address: '100.64.209.181',
        port: 59193,
        kind: 'vpn',
      },
      {
        type: 'srflx',
        protocol: 'udp',
        address: '131.107.1.221',
        port: 48377,
        kind: 'public',
      },
    ]);
    assert.ok(describeCandidates(list).includes('(VPN or carrier NAT)'));
  });
});

describe('explainFailure', () => {
  it('names the VPN tunnel and the shared public address', () => {
    const local = candidatesFromSdp(
      sdp([
        'a=candidate:1 1 udp 1 100.64.209.181 59193 typ host',
        'a=candidate:2 1 udp 1 131.107.1.221 48377 typ srflx',
      ])
    );
    const remote = candidatesFromSdp(
      sdp([
        'a=candidate:1 1 udp 1 100.64.209.181 61000 typ host',
        'a=candidate:2 1 udp 1 131.107.1.221 50111 typ srflx',
      ])
    );
    const verdict = explainFailure(local, remote, [
      {
        local: 'host a',
        remote: 'host b',
        state: 'in-progress',
        requestsSent: 113,
        responsesReceived: 0,
      },
    ]);
    assert.match(
      verdict,
      /Every connectivity check went unanswered \(113 sent\)/
    );
    assert.match(verdict, /VPN tunnel/);
    assert.match(verdict, /share the public address 131\.107\.1\.221/);
  });

  it('names a hidden .local address', () => {
    const local = candidatesFromSdp(
      sdp(['a=candidate:1 1 udp 1 10.0.0.2 5000 typ host'])
    );
    const remote = candidatesFromSdp(
      sdp(['a=candidate:1 1 udp 1 abc.local 5000 typ host'])
    );
    assert.match(
      explainFailure(local, remote, []),
      /hid its LAN address behind abc\.local/
    );
  });

  it('says when there was nothing to try', () => {
    assert.match(explainFailure([], [], []), /offered no addresses/);
  });
});
