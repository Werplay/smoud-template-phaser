// Effect presets (PlayClip Phase 1): one-shot screen effects fired by an
// `effect` action. The timings and the confetti simulation are shared; each
// renderer draws them its own way (playclip-runtime/effects-dom.ts for the
// editor and Preview, PlayclipScene for the Phaser export).

export type EffectPreset = 'confetti' | 'shake' | 'flash';

export const EFFECT_PRESETS: { preset: EffectPreset; label: string }[] = [
  { preset: 'confetti', label: 'Confetti burst' },
  { preset: 'shake', label: 'Screen shake' },
  { preset: 'flash', label: 'Flash' },
];

export const FLASH = { ms: 350, opacity: 0.85, color: '#ffffff' };
/** Shake: `px` is a share of the stage's shorter side, so it scales. */
export const SHAKE = { ms: 450, amount: 0.02 };
export const CONFETTI = {
  ms: 1800,
  count: 90,
  colors: ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#facc15'],
};

export interface ConfettiPiece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  size: number;
  color: string;
}

/**
 * A burst from the bottom centre of a `w`×`h` stage, thrown up and outwards.
 * Speeds scale with the stage so it looks the same at any size.
 */
export function spawnConfetti(
  w: number,
  h: number,
  rand: () => number = Math.random,
): ConfettiPiece[] {
  const s = Math.min(w, h);
  return Array.from({ length: CONFETTI.count }, () => {
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.6;
    const speed = s * (1.2 + rand() * 1.1);
    return {
      x: w / 2 + (rand() - 0.5) * s * 0.2,
      y: h * 0.95,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      angle: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 12,
      size: s * (0.015 + rand() * 0.015),
      color: CONFETTI.colors[Math.floor(rand() * CONFETTI.colors.length)],
    };
  });
}

/** Advance the pieces by `dt` seconds (gravity and air drag). */
export function stepConfetti(pieces: ConfettiPiece[], dt: number, h: number): void {
  const g = h * 1.6;
  const drag = Math.pow(0.35, dt);
  for (const p of pieces) {
    p.vx *= drag;
    p.vy = p.vy * drag + g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.angle += p.spin * dt;
  }
}

/** Opacity of the burst `t` ms in (fades over its last third). */
export const confettiAlpha = (t: number) =>
  Math.max(0, Math.min(1, (CONFETTI.ms - t) / (CONFETTI.ms / 3)));

/** Shake offset (as a share of the stage's shorter side) `t` ms in. */
export function shakeOffset(t: number): { x: number; y: number } {
  if (t >= SHAKE.ms) return { x: 0, y: 0 };
  const k = SHAKE.amount * (1 - t / SHAKE.ms);
  return { x: Math.sin(t / 18) * k, y: Math.cos(t / 23) * k * 0.6 };
}
