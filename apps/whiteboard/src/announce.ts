/**
 * Brief announcements over the top of the board ("Ada joined · direct
 * WebRTC", "Bo left"). Each one eases in on a decelerating curve, dwells,
 * then eases out accelerating (see #announce in index.html). Announcements
 * queue rather than overlap; a burst collapses to the latest few.
 */

export interface Announcer {
  announce(message: string): void;
}

const DURATION_MS = 3200;
const MAX_QUEUED = 3;

export function createAnnouncer(element: HTMLElement): Announcer {
  const queue: string[] = [];
  let showing = false;

  const next = (): void => {
    const message = queue.shift();
    if (message === undefined) {
      showing = false;
      return;
    }
    showing = true;
    element.textContent = message;
    element.style.setProperty('--announce-ms', `${DURATION_MS}ms`);
    element.classList.remove('show');
    void element.offsetWidth; // restart the animation
    element.classList.add('show');
  };

  element.addEventListener('animationend', () => {
    element.classList.remove('show');
    next();
  });

  return {
    announce: (message): void => {
      queue.push(message);
      if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
      if (!showing) next();
    },
  };
}
