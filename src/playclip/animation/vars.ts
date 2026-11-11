// Counters (PlayClip Phase 1): number variables changed by addVar / setVar
// actions and read by varReaches triggers and progress bars. Each renderer
// keeps one Vars for a run of the ad; every counter starts at 0.

export interface VarChange {
  name: string;
  from: number;
  to: number;
}

export class Vars {
  private values = new Map<string, number>();

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  /** Add to (or set) a counter; returns the change, or null if none. */
  apply(a: { kind: 'addVar' | 'setVar'; name: string; value: number }): VarChange | null {
    const from = this.get(a.name);
    const to = a.kind === 'addVar' ? from + a.value : a.value;
    if (!a.name || !Number.isFinite(to) || to === from) return null;
    this.values.set(a.name, to);
    return { name: a.name, from, to };
  }

  reset(): void {
    this.values.clear();
  }
}

/** How full a bar showing `value` out of `max` is (0–1). */
export const fillOf = (value: number, max: number): number =>
  max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

/** A progress bar's look when its style leaves it unset (every renderer). */
export const PROGRESS_DEFAULTS = {
  fill: '#22c55e',
  track: 'rgba(255,255,255,0.35)',
  radius: '999px',
};

// Counter roll-up: a text containing `{name}` shows that counter's value, and
// counts up (or down) to each new value over ROLL_MS instead of jumping.

export const ROLL_MS = 600;
const TOKEN = /\{([A-Za-z_][\w-]*)\}/g;

/** The counter names a text shows, e.g. "{taps}/10" → ["taps"]. */
export const counterTokens = (text: string): string[] =>
  Array.from(text.matchAll(new RegExp(TOKEN.source, 'g')), (m) => m[1]);

/** `text` with each `{name}` replaced by `value(name)`. */
export const fillCounters = (text: string, value: (name: string) => number) =>
  text.replace(new RegExp(TOKEN.source, 'g'), (_, name: string) =>
    String(value(name)),
  );

/** The value each counter shows while it rolls to its latest value. */
export class RollingCounters {
  private rolls = new Map<string, { from: number; to: number; t0: number }>();

  /** The counter changed to `to` at `now` (ms). */
  set(name: string, to: number, now: number): void {
    this.rolls.set(name, { from: this.value(name, now), to, t0: now });
  }

  value(name: string, now: number): number {
    const r = this.rolls.get(name);
    if (!r) return 0;
    const k = Math.min(1, Math.max(0, (now - r.t0) / ROLL_MS));
    const eased = 1 - Math.pow(1 - k, 3);
    return Math.round(r.from + (r.to - r.from) * eased);
  }

  /** True while some counter is still rolling. */
  rolling(now: number): boolean {
    return Array.from(this.rolls.values()).some((r) => now - r.t0 < ROLL_MS);
  }

  reset(): void {
    this.rolls.clear();
  }
}
