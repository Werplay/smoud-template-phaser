// Ping-pong loops: a loop that plays forward, then backward, then forward…
//
// Browsers and Phaser can't play video backwards, so the export bakes it: a
// reversed copy of each ping-pong loop is inserted into the video right after
// the loop (phaser-build/pingpong-video.ts). Every asset and control keeps its
// time in the original video's timeline ("source time"); the player maps the
// baked video's clock to source time and back with the functions below. The
// editor and Preview, which play the original video, step backwards instead.

export type LoopMode = 'forward' | 'pingpong';

export interface LoopLike {
  startTime: number;
  endTime: number;
  mode?: LoopMode;
}

/** A baked segment: the loop [startTime, endTime] reversed, in source time. */
export interface ReversedSegment {
  startTime: number;
  endTime: number;
}

export const isPingPong = (l: LoopLike | null | undefined) =>
  l?.mode === 'pingpong';

/** The ping-pong loops to bake: sorted, non-overlapping, non-empty. */
export function pingPongSegments(loops: LoopLike[]): ReversedSegment[] {
  const out: ReversedSegment[] = [];
  for (const l of [...loops]
    .filter((l) => isPingPong(l) && l.endTime > l.startTime)
    .sort((a, b) => a.startTime - b.startTime)) {
    const last = out[out.length - 1];
    if (last && l.startTime < last.endTime) continue; // overlapping: keep the first
    out.push({ startTime: l.startTime, endTime: l.endTime });
  }
  return out;
}

export interface SourceTime {
  /** Time in the original video. */
  time: number;
  /** Inside a reversed segment (source time running backwards). */
  reversing: boolean;
  /** Index of that segment, or -1. */
  segment: number;
}

/** Baked video time → source time. */
export function toSourceTime(
  videoTime: number,
  segs: ReversedSegment[],
): SourceTime {
  let offset = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const len = s.endTime - s.startTime;
    const reverseStart = s.endTime + offset;
    if (videoTime <= reverseStart)
      return { time: videoTime - offset, reversing: false, segment: -1 };
    if (videoTime < reverseStart + len)
      return {
        time: s.endTime - (videoTime - reverseStart),
        reversing: true,
        segment: i,
      };
    offset += len;
  }
  return { time: videoTime - offset, reversing: false, segment: -1 };
}

/**
 * Source time → baked video time, on the forward pass (or, with
 * `reversingIn`, inside that segment's reversed copy).
 */
export function toVideoTime(
  sourceTime: number,
  segs: ReversedSegment[],
  reversingIn = -1,
): number {
  let offset = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const len = s.endTime - s.startTime;
    if (i === reversingIn) return s.endTime + offset + (s.endTime - sourceTime);
    if (sourceTime <= s.endTime) return sourceTime + offset;
    offset += len;
  }
  return sourceTime + offset;
}

/** The video time where segment `i`'s reversed copy ends. */
export function reverseEndVideoTime(segs: ReversedSegment[], i: number) {
  let offset = 0;
  for (let k = 0; k <= i; k++) offset += segs[k].endTime - segs[k].startTime;
  return segs[i].endTime + offset;
}

/** Source duration of a baked video. */
export const sourceDuration = (
  videoDuration: number,
  segs: ReversedSegment[],
) => videoDuration - segs.reduce((n, s) => n + (s.endTime - s.startTime), 0);
