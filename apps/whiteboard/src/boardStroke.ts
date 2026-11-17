/**
 * The board's border highlight: a 2 px "chaser" that travels around the
 * board's rounded edge while a session is getting going, and stops once
 * everyone is connected.
 *
 * The chaser is a conic gradient masked to exactly the border band and given
 * the board's corner radius (see `.board-wrap::after` in index.html), so it
 * follows the corners and draws nothing beside the stroke. This module only
 * eases two custom properties each frame: `--edge-angle` and `--edge-alpha`.
 *
 * Modes: `idle` (not in a session) is faint, `waiting` (hosting or joining,
 * nobody else here yet) is brighter, `live` (connected with others) holds
 * for `SETTLE_MS`, then fades the chaser out and stops animating. Reduced
 * motion holds it still.
 */

export type StrokeMode = 'idle' | 'waiting' | 'live';

export interface BoardStroke {
  setMode(mode: StrokeMode): void;
}

/** Degrees per second and highlight opacity for each mode. */
const TARGET: Record<StrokeMode, { speed: number; alpha: number }> = {
  idle: { speed: 3, alpha: 0.25 },
  waiting: { speed: 7, alpha: 0.9 },
  live: { speed: 2, alpha: 0 },
};

/** How long a connected board keeps the chaser before it fades out. */
export const SETTLE_MS = 3000;

export function createBoardStroke(element: HTMLElement): BoardStroke {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let mode: StrokeMode = 'idle';
  let target = TARGET.idle;
  let speed = target.speed;
  let alpha = target.alpha;
  let angle = 210;
  let frame = 0;
  let last = performance.now();
  let settle: ReturnType<typeof setTimeout> | undefined;

  const apply = (): void => {
    element.style.setProperty('--edge-angle', `${angle.toFixed(2)}deg`);
    element.style.setProperty('--edge-alpha', alpha.toFixed(3));
  };

  const tick = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // Ease speed and strength toward the target over about a second.
    const ease = 1 - Math.exp(-dt * 2.5);
    speed += (target.speed - speed) * ease;
    alpha += (target.alpha - alpha) * ease;
    angle = (angle + speed * dt) % 360;
    // Once the chaser has faded out completely, stop animating.
    if (target.alpha === 0 && alpha < 0.002) {
      alpha = 0;
      apply();
      frame = 0;
      return;
    }
    apply();
    frame = requestAnimationFrame(tick);
  };

  const run = (): void => {
    if (reducedMotion.matches) {
      cancelAnimationFrame(frame);
      frame = 0;
      alpha = target.alpha;
      apply();
      return;
    }
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };

  reducedMotion.addEventListener('change', run);
  apply();
  run();

  return {
    setMode: (next): void => {
      if (next === mode) return;
      mode = next;
      clearTimeout(settle);
      if (next === 'live') {
        // Keep the current chaser for a moment, then let it fade and stop.
        settle = setTimeout(() => {
          target = TARGET.live;
          run();
        }, SETTLE_MS);
        return;
      }
      target = TARGET[next];
      run();
    },
  };
}
