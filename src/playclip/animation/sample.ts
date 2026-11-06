// sampleAnimation: an asset's animation state at a moment, as plain numbers.
// Every renderer (editor canvas, HTML preview player, Phaser export) calls
// this, so presets look identical everywhere.
//
// Keep this folder free of DOM/Phaser/app imports: it is copied verbatim into
// the smoud Phaser template at export time.

import {
  aeEaseToBezier,
  cssEasing,
  cubicBezier,
  CSS_EASINGS,
  type EaseFn,
} from './ease';
import { seedOf, wiggle } from './noise';
import {
  ENTRY_PRESETS,
  EXIT_PRESETS,
  LOOP_PRESETS,
  type AnimPreset,
  type Channel,
  type KeyEase,
  type KeyValue,
  type LoopPreset,
  type Track,
} from './presets';

/** The style fields animation reads (a subset of the editor's AssetStyle). */
export interface AnimStyle {
  entryAnimation?: string;
  exitAnimation?: string;
  animationStyle?: string;
  /** Shared entry/exit duration (ms); entryDuration/exitDuration override it. */
  animationDuration?: number;
  entryDuration?: number;
  exitDuration?: number;
  animationEasing?: string;
  animationOpacityFrom?: number;
  animationOpacityTo?: number;
  animationScaleFrom?: number;
  animationScaleTo?: number;
  animationSlideDistance?: number;
  gestureSpeed?: number;
  gestureDistance?: number;
  /** Resting opacity (0..1); animation multiplies on top of it. */
  opacity?: number;
}

/**
 * Two clocks, in seconds:
 * - sinceStart: time since the asset appeared. Drives entry and loops. During
 *   playback renderers advance it in real time, including through freezes, so
 *   a tutorial pointer keeps tapping while the video is held.
 * - untilEnd: video time left before the asset's end. Drives the exit, which
 *   plays in the last exit duration of the asset's window.
 */
export interface AnimClock {
  sinceStart: number;
  untilEnd: number;
}

