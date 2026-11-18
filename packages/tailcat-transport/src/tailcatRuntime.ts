import type { ByteStream } from './frames.ts';

/**
 * Loads the qbtailcat js/wasm build (`qbtailcat/` in this package, a thin Go
 * wrapper over tailscale/tailcat) and types its globals.
 *
 * The wrapper adds two things tailcat's own browser build lacks:
 *   - three-word session codes, from which both sides derive the host's
 *     identity, pre-shared key and relay region, instead of a 154-character
 *     address;
 *   - a relay policy: with `allowRelay: false`, no session opens unless the
 *     peers have a direct UDP path, and it closes if that path is lost.
 *
 * It is ~6 MB compressed, so load it only when someone hosts or joins a live
 * session. One Go runtime serves the page.
 */

export const TAILCAT_DERP_MAP_URL = 'https://tailcat.dev/derpmap.json';

export interface TailcatPath {
  /** True when traffic flows over a direct UDP path, not the DERP relay. */
  direct: boolean;
  /** The direct endpoint, or `DERP(<region>)`. */
  via: string;
}

export interface TailcatConn extends ByteStream {
  closeWrite(): Promise<void>;
  /** The path as of the last check (re-checked every few seconds). */
  path(): TailcatPath;
  /** Why the wrapper closed the session (e.g. lost direct path), else "". */
  closeReason(): string;
}

export interface TailcatJoinTimings {
  deriveMs: number;
  reachMs: number;
  pathMs: number;
  dialMs: number;
  pathProbes: number;
  regionId: number;
}

export interface TailcatHostSession {
  /**
   * The text a joiner needs: three hyphen-joined words, or the raw Tailcat
   * address when `addressing` is `'address'`. Whoever holds it can join while
   * the host is open.
   */
  readonly code: string;
  readonly region: string;
  readonly regionId: number;
  /** Measured round trip per relay region (ms), when the browser picked. */
  readonly regionProbes: Record<string, number>;
  /**
   * The raw Tailcat address this host is reachable at. It grants the same
   * access as `code`, so treat it as a secret. It equals `code` when
   * `addressing` is `'address'`.
   */
  readonly addr: string;
  /** How joiners reach this host; `code` is the text they need in it. */
  readonly addressing: 'words' | 'address';
  close(): void;
}

export interface TailcatRuntime {
  host(options: {
    allowRelay: boolean;
    onConnection: (conn: TailcatConn) => void;
    onRefused?: (path: TailcatPath) => void;
    derpMapURL?: string;
    port: number;
    /**
     * What joiners type. `words` (the default) is three easy-to-type words;
     * `address` is a raw Tailcat address with full-strength keys, too long
     * to type but far harder to guess.
     */
    addressing?: 'words' | 'address';
    verbose?: boolean;
  }): Promise<TailcatHostSession>;
  join(options: {
    code: string;
    allowRelay: boolean;
    directTimeoutMs?: number;
    derpMapURL?: string;
    port: number;
    verbose?: boolean;
  }): Promise<{ conn: TailcatConn; timings: TailcatJoinTimings }>;
}

type JsFunction = (...args: unknown[]) => unknown;

interface GoInstance {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

function isFunction(value: unknown): value is JsFunction {
  return typeof value === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPath(value: unknown): TailcatPath {
  return isRecord(value)
    ? { direct: value.direct === true, via: String(value.via ?? '') }
    : { direct: false, via: '' };
}

function asConn(value: unknown): TailcatConn {
  if (
    !isRecord(value) ||
    !isFunction(value.read) ||
    !isFunction(value.write) ||
    !isFunction(value.closeWrite) ||
    !isFunction(value.close) ||
    !isFunction(value.path) ||
    !isFunction(value.closeReason)
  )
    throw new Error('Tailcat returned an unexpected connection.');
  const read = value.read as () => Promise<unknown>;
  const write = value.write as (chunk: Uint8Array) => Promise<unknown>;
  const closeWrite = value.closeWrite as () => Promise<unknown>;
  const close = value.close as () => unknown;
  const path = value.path as () => unknown;
  const closeReason = value.closeReason as () => unknown;
  return {
    read: async (): Promise<Uint8Array | null> => {
      const chunk = await read();
      if (chunk === null || chunk instanceof Uint8Array) return chunk;
      throw new Error('Tailcat returned an unexpected chunk.');
    },
    write: async (chunk: Uint8Array): Promise<void> => {
      await write(chunk);
    },
    closeWrite: async (): Promise<void> => {
      await closeWrite();
    },
    close: (): void => {
      close();
    },
    path: (): TailcatPath => asPath(path()),
    closeReason: (): string => String(closeReason() ?? ''),
  };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = (): void => resolve();
    script.onerror = (): void =>
      reject(new Error(`Could not load Tailcat support script ${src}.`));
    document.head.append(script);
  });
}

