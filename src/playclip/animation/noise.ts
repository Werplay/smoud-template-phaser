// Seeded, deterministic noise for procedural loops, after EffectCraft's
// expression noise (crates/expr/src/noise.rs, MIT OR Apache-2.0): 1D value
// noise over an integer lattice with a quintic fade, summed in octaves. The
// same seed and time give the same value in every renderer and on every run.

/** 32-bit integer hash (lowbias32-style avalanche). */
function hash32(n: number): number {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Stable numeric seed for a string (e.g. an asset id). */
export function seedOf(text: string | number | undefined): number {
  if (typeof text === 'number') return hash32(text);
  let h = 0x811c9dc5;
  for (const ch of text ?? '') {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

/** Lattice value in [-1, 1]. */
function lattice(i: number, seed: number): number {
  return (hash32(i ^ seed) / 0xffffffff) * 2 - 1;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = lattice(i, seed);
  const b = lattice(i + 1, seed);
  return a + (b - a) * fade(f);
}

/**
 * After Effects-style wiggle: `octaves` layers of noise, each at double the
 * frequency and `ampMult` times the amplitude of the last. Bounded by
 * amp * (1 + ampMult + ampMult² + …).
 */
export function wiggle(
  t: number,
  freq: number,
  amp: number,
  seed: number,
  octaves = 1,
  ampMult = 0.5,
): number {
  let sum = 0;
  let a = amp;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += a * noise1(t * f, seed + o * 0x9e3779b9);
    a *= ampMult;
    f *= 2;
  }
  return sum;
}
