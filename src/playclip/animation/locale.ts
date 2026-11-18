// Localization (PlayClip Phase 2): text and button assets can carry their
// text in other languages (`texts`, by language code). One project exports
// every language: fixed at export (the texts are resolved before the build),
// or picked by the device at runtime (the Phaser export). The asset's own
// `content` is the base language and the fallback.

export interface Localizable {
  content?: string;
  texts?: Record<string, string>;
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

/** The languages used anywhere in `items`, in first-seen order. */
export function languagesOf(items: readonly Localizable[]): string[] {
  const out: string[] = [];
  for (const x of items) for (const k of Object.keys(x.texts ?? {})) if (!out.includes(k)) out.push(k);
  return out;
}

/** `items` showing `lang` (null = the base), without translations left in. */
export function localize<T extends Localizable>(items: readonly T[], lang: string | null): T[] {
  return items.map((x) => {
    if (!x.texts) return x;
    const { texts: _texts, ...rest } = x;
    void _texts;
    return { ...rest, content: textIn(x, lang) } as T;
  });
}
