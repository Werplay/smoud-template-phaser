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