export interface AnimSample {
  opacity: number;
  /** Offsets in design px (editor video px); renderers scale to screen. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  glow: number;
}

export const IDENTITY: AnimSample = {
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  glow: 0,
};

/** Gap between the end of the entry and the start of the loop (matches the editor). */
const LOOP_DELAY_AFTER_ENTRY = 0.1;
const LOOP_EASE = CSS_EASINGS['ease-in-out'];

const PARAM = /^(?:(-?\d*\.?\d+)\*|(-))?\$(\w+)$/;
const ONE_MINUS = /^1-\$(\w+)$/;

export function resolveValue(
  v: KeyValue,
  params: Record<string, number>,
): number {
  if (typeof v === 'number') return v;
  const m = PARAM.exec(v);
  if (m) {
    const k = m[1] !== undefined ? parseFloat(m[1]) : m[2] ? -1 : 1;
    return k * (params[m[3]] ?? 0);
  }
  const om = ONE_MINUS.exec(v);
  if (om) return 1 - (params[om[1]] ?? 0);
  return 0;
}

function keyEaseFn(
  ease: KeyEase,
  segmentSeconds: number,
  delta: number,
): EaseFn | 'hold' {
  if (ease === 'hold') return 'hold';
  if (typeof ease === 'string') return CSS_EASINGS[ease] ?? CSS_EASINGS.ease;
  if ('bezier' in ease) return cubicBezier(...ease.bezier);
  return cubicBezier(...aeEaseToBezier(ease.ae, segmentSeconds, delta));
}

/**
 * Value of a track at normalised time p. Each segment uses the easing on its
 * starting key, else `ease` (like CSS keyframes, the curve spans one segment).
 * `seconds` is the preset's real length, needed for After Effects speeds.
 */
export function evalTrack(
  track: Track,
  p: number,
  params: Record<string, number>,
  ease: EaseFn,
  seconds = 1,
): number {
  if (p <= track[0][0]) return resolveValue(track[0][1], params);
  for (let i = 1; i < track.length; i++) {
    const t1 = track[i][0];
    if (p <= t1) {
      const [t0, v0, keyEase] = track[i - 1];
      const a = resolveValue(v0, params);
      const b = resolveValue(track[i][1], params);
      const fn = keyEase
        ? keyEaseFn(keyEase, (t1 - t0) * seconds, b - a)
        : ease;
      if (fn === 'hold') return p < t1 ? a : b;
      const local = t1 > t0 ? (p - t0) / (t1 - t0) : 1;
      return a + (b - a) * fn(local);
    }
  }
  return resolveValue(track[track.length - 1][1], params);
}

function combine(out: AnimSample, ch: Channel, v: number) {
  if (ch === 'opacity' || ch === 'scale') out[ch] *= v;
  else if (ch === 'glow') out.glow = Math.max(out.glow, v);
  else out[ch] += v;
}

function applyPreset(
  out: AnimSample,
  preset: AnimPreset,
  p: number,
  params: Record<string, number>,
  ease: EaseFn,
  seconds: number,
) {
  for (const ch of Object.keys(preset.tracks) as Channel[]) {
    combine(out, ch, evalTrack(preset.tracks[ch]!, p, params, ease, seconds));
  }
}

/** Phase within a loop: 'cycle' restarts, 'pingpong' runs back (EffectCraft loopOut). */
export function loopPhase(
  time: number,
  period: number,
  mode: LoopPreset['mode'],
): number {
  const cycles = time / period;
  const frac = cycles - Math.floor(cycles);
  if (mode !== 'pingpong') return frac;
  return Math.floor(cycles) % 2 === 0 ? frac : 1 - frac;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The resting pose: no animation, only the asset's own opacity. */
export function restSample(style: AnimStyle | undefined): AnimSample {
  return { ...IDENTITY, opacity: clampOpacity(style?.opacity ?? 1) };
}

const clampOpacity = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seconds = (ms: number | undefined, fallback: number) =>
  Math.max(0.001, (ms ?? fallback) / 1000);

/**
 * The asset's animation at this moment. `seed` (e.g. the asset id) keeps
 * procedural loops like wiggle identical across renderers but different
 * between assets.
 */
export function sampleAnimation(
  style: AnimStyle | undefined,
  clock: AnimClock,
  seed?: string | number,
): AnimSample {
  const out = restSample(style);
  if (!style) return out;

  const shared = style.animationDuration ?? 500;
  const entryDur = seconds(style.entryDuration, shared);
  const exitDur = seconds(style.exitDuration, shared);
  const ease = cssEasing(style.animationEasing);
  const entry = style.entryAnimation
    ? ENTRY_PRESETS[style.entryAnimation]
    : undefined;
  const exit = style.exitAnimation
    ? EXIT_PRESETS[style.exitAnimation]
    : undefined;
  const loop = style.animationStyle
    ? LOOP_PRESETS[style.animationStyle]
    : undefined;

  const slide = style.animationSlideDistance ?? 100;
  const exiting = !!exit && clock.untilEnd < exitDur;

  if (entry && clock.sinceStart < entryDur) {
    applyPreset(
      out,
      entry,
      clamp01(clock.sinceStart / entryDur),
      {
        opFrom: style.animationOpacityFrom ?? 0,
        opTo: style.animationOpacityTo ?? 1,
        scFrom: style.animationScaleFrom ?? 0,
        scTo: style.animationScaleTo ?? 1,
        slide,
      },
      ease,
      entryDur,
    );
  }

  if (exit && exiting) {
    applyPreset(
      out,
      exit,
      clamp01(1 - clock.untilEnd / exitDur),
      {
        opFrom: style.animationOpacityFrom ?? 1,
        opTo: style.animationOpacityTo ?? 0,
        scFrom: style.animationScaleFrom ?? 1,
        scTo: style.animationScaleTo ?? 0,
        slide,
      },
      ease,
      exitDur,
    );
  }

  if (loop && !exiting) {
    const delay = entry ? entryDur + LOOP_DELAY_AFTER_ENTRY : 0;
    const loopTime = clock.sinceStart - delay;
    if (loopTime >= 0 && Number.isFinite(loopTime)) {
      const periodMs = loop.gesture
        ? (style.gestureSpeed ?? loop.periodMs)
        : loop.periodMs;
      const period = Math.max(0.05, periodMs / 1000);
      const d = loop.defaults ?? {};
      const params = {
        dist: style.gestureDistance ?? d.dist ?? 24,
        radius: style.gestureDistance ?? d.radius ?? 14,
        tapDepth: Math.min(
          1,
          (style.gestureDistance ?? d.tapDepth ?? 18) / 100,
        ),
      };
      applyPreset(
        out,
        loop,
        loopPhase(loopTime, period, loop.mode),
        params,
        LOOP_EASE,
        period,
      );
      if (loop.wiggle) {
        const amp = resolveValue(loop.wiggle.amp, params);
        const base = seedOf(seed);
        loop.wiggle.channels.forEach((ch, i) =>
          combine(
            out,
            ch,
            wiggle(
              loopTime,
              1 / period,
              amp,
              base + i * 7919,
              loop.wiggle!.octaves ?? 1,
            ),
          ),
        );
      }
    }
  }

  out.opacity = clampOpacity(out.opacity);
  return out;
}
