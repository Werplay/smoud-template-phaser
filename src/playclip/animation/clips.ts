// Clips (PlayClip Phase 1): a playable can hold several videos. Each clip has
// its own timeline; assets and timeline controls belong to one clip
// (`clipId`, absent = the first clip, so single-video projects are unchanged).
// A `goTo` action switches clips; when a clip plays to its end, its `onEnd`
// says what comes next. Shared by the editor, Preview and the Phaser export.

/** What happens when a clip plays to its end. */
export type ClipEnd =
  /** The ad ends there: end card and post-roll, as with a single video. */
  | { kind: 'end' }
  /** Carry on with the clip after it in the list. */
  | { kind: 'next' }
  /** Carry on with another clip, from its start. */
  | { kind: 'goTo'; clipId: string };

export interface ClipLike {
  id: string;
  /** Seconds. */
  duration: number;
  onEnd?: ClipEnd;
}

export interface ClipScoped {
  clipId?: string;
}

/** The clip an asset or control belongs to (unknown or absent = the first). */
export function clipIdOf(x: ClipScoped, clips: readonly ClipLike[]): string {
  const first = clips[0]?.id ?? '';
  return x.clipId && clips.some((c) => c.id === x.clipId) ? x.clipId : first;
}

/** The items that belong to `clipId`. */
export const inClip = <T extends ClipScoped>(
  items: readonly T[],
  clipId: string,
  clips: readonly ClipLike[],
): T[] => items.filter((x) => clipIdOf(x, clips) === clipId);

/**
 * Where playback goes when `clipId` ends: another clip (from its start), or
 * null when the ad ends. A broken target ends the ad rather than looping.
 */
export function nextClipAfter(
  clipId: string,
  clips: readonly ClipLike[],
): string | null {
  const i = clips.findIndex((c) => c.id === clipId);
  if (i < 0) return null;
  const end = clips[i].onEnd ?? { kind: 'end' };
  if (end.kind === 'next') return clips[i + 1]?.id ?? null;
  if (end.kind === 'goTo')
    return end.clipId !== clipId && clips.some((c) => c.id === end.clipId)
      ? end.clipId
      : null;
  return null;
}
