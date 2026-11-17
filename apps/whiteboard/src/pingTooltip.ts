import type { PingReading } from './statusView';

/**
 * The ping chip's tooltip: what the chip's round trip measures, then the
 * connection as label/value rows, one titled group per participant on a host.
 *
 * It opens after a short delay on hover and at once on focus, stays open
 * while the pointer moves onto it, and closes on Escape, blur or leaving.
 * It lives in the top layer (popover="manual"), positioned under the chip.
 * The chip names it with aria-describedby, so its text is the chip's
 * description for assistive technology even while it is closed.
 */

export interface PingTooltip {
  /** Show this reading's details; cheap to call on every render. */
  update(reading: PingReading | undefined): void;
}

/** Hover delay before opening; matches --duration-fast. */
const SHOW_DELAY_MS = 150;
/** Grace period for moving the pointer from the chip onto the tooltip. */
const HIDE_DELAY_MS = 150;

/**
 * Where a long value may wrap: before a separator (" · ", " over ", " ↔ ")
 * or before a token with underscores (TLS_AES_128_GCM_SHA256). Each separator
 * starts the next run, so a line never ends on "over" and a cipher suite or
 * an address never breaks mid-token.
 */
const BREAKS = / (?=· |over |↔ |\S*_)/;

/** A value as unbreakable runs separated by wrappable spaces. */
function segmented(value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  value.split(BREAKS).forEach((part, index) => {
    if (index) fragment.append(' ');
    const run = document.createElement('span');
    run.className = 'run';
    run.textContent = part;
    fragment.append(run);
  });
  return fragment;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function build(tip: HTMLElement, reading: PingReading): void {
  const head = element('p', 'tip-head');
  head.append(element('strong', 'tip-value', reading.heading));
  const sub = element('p', 'tip-sub', reading.subheading);
  const parts: HTMLElement[] = [head, sub];
  for (const section of reading.details.sections) {
    const group = element('div', 'tip-section');
    if (section.title) group.append(element('p', 'tip-title', section.title));
    const rows = element('dl', 'tip-rows');
    for (const row of section.rows) {
      const value = element('dd', '');
      value.append(segmented(row.value));
      rows.append(element('dt', '', row.label), value);
    }
    group.append(rows);
    parts.push(group);
  }
  parts.push(element('p', 'tip-note', reading.details.note));
  tip.replaceChildren(...parts);
}

export function createPingTooltip(
  chip: HTMLElement,
  tip: HTMLElement
): PingTooltip {
  let signature = '';
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** Escape closes it until the pointer leaves or focus moves away. */
  let dismissed = false;

  const isOpen = (): boolean => tip.matches(':popover-open');

  const place = (): void => {
    const anchor = chip.getBoundingClientRect();
    const style = tip.style;
    style.setProperty('--anchor-top', `${anchor.top}px`);
    style.setProperty('--anchor-bottom', `${anchor.bottom}px`);
    style.setProperty('--anchor-right', `${anchor.right}px`);
    style.setProperty('--tip-width', `${tip.offsetWidth}px`);
    style.setProperty('--tip-height', `${tip.offsetHeight}px`);
    // Below the chip unless it would run off the bottom of the window.
    const below = innerHeight - anchor.bottom >= tip.offsetHeight + anchor.height;
    tip.dataset.side = below || anchor.top < tip.offsetHeight ? 'below' : 'above';
  };

  const cancel = (): void => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = hideTimer = undefined;
  };

  const show = (): void => {
    cancel();
    if (dismissed || chip.hidden || isOpen()) return;
    tip.showPopover();
    place();
    addEventListener('scroll', place, { passive: true, capture: true });
    addEventListener('resize', place, { passive: true });
  };

  const hide = (): void => {
    cancel();
    if (!isOpen()) return;
    tip.hidePopover();
    removeEventListener('scroll', place, { capture: true });
    removeEventListener('resize', place);
  };

  const showSoon = (): void => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    if (!isOpen() && !showTimer) showTimer = setTimeout(show, SHOW_DELAY_MS);
  };
  const hideSoon = (): void => {
    clearTimeout(showTimer);
    showTimer = undefined;
    // Keyboard focus keeps it open until blur; a mouse click's focus does not.
    if (chip.matches(':focus-visible')) return;
    hideTimer ??= setTimeout(hide, HIDE_DELAY_MS);
  };

  chip.addEventListener('pointerenter', showSoon);
  chip.addEventListener('pointerleave', (event) => {
    dismissed = false;
    // A tap's pointer "leaves" as the finger lifts; let blur close it instead.
    if (event.pointerType !== 'touch') hideSoon();
  });
  // Keyboard focus opens at once; so does a click or tap, which focuses it.
  chip.addEventListener('focus', show);
  chip.addEventListener('blur', () => {
    dismissed = false;
    hide();
  });
  // Hoverable: moving onto the tooltip keeps it open.
  tip.addEventListener('pointerenter', () => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  });
  tip.addEventListener('pointerleave', () => {
    dismissed = false;
    hideTimer ??= setTimeout(hide, HIDE_DELAY_MS);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !(isOpen() || showTimer)) return;
    dismissed = true;
    hide();
  });

  return {
    update: (reading): void => {
      if (!reading) {
        signature = '';
        hide();
        return;
      }
      const next = JSON.stringify([
        reading.heading,
        reading.subheading,
        reading.details,
      ]);
      if (next === signature) return;
      signature = next;
      build(tip, reading);
      if (isOpen()) place();
    },
  };
}
