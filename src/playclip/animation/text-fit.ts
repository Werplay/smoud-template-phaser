// Shrink-to-fit text: a text or button label keeps its designed font size
// unless it overflows its box; then (after wrapping, for texts) it shrinks
// until it fits, down to TEXT_FIT's minimum. One pure function shared by the
// editor canvas, the preview player and the Phaser export (this folder is
// copied into the template), so all three pick the same size. Everything is
// in design px (editor video px); renderers scale the result as they scale
// the designed size. Each renderer still wraps the text itself; this only
// decides the size, so its line model is deliberately simple.

/** Width in px of `text` drawn in `font` (a CSS font shorthand). */
export type MeasureText = (text: string, font: string) => number;

export const TEXT_FIT = {
  /** Never below this share of the designed size... */
  minRatio: 0.6,
  /** ...nor below this many px (unless designed smaller: then it never shrinks). */
  minPx: 10,
  /** Line height as a multiple of the font size, for the height check. */
  lineHeight: 1.2,
  /** Search precision in px. */
  stepPx: 0.25,
};

/** The style fields the fit reads (an AssetStyle has them all). */
export interface FitStyle {
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  padding?: string;
  width?: string | number;
  height?: string | number;
}

export interface FitResult {
  /** The size to draw at (design px): the designed one when it fits. */
  px: number;
  /** True when the text still overflows at the minimum size. */
  atMin: boolean;
}

/** Default padding per kind, as the editor draws it when none is set. */
const DEFAULT_PADDING = { text: '8px 12px', button: '12px 24px' } as const;

/** A box side in px: a number or a px length; anything else (%, auto, none) = no box. */
function boxPx(v: string | number | undefined): number | null {
  if (typeof v === 'number') return v > 0 ? v : null;
  const m = /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(v ?? '');
  return m && +m[1] > 0 ? +m[1] : null;
}

/** CSS padding shorthand (px numbers) as horizontal and vertical padding per side. */
export function paddingOf(padding: string): { x: number; y: number } {
  const n = (padding.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const [top = 0, right = top, bottom = top, left = right] = n;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/** The CSS font shorthand a style draws at `px`. */
export function cssFont(style: FitStyle, px: number): string {
  const italic = style.fontStyle === 'italic' ? 'italic ' : '';
  const weight = style.fontWeight && style.fontWeight !== 'normal' ? `${style.fontWeight} ` : '';
  return `${italic}${weight}${px}px ${style.fontFamily || 'Arial, sans-serif'}`;
}

/**
 * The text the fit measures: `{name}` counters as two digits, so the size
 * doesn't change while a counter rolls.
 */
export const fitText = (content: string) => content.replace(/\{[A-Za-z_][\w-]*\}/g, '00');

/**
 * Lines of one paragraph wrapped at `maxW`, and whether a word is wider
 * than `maxW`. Phaser's rule (Text.advancedWordWrap), the stricter of the
 * renderers: a paragraph narrower than `maxW` stays one line; otherwise each
 * word counts with its trailing space. CSS wraps into as few lines or fewer,
 * so a size that fits here fits every renderer.
 */
function wrap(paragraph: string, maxW: number, width: (s: string) => number) {
  const line = paragraph.replace(/ +/g, ' ').trim();
  if (!line || width(line) < maxW) return { lines: 1, tooWide: false };
  let lines = 1;
  let used = 0;
  let tooWide = false;
  for (const w of line.split(' ')) {
    const ww = width(`${w} `);
    if (ww > maxW) tooWide = true;
    if (used && used + ww > maxW) {
      lines++;
      used = ww;
    } else used += ww;
  }
  return { lines, tooWide };
}

/**
 * The font size (design px) for `text` designed at `designPx` in `style`'s
 * box. Texts wrap at the box width and must fit its height; button labels
 * stay on one line and must fit its width. Without a px box (width and
 * height), or when it fits, the designed size is kept exactly.
 */
export function fitFontPx(
  text: string,
  designPx: number,
  style: FitStyle,
  kind: 'text' | 'button',
  measure: MeasureText,
): FitResult {
  const keep = { px: designPx, atMin: false };
  const w = boxPx(style.width);
  const h = boxPx(style.height);
  if (!w || !h || !(designPx > 0) || !text.trim()) return keep;
  const pad = paddingOf(style.padding ?? DEFAULT_PADDING[kind]);
  const availW = Math.max(1, w - pad.x * 2);
  const availH = Math.max(1, h - pad.y * 2);
  const paragraphs = text.split('\n');

  const fits = (px: number) => {
    const width = (s: string) => measure(s, cssFont(style, px));
    if (kind === 'button') return paragraphs.every((p) => width(p.trim()) <= availW);
    let lines = 0;
    for (const p of paragraphs) {
      const r = wrap(p, availW, width);
      if (r.tooWide) return false;
      lines += r.lines;
    }
    // One line never shrinks for height alone: tight single-line boxes are
    // common in existing projects and draw fine.
    return lines <= 1 || lines * px * TEXT_FIT.lineHeight <= availH;
  };

  if (fits(designPx)) return keep;
  const min = Math.min(designPx, Math.max(TEXT_FIT.minPx, designPx * TEXT_FIT.minRatio));
  if (!fits(min)) return { px: min, atMin: true };
  // The largest size that fits, to TEXT_FIT.stepPx.
  let lo = min;
  let hi = designPx;
  while (hi - lo > TEXT_FIT.stepPx) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { px: Math.max(min, Math.floor(lo / TEXT_FIT.stepPx) * TEXT_FIT.stepPx), atMin: false };
}

/**
 * A canvas measurer for the browser renderers (editor, preview, Phaser):
 * the same Canvas 2D text metrics in all three. Null without a DOM.
 */
export function canvasMeasure(): MeasureText | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/**
 * A rough measurer for the server (no canvas): average advance widths of a
 * sans-serif per character class. ponytail: approximate (within ~15 % for
 * Arial-like fonts, worse for condensed or display fonts); the export check
 * that uses it only warns. Upgrade path: measure the uploaded font's hmtx.
 */
export const approxMeasure: MeasureText = (text, font) => {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  const bold = /\b(bold|[6-9]00)\b/.test(font) ? 1.07 : 1;
  let em = 0;
  for (const ch of text)
    em += /\s/.test(ch)
      ? 0.28
      : /[A-Z]/.test(ch)
        ? /[MW]/.test(ch) ? 0.85 : /[IJ]/.test(ch) ? 0.3 : 0.68
        : /[a-z]/.test(ch)
          ? /[mw]/.test(ch) ? 0.8 : /[ijlft]/.test(ch) ? 0.3 : 0.53
          : /[0-9]/.test(ch)
            ? 0.56
            : 0.4;
  return em * px * bold;
};
