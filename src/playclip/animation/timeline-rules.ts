// Timeline rules (PlayClip Phase 1): Loop, Jump and Freeze as one engine.
// Each is a rule that fires when the playhead reaches a time:
//   freeze = time reached → pause (hold until a button breaks out),
//   jump   = time reached → seek past the section,
//   loop   = end reached  → seek back to its start (until broken out of).
// The editor, Preview and the Phaser export all step the same engine every
// frame with the playhead (source time) and carry out the commands it returns
// with their own video. Asset interactions with a `timeReached` trigger use
// `crossed` to fire as the playhead passes their time.

export interface RuleControl {
  id: string;
  startTime: number;
  endTime: number;
  /** Loops: 'pingpong' plays forward then backward. */
  mode?: 'forward' | 'pingpong';
}

export type RuleCommand =
  /** Seek to `t` and keep playing (a loop restart or a jump). */
  | { kind: 'seek'; t: number; rule: RuleControl; ruleKind: 'loop' | 'jump' }
  /** Hold at `t`: seek there if needed and pause (a freeze). */
  | { kind: 'hold'; t: number; rule: RuleControl }
  /** A ping-pong loop reached its end: play it backward to its start. */
  | { kind: 'reverse'; rule: RuleControl }
  /** A ping-pong loop is (about to be) playing: keep its frames for reversing. */
  | { kind: 'watch'; rule: RuleControl };

/** How far past a loop's end, or a jump's start, the playhead may be read. */
const LOOP_END = 0.02;
const LEFT_SECTION = 0.1;
const JUMP_LEAD = 0.26;
const EPS = 0.001;
/** A freeze holds within this of its time; further away it has been left. */
export const FREEZE_TOLERANCE = 0.1;

const leftFreeze = (t: number, f: RuleControl) =>
  t < f.startTime - EPS || t > f.startTime + FREEZE_TOLERANCE;

export class TimelineRules {
  loop: RuleControl | null = null;
  jump: RuleControl | null = null;
  freeze: RuleControl | null = null;
  /** Playhead at the last step (−1 so a freeze at 0 still fires). */
  private last = -1;
  /** The span the playhead moved through on the last step (for `crossed`). */
  from = -1;
  to = -1;
  // Freezes already stopped on; re-armed once the playhead leaves them, so
  // breaking out doesn't re-trap while playing out of the same frame.
  private triggered = new Set<string>();

  constructor(
    private loops: RuleControl[] = [],
    private jumps: RuleControl[] = [],
    private freezes: RuleControl[] = [],
    /** The ping-pong backward half is baked into the video (export). */
    private bakedPingPong = false,
  ) {}

  /** New rules (another clip): start afresh. */
  setRules(loops: RuleControl[], jumps: RuleControl[], freezes: RuleControl[], at = -1) {
    this.loops = loops;
    this.jumps = jumps;
    this.freezes = freezes;
    this.triggered.clear();
    this.seeked(at);
  }

  /**
   * The playhead was moved from outside the engine (a button, the timeline,
   * a goTo): leave any active rule, and don't read the move as a crossing.
   */
  seeked(t: number) {
    this.loop = null;
    this.jump = null;
    this.freeze = null;
    this.last = t;
    this.from = this.to = t;
  }

  /** A button broke out of the active loop, jump or freeze (playback resumes). */
  breakOut() {
    this.loop = null;
    this.jump = null;
    this.freeze = null;
  }

  /**
   * A "play" action: leave the active rule. Inside a loop, returns where to
   * seek (just past its end, so also past a ping-pong's reversed copy) so it
   * doesn't take the playhead straight back; otherwise null.
   */
  playOn(): number | null {
    const l = this.loop;
    this.breakOut();
    if (!l) return null;
    const at = l.endTime + EPS;
    this.last = this.from = this.to = at;
    return at;
  }

  /** Advance to playhead `t`; returns what the renderer should do. */
  step(t: number): RuleCommand[] {
    const prev = this.last;
    this.last = t;
    this.from = prev;
    this.to = t;
    const out: RuleCommand[] = [];

    // Loops own the playhead while active.
    if (this.loop) {
      const l = this.loop;
      if (l.mode === 'pingpong') {
        if (!this.bakedPingPong) {
          out.push({ kind: 'watch', rule: l });
          if (t >= l.endTime - LOOP_END) {
            out.push({ kind: 'reverse', rule: l });
            return out;
          }
        }
      } else if (t >= l.endTime - LOOP_END) {
        this.last = l.startTime;
        out.push({ kind: 'seek', t: l.startTime + EPS, rule: l, ruleKind: 'loop' });
        return out;
      }
      if (t < l.startTime || t > l.endTime + LEFT_SECTION) this.loop = null;
      else return out;
    } else {
      // Keep frames from just before a ping-pong loop.
      const soon = this.loops.find(
        (l) => l.mode === 'pingpong' && t <= l.endTime && l.startTime - t < 1.5,
      );
      if (soon && !this.bakedPingPong) out.push({ kind: 'watch', rule: soon });
      const found = this.loops.find((l) => t >= l.startTime && t <= l.endTime);
      if (found) {
        this.loop = found;
        this.jump = null;
        return out;
      }
    }

    if (this.jump) {
      if (t < this.jump.startTime || t > this.jump.endTime + LEFT_SECTION) this.jump = null;
      else return out;
    } else {
      const found = this.jumps.find(
        (j) => t >= j.startTime - JUMP_LEAD && t <= j.startTime,
      );
      if (found) {
        this.jump = found;
        this.last = found.endTime;
        out.push({ kind: 'seek', t: found.endTime + EPS, rule: found, ruleKind: 'jump' });
        return out;
      }
    }

    if (this.freeze) {
      if (leftFreeze(t, this.freeze)) this.freeze = null;
      else out.push({ kind: 'hold', t: this.freeze.startTime, rule: this.freeze });
      return out;
    }
    for (const f of this.freezes)
      if (this.triggered.has(f.id) && leftFreeze(t, f)) this.triggered.delete(f.id);
    // The first freeze reached or crossed since the last step, so a frame
    // that jumps past it still stops.
    const found = this.freezes.find(
      (f) =>
        !this.triggered.has(f.id) &&
        t >= f.startTime - EPS &&
        prev < f.startTime - EPS,
    );
    if (found) {
      this.freeze = found;
      this.triggered.add(found.id);
      this.last = found.startTime;
      out.push({ kind: 'hold', t: found.startTime, rule: found });
    }
    return out;
  }

  /** True when the playhead passed `t` on the last step (moving forward). */
  crossed(t: number): boolean {
    return this.from < t - EPS && this.to >= t - EPS && this.to - this.from < 1;
  }
}
