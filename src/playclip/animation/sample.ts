// sampleAnimation: an asset's animation state at a moment, as plain numbers.
// Every renderer (editor canvas, HTML preview player, Phaser export) calls
// this, so presets look identical everywhere.
//
// Keep this file free of DOM/Phaser/app imports: it is copied verbatim into
// the smoud Phaser template at export time.

import { cssEasing, CSS_EASINGS, type EaseFn } from './ease';
import {
  ENTRY_PRESETS,
  EXIT_PRESETS,
  LOOP_PRESETS,
  type AnimPreset,
  type Channel,
  type KeyValue,
  type Track,
} from './presets';

/** The style fields animation reads (a subset of the editor's AssetStyle). */
export interface AnimStyle {
  entryAnimation?: string;
  exitAnimation?: string;
  animationStyle?: string;
  animationDuration?: number;
  animationEasing?: string;
  animationOpacityFrom?: number;
  animationOpacityTo?: number;
  animationScaleFrom?: number;
  animationScaleTo?: number;
  animationSlideDistance?: number;
  gestureSpeed?: number;
  gestureDistance?: number;
}

/**
 * Two clocks, in seconds:
 * - sinceStart: time since the asset appeared. Drives entry and loops. During
 *   playback renderers advance it in real time, including through freezes, so
 *   a tutorial pointer keeps tapping while the video is held.
 * - untilEnd: video time left before the asset's end. Drives the exit, which
 *   plays in the last `animationDuration` of the asset's window.
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

/** Value of a track at normalised time p; `ease` shapes each segment, like CSS keyframes. */
export function evalTrack(
  track: Track,
  p: number,
  params: Record<string, number>,
  ease: EaseFn,
): number {
  if (p <= track[0][0]) return resolveValue(track[0][1], params);
  for (let i = 1; i < track.length; i++) {
    const [t1, v1] = track[i];
    if (p <= t1) {
      const [t0, v0] = track[i - 1];
      const a = resolveValue(v0, params);
      const b = resolveValue(v1, params);
      const local = t1 > t0 ? (p - t0) / (t1 - t0) : 1;
      return a + (b - a) * ease(local);
    }
  }
  return resolveValue(track[track.length - 1][1], params);
}

function applyPreset(
  out: AnimSample,
  preset: AnimPreset,
  p: number,
  params: Record<string, number>,
  ease: EaseFn,
) {
  for (const ch of Object.keys(preset.tracks) as Channel[]) {
    const v = evalTrack(preset.tracks[ch]!, p, params, ease);
    if (ch === 'opacity' || ch === 'scale') out[ch] *= v;
    else if (ch === 'glow') out.glow = Math.max(out.glow, v);
    else out[ch] += v;
  }
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function sampleAnimation(
  style: AnimStyle | undefined,
  clock: AnimClock,
): AnimSample {
  const out = { ...IDENTITY };
  if (!style) return out;

  const duration = Math.max(0.001, (style.animationDuration ?? 500) / 1000);
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
  const exiting = !!exit && clock.untilEnd < duration;

  if (entry && clock.sinceStart < duration) {
    applyPreset(
      out,
      entry,
      clamp01(clock.sinceStart / duration),
      {
        opFrom: style.animationOpacityFrom ?? 0,
        opTo: style.animationOpacityTo ?? 1,
        scFrom: style.animationScaleFrom ?? 0,
        scTo: style.animationScaleTo ?? 1,
        slide,
      },
      ease,
    );
  }

  if (exit && exiting) {
    applyPreset(
      out,
      exit,
      clamp01(1 - clock.untilEnd / duration),
      {
        opFrom: style.animationOpacityFrom ?? 1,
        opTo: style.animationOpacityTo ?? 0,
        scFrom: style.animationScaleFrom ?? 1,
        scTo: style.animationScaleTo ?? 0,
        slide,
      },
      ease,
    );
  }

  if (loop && !exiting) {
    const delay = entry ? duration + LOOP_DELAY_AFTER_ENTRY : 0;
    const loopTime = clock.sinceStart - delay;
    if (loopTime >= 0) {
      const periodMs = loop.gesture
        ? (style.gestureSpeed ?? loop.periodMs)
        : loop.periodMs;
      const period = Math.max(0.05, periodMs / 1000);
      const phase = (loopTime % period) / period;
      applyPreset(
        out,
        loop,
        phase,
        {
          dist: style.gestureDistance ?? 24,
          radius: style.gestureDistance ?? 14,
          tapDepth: Math.min(1, (style.gestureDistance ?? 18) / 100),
        },
        LOOP_EASE,
      );
    }
  }

  return out;
}
