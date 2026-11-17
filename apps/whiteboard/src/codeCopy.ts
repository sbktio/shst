import type { Announcer } from './announce';

/**
 * The session code as a button that copies it. A click (or Enter/Space)
 * writes the code to the clipboard, swaps the copy icon for a check and
 * "Copied" for a moment, then reverts. Reduced motion gets the same state
 * change without the animation (see .code-copy in index.html).
 *
 * The async Clipboard API needs a secure context, which a LAN address
 * (http://192.168.…) is not, so a failed write falls back to the legacy copy
 * command. If that fails too, the code is selected for a manual copy and the
 * announcement says so.
 */

export interface CodeCopy {
  /** Show the code (or hide the button when there is none). */
  setCode(code: string | undefined): void;
}

/** How long "Copied" (or "Copy failed") shows; the CSS animates within it. */
const CONFIRM_MS = 1200;

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen';
  document.body.append(area);
  area.select();
  try {
    // Deprecated, but the only path on insecure origins.
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable; try the legacy path below.
  }
  return legacyCopy(text);
}

export function createCodeCopy(
  button: HTMLButtonElement,
  announcer: Announcer
): CodeCopy {
  const text = button.querySelector('.code-copy-text') as HTMLElement;
  const label = button.querySelector('.code-copy-label') as HTMLElement;
  let code = '';
  let revert: ReturnType<typeof setTimeout> | undefined;

  const setState = (state: 'idle' | 'copied' | 'failed'): void => {
    button.dataset.state = state;
    label.textContent =
      state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy';
  };

  /** Select the code so Cmd/Ctrl+C works when the clipboard is refused. */
  const selectCode = (): void => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  button.addEventListener('click', () => {
    if (!code) return;
    const copying = code;
    void writeClipboard(copying).then((ok) => {
      if (copying !== code) return;
      clearTimeout(revert);
      // Restart the confirmation animation on a repeated click.
      button.dataset.state = 'idle';
      void button.offsetWidth;
      setState(ok ? 'copied' : 'failed');
      if (ok) announcer.announce('Code copied to the clipboard');
      else {
        selectCode();
        announcer.announce(`Could not copy; the code is ${copying}`);
      }
      revert = setTimeout(() => setState('idle'), CONFIRM_MS);
    });
  });

  setState('idle');
  return {
    setCode: (next): void => {
      const value = next ?? '';
      button.hidden = !value;
      if (value === code) return;
      code = value;
      text.textContent = value;
      button.setAttribute('aria-label', `Copy session code ${value}`);
      clearTimeout(revert);
      setState('idle');
    },
  };
}
