// Gesture recognition shared by the editor, Preview and the Phaser export.
// Each renderer feeds one press (pointer down → moves → up) into a `Press`
// and turns what it recognises into a GestureEvent for `actionsFor`
// (interactions.ts). Distances are in CSS pixels, times in milliseconds.

export type Direction = 'left' | 'right' | 'up' | 'down';

/** A press that moves less than this is still a tap or a hold. */
export const TAP_SLOP = 10;
/** A swipe covers at least this distance… */
export const SWIPE_MIN_DISTANCE = 40;
/** …at no less than this average speed (px/ms). */
export const SWIPE_MIN_SPEED = 0.25;
/** Taps further apart than this start a new tap count. */
export const TAP_COUNT_GAP = 400;

export function directionOf(dx: number, dy: number): Direction {
  return Math.abs(dx) >= Math.abs(dy)
    ? dx < 0
      ? 'left'
      : 'right'
    : dy < 0
      ? 'up'
      : 'down';
}

/** One pointer press, from down to up. */
export class Press {
  dx = 0;
  dy = 0;
  /** Furthest the pointer got from where it went down. */
  moved = 0;
  /** A hold trigger fired during this press (so its release is no tap). */
  held = false;

  constructor(
    readonly x0: number,
    readonly y0: number,
    readonly t0: number,
  ) {}

  move(x: number, y: number): void {
    this.dx = x - this.x0;
    this.dy = y - this.y0;
    this.moved = Math.max(this.moved, Math.hypot(this.dx, this.dy));
  }

  /** Still close enough to where it went down to count as a tap or hold. */
  get still(): boolean {
    return this.moved < TAP_SLOP;
  }

  /** What the release was: a tap, a swipe, or nothing (a slow drag). */
  end(
    x: number,
    y: number,
    t: number,
  ): { kind: 'tap' } | { kind: 'swipe'; dir: Direction } | null {
    this.move(x, y);
    if (this.still) return this.held ? null : { kind: 'tap' };
    const d = Math.hypot(this.dx, this.dy);
    const speed = d / Math.max(1, t - this.t0);
    if (d >= SWIPE_MIN_DISTANCE && speed >= SWIPE_MIN_SPEED)
      return { kind: 'swipe', dir: directionOf(this.dx, this.dy) };
    return null;
  }
}

/** Counts quick successive taps per asset. */
export class TapCounter {
  private last = new Map<string, { t: number; n: number }>();

  /** Record a tap on `id` at `t` and return how many in a row it makes. */
  tap(id: string, t: number): number {
    const prev = this.last.get(id);
    const n = prev && t - prev.t <= TAP_COUNT_GAP ? prev.n + 1 : 1;
    this.last.set(id, { t, n });
    return n;
  }

  reset(id?: string): void {
    if (id) this.last.delete(id);
    else this.last.clear();
  }
}
