import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Backoff,
  HEARTBEAT_MS,
  HIDDEN_HEARTBEAT_MS,
  MAX_BACKOFF_MS,
  MAX_GAP_MS,
  MIN_GAP_MS,
  PresencePacer,
  RttWindow,
} from '../src/syncPacing.ts';

describe('RttWindow', () => {
  it('reports the median of recent samples, ignoring a single outlier', () => {
    const window = new RttWindow(5);
    assert.strictEqual(window.median(), undefined);
    for (const ms of [50, 52, 1000, 49, 51]) window.add(ms);
    assert.strictEqual(window.median(), 51);
    for (const ms of [5, 5, 5]) window.add(ms);
    assert.strictEqual(window.median(), 5);
    assert.strictEqual(window.count, 5);
  });
});

describe('PresencePacer', () => {
  it('spaces change-driven updates by the round trip, clamped', () => {
    const pacer = new PresencePacer();
    assert.strictEqual(pacer.gapMs(), MAX_GAP_MS); // unknown: be conservative
    pacer.rtt.add(1);
    assert.strictEqual(pacer.gapMs(), MIN_GAP_MS); // fast link: ~30 updates/s
    for (let i = 0; i < 5; i++) pacer.rtt.add(80);
    assert.strictEqual(pacer.gapMs(), 80); // never faster than the link answers
    for (let i = 0; i < 5; i++) pacer.rtt.add(900);
    assert.strictEqual(pacer.gapMs(), MAX_GAP_MS);
  });

  it('sends a change as soon as the gap allows', () => {
    const pacer = new PresencePacer();
    for (let i = 0; i < 5; i++) pacer.rtt.add(50);
    const base = { lastSentAt: 1000, changed: true, hidden: false };
    assert.strictEqual(pacer.delay({ ...base, now: 1010 }), 40);
    assert.strictEqual(pacer.delay({ ...base, now: 1060 }), 0);
  });

  it('only heartbeats when nothing changed, and slower when hidden', () => {
    const pacer = new PresencePacer();
    const base = { lastSentAt: 1000, now: 1000, changed: false };
    assert.strictEqual(pacer.delay({ ...base, hidden: false }), HEARTBEAT_MS);
    assert.strictEqual(pacer.delay({ ...base, hidden: true }), HIDDEN_HEARTBEAT_MS);
    // A hidden tab does not stream its cursor.
    assert.strictEqual(
      pacer.delay({ ...base, changed: true, hidden: true }),
      HIDDEN_HEARTBEAT_MS
    );
  });
});

describe('Backoff', () => {
  it('doubles from 250 ms to a cap, and resets', () => {
    const backoff = new Backoff();
    assert.strictEqual(backoff.failing, false);
    const waits = [1, 2, 3, 4, 5, 6].map(() => backoff.next());
    assert.deepStrictEqual(waits, [250, 500, 1000, 2000, 4000, MAX_BACKOFF_MS]);
    assert.strictEqual(backoff.failing, true);
    backoff.reset();
    assert.strictEqual(backoff.next(), 250);
  });
});
