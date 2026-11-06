// CSS timing functions as plain functions of progress (0..1 → 0..1).
// The cubic-bézier solver follows EffectCraft's keyframe evaluator
// (crates/keyframe/src/lib.rs, MIT OR Apache-2.0): Newton's method on x(t),
// with bisection when the slope is too flat for Newton to converge.

export type EaseFn = (p: number) => number;

export type CssEasing =
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out';

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EaseFn {
  // Polynomial coefficients for B(t) = ((a t + b) t + c) t on each axis.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) return t;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return sampleY(solveT(p));
  };
}

const linear: EaseFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p);

/** The CSS named timing functions, with their spec control points. */
export const CSS_EASINGS: Record<CssEasing, EaseFn> = {
  linear,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  'ease-in': cubicBezier(0.42, 0, 1, 1),
  'ease-out': cubicBezier(0, 0, 0.58, 1),
  'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
};

export function cssEasing(
  name: string | undefined,
  fallback: CssEasing = 'ease',
): EaseFn {
  return CSS_EASINGS[(name as CssEasing) ?? fallback] ?? CSS_EASINGS[fallback];
}
