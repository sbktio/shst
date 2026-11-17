/**
 * The spike page's options, kept in the URL so a setup can be shared or
 * reloaded: `name`, `relay`, `rtc`. Defaults are omitted from the URL.
 *
 * They are read when a session starts and locked while it runs, since they
 * shape the session (identity, relay policy, ICE). Polling has no option:
 * changes are pushed and the cursor is paced by the round trip.
 */

export type RelayOption = 'allow' | 'deny';
export type RtcOption = 'on' | 'lan' | 'off' | 'blocked';

export interface Options {
  name: string;
  relay: RelayOption;
  rtc: RtcOption;
}

const DEFAULT_NAME = '';

function readOptions(query: URLSearchParams): Options {
  const relay = query.get('relay');
  const rtc = query.get('rtc');
  return {
    name: (query.get('name') ?? DEFAULT_NAME).slice(0, 40),
    relay: relay === 'deny' ? 'deny' : 'allow',
    rtc: rtc === 'off' || rtc === 'blocked' || rtc === 'lan' ? rtc : 'on',
  };
}

function writeUrl(options: Options): void {
  const url = new URL(location.href);
  const set = (key: string, value: string, fallback: string): void => {
    if (value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  };
  set('name', options.name.trim(), DEFAULT_NAME);
  set('relay', options.relay, 'allow');
  set('rtc', options.rtc, 'on');
  // Retired: polling is no longer an option.
  url.searchParams.delete('poll');
  history.replaceState(null, '', url);
}

export interface OptionsControl {
  get(): Options;
  onChange(listener: (options: Options) => void): void;
  /** Lock the options while a session runs. */
  lockSession(locked: boolean): void;
}

export function createOptionsControl(root: ParentNode): OptionsControl {
  const options = readOptions(new URLSearchParams(location.search));
  const listeners: ((options: Options) => void)[] = [];
  const field = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing #${id}`);
    return element;
  };
  const name = field<HTMLInputElement>('opt-name');
  const relay = field<HTMLSelectElement>('opt-relay');
  const rtc = field<HTMLSelectElement>('opt-rtc');

  name.value = options.name;
  relay.value = options.relay;
  rtc.value = options.rtc;
  writeUrl(options);

  const changed = (): void => {
    writeUrl(options);
    for (const listener of listeners) listener({ ...options });
  };
  name.addEventListener('input', () => {
    options.name = name.value.slice(0, 40);
    changed();
  });
  relay.addEventListener('change', () => {
    options.relay = relay.value === 'deny' ? 'deny' : 'allow';
    changed();
  });
  rtc.addEventListener('change', () => {
    const value = rtc.value;
    options.rtc =
      value === 'off' || value === 'blocked' || value === 'lan' ? value : 'on';
    changed();
  });

  return {
    get: () => ({ ...options }),
    onChange: (listener) => listeners.push(listener),
    lockSession: (locked) => {
      for (const element of [name, relay, rtc]) element.disabled = locked;
    },
  };
}
