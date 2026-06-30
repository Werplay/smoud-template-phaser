/** Post-roll window after the video ends (end-card region on the timeline). */
export interface PostRollConfig {
  videoDuration: number;
  postRollStart: number;
  postRollEnd: number;
}

export function getPostRollConfig(
  endcard: { time: number; endTime?: number } | undefined,
  videoDuration: number,
): PostRollConfig | null {
  if (!endcard) return null;
  const postRollEnd = endcard.endTime ?? endcard.time + 5;
  const postRollStart = Math.max(videoDuration, endcard.time);
  if (postRollEnd <= postRollStart + 0.001) return null;
  return { videoDuration, postRollStart, postRollEnd };
}

/** Authoring/playback clock: video time while playing, synthetic time during post-roll. */
export function computePlaybackTime(
  videoTime: number,
  videoEnded: boolean,
  postRoll: PostRollConfig | null,
  postRollElapsedSec: number,
): number {
  if (!videoEnded || !postRoll) return videoTime;
  return Math.min(postRoll.postRollStart + postRollElapsedSec, postRoll.postRollEnd);
}

export function isPostRollComplete(
  playbackTime: number,
  postRoll: PostRollConfig | null,
): boolean {
  if (!postRoll) return false;
  return playbackTime >= postRoll.postRollEnd - 0.001;
}
