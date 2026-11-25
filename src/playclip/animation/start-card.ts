// Start card: what shows over the video's first frame until the first tap,
// and what that tap does. Every build already holds on the poster until a
// tap (PlayclipScene: a playable may start with sound only after a gesture),
// and the preview autoplays; with a start card both wait and show the card.
// Its assets are ordinary assets with `onStartCard` set; the value is what
// the first tap does (every card asset carries the same one):
//   'start'    the tap only starts the video (as without a card);
//   'interact' the tap also counts as the first interaction: when a freeze
//              sits in the opening START_FREEZE_SECONDS and one button
//              releases it, that freeze releases on arrival as if the button
//              had been tapped. No such freeze (or a choice of buttons) = 'start'.
// Shared by the editor, the preview player and PlayclipScene.

import { interactionsOf, movesPlayback, tapActions } from './interactions';

type Interactive = Parameters<typeof interactionsOf>[0];

export type StartCardTap = 'start' | 'interact';

/** A freeze this early counts as "at the start" for 'interact'. */
export const START_FREEZE_SECONDS = 1;

/**
 * A freeze this close to 0 is on the poster frame itself: the first tap is
 * then the tap on its button, run at once (renderers skip the freeze rather
 * than racing it to frame 0); later ones release when the video reaches them.
 */
export const FIRST_FRAME_FREEZE = 0.05;

type CardAsset = Interactive & {
  id: string;
  type: string;
  time: number;
  endTime?: number;
  onStartCard?: StartCardTap | boolean | null;
  onEndCard?: boolean;
  clipId?: string;
};

type FreezeLike = { id: string; startTime: number; clipId?: string };

/** True for an asset on the start card. */
export const onStartCard = (a: { onStartCard?: unknown }) => !!a.onStartCard;

/** What the first tap does, or null when there's no start card. */
export function startCardTap(assets: readonly CardAsset[]): StartCardTap | null {
  const card = assets.find(onStartCard);
  if (!card) return null;
  return card.onStartCard === 'interact' ? 'interact' : 'start';
}

/** What a tap on `a` does (a button without interactions plays, as in every renderer). */
const tapOf = (a: CardAsset) =>
  !interactionsOf(a).length && (a.type === 'button' || a.type === 'transparent-button')
    ? [{ kind: 'play' as const }]
    : tapActions(a);

/**
 * The opening freeze and the one asset whose tap releases it, for a first
 * tap that 'interact's; null when there's none or several could (a choice
 * is the viewer's to make). Freezes on added clips don't count.
 */
export function startTapRelease(
  assets: readonly CardAsset[],
  freezes: readonly FreezeLike[],
): { freezeId: string; assetId: string; t: number } | null {
  const first = freezes
    .filter((f) => !f.clipId && f.startTime <= START_FREEZE_SECONDS)
    .sort((a, b) => a.startTime - b.startTime)[0];
  if (!first) return null;
  const t = first.startTime;
  const targets = assets.filter((a) => {
    if (onStartCard(a) || a.onEndCard || a.type === 'endcard' || a.clipId) return false;
    if (a.type !== 'button' && a.type !== 'transparent-button' && a.type !== 'image') return false;
    const end = a.endTime || a.time + 5;
    if (t < a.time - 0.001 || t > end + 0.001) return false;
    const actions = tapOf(a);
    return movesPlayback(actions) && !actions.some((x) => x.kind === 'cta');
  });
  return targets.length === 1 ? { freezeId: first.id, assetId: targets[0].id, t } : null;
}
