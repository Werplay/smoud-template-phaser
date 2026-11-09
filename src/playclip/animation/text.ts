// Text animators: per-character or per-word reveals, shared by the editor,
// Preview and the Phaser export. After EffectCraft's text animators: a range
// selector sweeps across the text's units (crates/text/src/selectors.rs,
// `range_value`, Square shape with smoothness) and each unit's selection
// drives its opacity, offset and scale (crates/render/src/text.rs,
// `char_transforms`).

import { cubicBezier } from './ease';

export type TextAnimatorPreset = 'typewriter' | 'fadeUpChars' | 'bounceInWords';
export type TextUnitKind = 'chars' | 'words';

export interface TextAnimatorStyle {
  textAnimator?: TextAnimatorPreset | 'none';
  /** Total reveal time (ms); absent = from the preset's per-unit pace. */
  textAnimatorDuration?: number;
}

interface PresetSpec {
  label: string;
  unit: TextUnitKind;
  /** Default pace: ms per unit. */
  msPerUnit: number;
  /** Selector smoothness, in units (0 = a hard step). */
  window: number;
}

export const TEXT_ANIMATORS: Record<TextAnimatorPreset, PresetSpec> = {
  typewriter: { label: 'Typewriter', unit: 'chars', msPerUnit: 55, window: 0 },
  fadeUpChars: {
    label: 'Fade Up Characters',
    unit: 'chars',
    msPerUnit: 35,
    window: 4,
  },
  bounceInWords: {
    label: 'Bounce In Words',
    unit: 'words',
    msPerUnit: 140,
    window: 1.5,
  },
};

export const activeTextAnimator = (
  s: TextAnimatorStyle | undefined,
): TextAnimatorPreset | null =>
  s?.textAnimator &&
  s.textAnimator !== 'none' &&
  s.textAnimator in TEXT_ANIMATORS
    ? s.textAnimator
    : null;

/**
 * Split text into units and the whitespace between them. Whitespace is never
 * a unit, so wrapping (which may drop spaces) can't change the unit count.
 */
export function textUnits(
  text: string,
  kind: TextUnitKind,
): Array<{ text: string; unit: number | null }> {
  const out: Array<{ text: string; unit: number | null }> = [];
  let n = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) out.push({ text: part, unit: null });
    else if (kind === 'words') out.push({ text: part, unit: n++ });
    else for (const ch of Array.from(part)) out.push({ text: ch, unit: n++ });
  }
  return out;
}

export const countUnits = (text: string, kind: TextUnitKind) =>
  textUnits(text, kind).filter((u) => u.unit !== null).length;

/** Total reveal time in seconds. */
export function textAnimatorDuration(
  style: TextAnimatorStyle,
  n: number,
): number {
  const p = activeTextAnimator(style);
  if (!p) return 0;
  const ms =
    style.textAnimatorDuration && style.textAnimatorDuration > 0
      ? style.textAnimatorDuration
      : TEXT_ANIMATORS[p].msPerUnit * Math.max(1, n);
  return ms / 1000;
}

/**
 * Selection (0..1) of unit `i` of `n` at `progress` (0..1): a range whose end
 * sweeps from before the first unit to past the last, with `window` units of
 * smoothness (EffectCraft's Square range selector).
 */
export function unitSelection(
  i: number,
  n: number,
  progress: number,
  window: number,
): number {
  if (n <= 0) return 1;
  const p = Math.max(0, Math.min(1, progress));
  if (p >= 1) return 1;
  // A hard step: unit i appears once the sweep has passed it, so the last
  // unit lands exactly at the end.
  if (window <= 0) return p * n >= i + 1 - 1e-9 ? 1 : 0;
  const head = p * (n + window);
  return Math.max(0, Math.min(1, (head - i) / window));
}

export interface UnitSample {
  opacity: number;
  /** Vertical offset in em (multiply by the font size). */
  y: number;
  scale: number;
}

export const UNIT_REST: UnitSample = { opacity: 1, y: 0, scale: 1 };

const easeOut = cubicBezier(0.215, 0.61, 0.355, 1);
// easeOutBack: overshoots, then settles at 1.
const backOut = (t: number) => {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

/** Unit `i` of `n`, `sinceStart` seconds after the asset appeared. */
export function sampleTextUnit(
  style: TextAnimatorStyle,
  i: number,
  n: number,
  sinceStart: number,
): UnitSample {
  const p = activeTextAnimator(style);
  if (!p) return UNIT_REST;
  const d = textAnimatorDuration(style, n);
  const spec = TEXT_ANIMATORS[p];
  const v = unitSelection(i, n, d > 0 ? sinceStart / d : 1, spec.window);
  switch (p) {
    case 'typewriter':
      return { opacity: v, y: 0, scale: 1 };
    case 'fadeUpChars': {
      const e = easeOut(v);
      return { opacity: e, y: (1 - e) * 0.6, scale: 1 };
    }
    case 'bounceInWords':
      return {
        opacity: Math.min(1, v * 3),
        y: 0,
        scale: v <= 0 ? 0 : backOut(v),
      };
  }
}

/** True once every unit is at rest (renderers can drop per-unit work). */
export const textAnimatorDone = (
  style: TextAnimatorStyle,
  n: number,
  sinceStart: number,
) => !activeTextAnimator(style) || sinceStart >= textAnimatorDuration(style, n);
