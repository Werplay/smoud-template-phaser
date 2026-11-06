// Layer styles (drop shadow, outer glow, outline, gradient), after EffectCraft's
// layer styles (crates/project/src/styles.rs, MIT OR Apache-2.0). Pure helpers
// shared by the editor, the preview player and the Phaser export (this folder
// is copied into the template), so every renderer derives the same numbers.
//
// Distances are design px (editor video px); renderers pass a scale `k` to
// convert to screen px.

export interface ShadowStyle {
  color?: string;
  /** 0..1 */
  opacity?: number;
  /** Direction the shadow falls, degrees clockwise from up (135 = down-right). */
  angle?: number;
  distance?: number;
  blur?: number;
}

export interface GlowStyle {
  color?: string;
  opacity?: number;
  size?: number;
}

export interface StrokeStyle {
  color?: string;
  width?: number;
}

export interface GradientStyle {
  from?: string;
  to?: string;
  /** CSS linear-gradient angle: 0 = bottom→top, 90 = left→right. */
  angle?: number;
}

export interface LayerStyles {
  shadow?: ShadowStyle;
  outerGlow?: GlowStyle;
  stroke?: StrokeStyle;
  gradient?: GradientStyle;
}

export const SHADOW_DEFAULTS: Required<ShadowStyle> = {
  color: '#000000',
  opacity: 0.5,
  angle: 135,
  distance: 6,
  blur: 8,
};
export const GLOW_DEFAULTS: Required<GlowStyle> = {
  color: '#ffd166',
  opacity: 0.8,
  size: 12,
};
export const STROKE_DEFAULTS: Required<StrokeStyle> = {
  color: '#000000',
  width: 2,
};
export const GRADIENT_DEFAULTS: Required<GradientStyle> = {
  from: '#ff7a18',
  to: '#af002d',
  angle: 90,
};

export const shadowOf = (s: ShadowStyle): Required<ShadowStyle> => ({
  ...SHADOW_DEFAULTS,
  ...s,
});
export const glowOf = (s: GlowStyle): Required<GlowStyle> => ({
  ...GLOW_DEFAULTS,
  ...s,
});
export const strokeOf = (s: StrokeStyle): Required<StrokeStyle> => ({
  ...STROKE_DEFAULTS,
  ...s,
});
export const gradientOf = (s: GradientStyle): Required<GradientStyle> => ({
  ...GRADIENT_DEFAULTS,
  ...s,
});

/** Shadow offset from direction + distance (EffectCraft: (sin·d, −cos·d)). */
export function shadowOffset(
  angle: number,
  distance: number,
): { x: number; y: number } {
  const a = (angle * Math.PI) / 180;
  const round = (n: number) => Math.round(n * 1000) / 1000 || 0;
  return {
    x: round(Math.sin(a) * distance),
    y: round(-Math.cos(a) * distance),
  };
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba(); null if unknown. */
export function parseColor(input: string | undefined): Rgba | null {
  if (!input) return null;
  const c = input.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4)
      h = h
        .split('')
        .map((x) => x + x)
        .join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  return null;
}

/** CSS color string for `color` at `opacity` (multiplied into its own alpha). */
export function rgba(color: string | undefined, opacity = 1): string {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const a = Math.round(Math.max(0, Math.min(1, c.a * opacity)) * 1000) / 1000;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** 0xRRGGBB for Phaser. */
export function colorInt(color: string | undefined): number {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  return (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b);
}

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

/** `box-shadow` layers (buttons): drop shadow and outer glow. */
export function cssBoxShadows(s: LayerStyles, k = 1): string[] {
  const out: string[] = [];
  if (s.outerGlow) {
    const g = glowOf(s.outerGlow);
    out.push(`0 0 ${px(g.size * k)} ${rgba(g.color, g.opacity)}`);
  }
  if (s.shadow) {
    const d = shadowOf(s.shadow);
    const o = shadowOffset(d.angle, d.distance * k);
    out.push(
      `${px(o.x)} ${px(o.y)} ${px(d.blur * k)} ${rgba(d.color, d.opacity)}`,
    );
  }
  return out;
}

/** `text-shadow` layers (text): drop shadow and outer glow, glyph-shaped. */
export const cssTextShadows = cssBoxShadows;

/** `filter` value (images): drop shadow and outer glow, alpha-shaped. */
export function cssDropShadowFilter(s: LayerStyles, k = 1): string {
  return cssBoxShadows(s, k)
    .map((layer) => `drop-shadow(${layer})`)
    .join(' ');
}

/** `-webkit-text-stroke` value; draw with paint-order: stroke fill. */
export function cssTextStroke(s: LayerStyles, k = 1): string | undefined {
  if (!s.stroke) return undefined;
  const st = strokeOf(s.stroke);
  return `${px(st.width * k)} ${st.color}`;
}

export function cssLinearGradient(g: GradientStyle): string {
  const v = gradientOf(g);
  return `linear-gradient(${v.angle}deg, ${v.from}, ${v.to})`;
}

/**
 * The CSS gradient line for a w×h box, as canvas-style endpoints: it passes
 * through the centre in the gradient direction and its length makes the
 * corners land exactly on 0 and 1 (the CSS spec rule).
 */
export function gradientLine(
  angle: number,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return {
    x0: w / 2 - dx * half,
    y0: h / 2 - dy * half,
    x1: w / 2 + dx * half,
    y1: h / 2 + dy * half,
  };
}

/**
 * Canvas shadowBlur for a CSS `filter: drop-shadow()` blur value. Measured in
 * Chromium: drop-shadow's blur is a Gaussian standard deviation, while canvas
 * shadowBlur (like box-shadow / text-shadow blur) is twice the deviation. Image
 * shadows and glows (drop-shadow in the editor) use this; text and buttons use
 * the value as-is.
 */
export const DROP_SHADOW_BLUR_SCALE = 2;

/**
 * Extra space a style needs around a w×h box so shadows/glows aren't clipped.
 * `blurScale` widens blurs for drop-shadow semantics (see above).
 */
export function stylePadding(s: LayerStyles, k = 1, blurScale = 1): number {
  let pad = 0;
  if (s.outerGlow)
    pad = Math.max(pad, glowOf(s.outerGlow).size * blurScale * k * 1.5);
  if (s.shadow) {
    const d = shadowOf(s.shadow);
    pad = Math.max(pad, (d.distance + d.blur * blurScale * 1.5) * k);
  }
  return Math.ceil(pad);
}

/**
 * Gradient text with an outline/shadow, matching canvas order (stroke and
 * shadow under the fill): the element repeats its text in a ::before layer
 * (from data-text) carrying --pc-stroke / --pc-shadow, and the gradient
 * letters sit in a .pc-gradient-fill span above it. CSS can't do this with
 * one element: text-shadow and -webkit-text-stroke would paint over a
 * background-clip:text gradient. The editor mirrors this rule in globals.css.
 */
export const GRADIENT_TEXT_CSS = `
.pc-gradient-text { isolation: isolate; }
.pc-gradient-text::before {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  z-index: -1;
  box-sizing: border-box;
  padding: inherit;
  color: transparent;
  -webkit-text-stroke: var(--pc-stroke, 0 transparent);
  text-shadow: var(--pc-shadow, none);
  pointer-events: none;
}
.pc-gradient-fill {
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}`;