let runtime: Promise<TailcatRuntime> | undefined;

/**
 * @param baseUrl Directory serving `wasm_exec.js` and `main.wasm`, with a
 *   trailing slash.
 */
export function loadTailcatRuntime(baseUrl: string): Promise<TailcatRuntime> {
  runtime ??= (async (): Promise<TailcatRuntime> => {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (!isFunction(scope.Go)) await loadScript(`${baseUrl}wasm_exec.js`);
    const GoClass = scope.Go as unknown as new () => GoInstance;
    const go = new GoClass();
    const ready = new Promise<void>((resolve) => {
      scope.onTailcatReady = resolve;
    });
    const { instance } = await WebAssembly.instantiateStreaming(
      fetch(`${baseUrl}main.wasm`),
      go.importObject
    );
    // Go's main never returns; it parks on `select {}` and serves callbacks.
    void go.run(instance);
    await ready;
    const host = scope.qbTailcatHost;
    const join = scope.qbTailcatJoin;
    if (!isFunction(host) || !isFunction(join))
      throw new Error('This Tailcat build does not expose host and join.');
    return {
      host: async ({
        allowRelay,
        onConnection,
        onRefused,
        derpMapURL = TAILCAT_DERP_MAP_URL,
        port,
        addressing,
        verbose = false,
      }): Promise<TailcatHostSession> => {
        const result: unknown = await host({
          allowRelay,
          derpMapURL,
          port,
          verbose,
          ...(addressing === undefined ? {} : { addressing }),
          onConnection: (conn: unknown) => onConnection(asConn(conn)),
          onRefused: (path: unknown) => onRefused?.(asPath(path)),
        });
        if (
          !isRecord(result) ||
          typeof result.code !== 'string' ||
          typeof result.addr !== 'string' ||
          !isFunction(result.close)
        )
          throw new Error('Tailcat returned an unexpected host session.');
        const close = result.close;
        const regionProbes: Record<string, number> = {};
        if (isRecord(result.regionProbes))
          for (const [region, ms] of Object.entries(result.regionProbes))
            if (typeof ms === 'number') regionProbes[region] = ms;
        return {
          code: result.code,
          addr: result.addr,
          addressing: result.addressing === 'address' ? 'address' : 'words',
          region: String(result.region ?? ''),
          regionId: Number(result.regionId ?? 0),
          regionProbes,
          close: (): void => void close(),
        };
      },
      join: async ({
        code,
        allowRelay,
        directTimeoutMs = 15000,
        derpMapURL = TAILCAT_DERP_MAP_URL,
        port,
        verbose = false,
      }): Promise<{ conn: TailcatConn; timings: TailcatJoinTimings }> => {
        const result: unknown = await join({
          code,
          allowRelay,
          directTimeoutMs,
          derpMapURL,
          port,
          verbose,
        });
        const conn = asConn(result);
        const timings =
          isRecord(result) && isRecord(result.timings) ? result.timings : {};
        return {
          conn,
          timings: {
            deriveMs: Number(timings.deriveMs ?? 0),
            reachMs: Number(timings.reachMs ?? 0),
            pathMs: Number(timings.pathMs ?? 0),
            dialMs: Number(timings.dialMs ?? 0),
            pathProbes: Number(timings.pathProbes ?? 0),
            regionId: Number(timings.regionId ?? 0),
          },
        };
      },
    };
  })();
  runtime.catch(() => {
    runtime = undefined;
  });
  return runtime;
}
