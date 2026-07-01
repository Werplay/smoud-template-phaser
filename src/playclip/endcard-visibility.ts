import type { PlayclipAsset } from './types';

/** Matches the editor's isEndcardVisibleDuringPlayback tolerance. */
export const ENDCARD_START_TOLERANCE = 0.15;

export function isEndcardVisible(
  asset: Pick<PlayclipAsset, 'type' | 'time' | 'endTime'>,
  time: number,
  videoEnded: boolean,
): boolean {
  if (asset.type !== 'endcard') return false;

  const start = asset.time;
  const end = asset.endTime ?? asset.time + 5;
  if (time >= start && time <= end) return true;

  // Playhead can land just before the scheduled start when the video ends.
  if (videoEnded && time <= end && time >= start - ENDCARD_START_TOLERANCE) {
    return true;
  }

  return false;
}
