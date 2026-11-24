// Localization (PlayClip Phase 2): text and button assets can carry their
// text in other languages (`texts`, by language code), images their picture
// (`images`) and texts their font (`fontsByLang`). One project exports
// every language: fixed at export (the texts are resolved before the build),
// or picked by the device at runtime (the Phaser export). The asset's own
// `content` is the base language and the fallback.

export interface Localizable {
  content?: string;
  texts?: Record<string, string>;
  imageUrl?: string;
  images?: Record<string, string>;
  fontsByLang?: Record<string, string>;
  style?: unknown;
}

const norm = (code: string) => code.trim().toLowerCase().replace('_', '-');

/**
 * The best of `available` for the viewer's `wanted` languages (most
 * preferred first): an exact match ("pt-br"), else the same language
 * ("pt-br" → "pt", "pt" → "pt-br"); null = none, use the base.
 */
export function pickLanguage(available: readonly string[], wanted: readonly string[]): string | null {
  const have = available.map(norm);
  for (const w of wanted.map(norm)) {
    const exact = have.indexOf(w);
    if (exact >= 0) return available[exact];
    const base = w.split('-')[0];
    const near = have.findIndex((h) => h === base || h.split('-')[0] === base);
    if (near >= 0) return available[near];
  }
  return null;
}

/** The asset's text in `lang` (an empty translation falls back to the base). */
export const textIn = (x: Localizable, lang: string | null): string =>
  (lang && x.texts?.[lang]?.trim() ? x.texts[lang] : x.content) ?? '';

/** The languages used anywhere in `items` (texts, images, fonts), in first-seen order. */
export function languagesOf(items: readonly Localizable[]): string[] {
  const out: string[] = [];
  for (const x of items)
    for (const k of [...Object.keys(x.texts ?? {}), ...Object.keys(x.images ?? {}), ...Object.keys(x.fontsByLang ?? {})])
      if (!out.includes(k)) out.push(k);
  return out;
}

const filled = (map: Record<string, string> | undefined, lang: string | null) =>
  lang && map?.[lang]?.trim() ? map[lang] : null;

/** `style` (flat or per orientation) with its fontFamily set to `font`. */
function withFont(style: unknown, font: string): unknown {
  if (!style || typeof style !== 'object') return { fontFamily: font };
  const s = style as Record<string, unknown>;
  if ('landscape' in s && 'portrait' in s)
    return {
      ...s,
      landscape: { ...(s.landscape as object), fontFamily: font },
      portrait: { ...(s.portrait as object), fontFamily: font },
    };
  return { ...s, fontFamily: font };
}

/**
 * `items` showing `lang` (null = the base), without translations left in:
 * its text, its image and its font in `lang` where set (an empty one falls
 * back to the base).
 */
export function localize<T extends Localizable>(items: readonly T[], lang: string | null): T[] {
  return items.map((x) => {
    if (!x.texts && !x.images && !x.fontsByLang) return x;
    const { texts: _t, images: _i, fontsByLang: _f, ...rest } = x;
    void _t;
    void _i;
    void _f;
    const out: Record<string, unknown> = { ...rest };
    if (x.texts) out.content = textIn(x, lang);
    const image = filled(x.images, lang);
    if (image) out.imageUrl = image;
    const font = filled(x.fontsByLang, lang);
    if (font) out.style = withFont(x.style, font);
    return out as T;
  });
}
