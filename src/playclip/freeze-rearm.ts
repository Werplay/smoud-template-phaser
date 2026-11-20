// A freeze holds playback until a button on screen is tapped. A tap that
// landed on that button before the freeze was reached (it was already
// showing) used it up, and nothing else could release the freeze: when a
// freeze starts, every overlay whose window covers it is armed again. The
// DOM player does the same (its freeze seek clears the tapped set).

/** Re-arm the overlays (`clicked = false`) whose time window covers `t`. */
export function rearmAtFreeze<T extends { clicked: boolean }>(
  overlays: readonly T[],
  t: number,
  windowOf: (o: T) => { start: number; end: number } | null,
): void {
  for (const o of overlays) {
    if (!o.clicked) continue;
    const w = windowOf(o);
    if (w && t >= w.start - 0.001 && t <= w.end + 0.001) o.clicked = false;
  }
}
