import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import type { Browser, Page } from 'playwright-core';
import type { ViteDevServer } from 'vite';

/**
 * LIVE network check, deliberately outside `pnpm test` and CI: it loads the
 * Tailcat wasm and talks to Tailcat's public DERP relays. Run on demand with
 * `pnpm --filter @shst/whiteboard-app test:live`.
 *
 * Two separate browser contexts — two people, not two tabs sharing storage —
 * connected only by the three-word code the host shows. Each case sets the
 * relay policy for board data and whether WebRTC can find a direct path.
 *
 * SPIKE_BASE_URL reuses a server you started; otherwise one starts on a free
 * port. SPIKE_SECONDS sets the run length. Chrome hides LAN addresses behind
 * mDNS names that headless Chromium cannot resolve, so two contexts on one
 * machine never connect directly; SPIKE_MDNS=1 keeps them hidden anyway.
 */

interface SpikeState {
  phase: string;
  code?: string;
  addr?: string;
  transport?: string;
  errors: string[];
  [key: string]: unknown;
}

type Relay = 'allow' | 'deny';
type Rtc = 'on' | 'blocked';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const resultsDir = path.resolve(appDir, '../../.screenshots/tailcat-spike');
const seconds = Number(process.env.SPIKE_SECONDS ?? 15);

let browser: Browser | undefined;
let server: ViteDevServer | undefined;
let baseUrl = process.env.SPIKE_BASE_URL ?? '';

before(async () => {
  if (!baseUrl) {
    server = await createServer({
      root: appDir,
      configFile: path.join(appDir, 'vite.config.ts'),
      server: { port: 0, strictPort: false },
      logLevel: 'warn',
    });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? '';
    assert.ok(baseUrl, 'the dev server did not report a URL');
  }
  const args =
    process.env.SPIKE_MDNS === '1'
      ? []
      : ['--disable-features=WebRtcHideLocalIpsWithMdns'];
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true, args });
      break;
    } catch {}
  }
  assert.ok(browser, 'needs Chrome or Edge');
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const readState = (page: Page): Promise<SpikeState> =>
  page.evaluate(
    () => (window as unknown as { tailcatSpike: SpikeState }).tailcatSpike
  );

/** Poll the page's state until `done` accepts it, or fail after `timeout`. */
async function waitForState(
  page: Page,
  done: (state: SpikeState) => boolean,
  timeout: number,
  interval = 250
): Promise<SpikeState> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await readState(page);
    if (done(state)) return state;
    if (Date.now() > deadline)
      assert.fail(`timed out in phase ${state.phase}: ${state.errors.join('; ')}`);
    await page.waitForTimeout(interval);
  }
}

async function runPair(
  relay: Relay,
  rtc: Rtc,
  runSeconds: number,
  joinWith: 'words' | 'address' = 'words'
): Promise<{ host: SpikeState; joiner: SpikeState }> {
  assert.ok(browser);
  const label = `relay-${relay}-rtc-${rtc}-${joinWith}`;
  const hostContext = await browser.newContext({ baseURL: baseUrl });
  const joinContext = await browser.newContext({ baseURL: baseUrl });
  try {
    const host = await hostContext.newPage();
    const joiner = await joinContext.newPage();
    for (const [role, page] of [
      ['host', host],
      ['joiner', joiner],
    ] as const)
      page.on('console', (message) => {
        if (message.type() === 'error')
          console.log(`[${label} ${role}] ${message.text()}`);
      });

    await host.goto(`/?role=host&name=Henry&relay=${relay}`);
    const { code, addr } = await waitForState(host, (s) => s.phase === 'hosting', 60_000);
    assert.match(code ?? '', /^[a-z]+-[a-z]+-[a-z]+$/);
    assert.match(addr ?? '', /^tc/);

    // Join with the words as a person would type them, or paste the address.
    const typed = joinWith === 'address' ? (addr ?? '') : (code ?? '').replaceAll('-', ' ');
    await joiner.goto(
      `/?role=join&name=Ada&relay=${relay}&rtc=${rtc}&seconds=${runSeconds}&code=${encodeURIComponent(typed)}`
    );
    await waitForState(
      joiner,
      (s) => s.phase === 'done' || s.phase === 'failed',
      60_000 + runSeconds * 1000 + 30_000,
      1000
    );

    // Give the host one more poll to observe the final saves.
    await joiner.waitForTimeout(1500);
    const results = { host: await readState(host), joiner: await readState(joiner) };
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, `results-${label}.json`),
      JSON.stringify(results, null, 2)
    );
    console.log(`--- ${label}\n${JSON.stringify(results, null, 2)}`);
    return results;
  } finally {
    await hostContext.close();
    await joinContext.close();
  }
}

const timeout = 180_000;

test('relay allowed, WebRTC works: board data moves to a direct path', { timeout }, async () => {
  const { host, joiner } = await runPair('allow', 'on', seconds);
  assert.deepEqual(joiner.errors, []);
  assert.equal(joiner.phase, 'done');
  assert.equal(joiner.transport, 'webrtc-direct');
  const people = host.people as string[];
  assert.ok(people.includes('Henry') && people.includes('Ada'), `people: ${people}`);
});

test('relay denied, WebRTC works: the relay only carries signalling', { timeout }, async () => {
  const { joiner } = await runPair('deny', 'on', seconds);
  assert.deepEqual(joiner.errors, []);
  assert.equal(joiner.phase, 'done');
  assert.equal(joiner.transport, 'webrtc-direct');
});

test('relay allowed, WebRTC blocked: falls back to the relay', { timeout }, async () => {
  const { joiner } = await runPair('allow', 'blocked', seconds);
  assert.deepEqual(joiner.errors, []);
  assert.equal(joiner.phase, 'done');
  assert.equal(joiner.transport, 'tailcat-relay');
});

test('relay denied, WebRTC blocked: the session is refused', { timeout }, async () => {
  const { joiner } = await runPair('deny', 'blocked', 5);
  assert.equal(joiner.phase, 'failed');
  assert.match(joiner.errors.join('\n'), /no direct path/);
});

test('joined by the raw Tailcat address instead of the words', { timeout }, async () => {
  const { host, joiner } = await runPair('allow', 'on', seconds, 'address');
  assert.deepEqual(joiner.errors, []);
  assert.equal(joiner.phase, 'done');
  const people = host.people as string[];
  assert.ok(people.includes('Henry') && people.includes('Ada'), `people: ${people}`);
});
