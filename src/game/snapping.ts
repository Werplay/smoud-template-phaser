/**
 * Alignment while dragging. Kept free of Phaser so the maths can be reasoned
 * about on its own: it takes rectangles and returns an offset plus the guides
 * that justify it.
 */

export interface Rect {
  left: number;
  right: number;
  centreX: number;
  top: number;
  bottom: number;
  centreY: number;
}

export interface Guide {
  axis: 'x' | 'y';
  /** Where to draw the line, in world coordinates. */
  at: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** How close, in pixels on screen, before an edge is considered aligned. */
export const SNAP_THRESHOLD = 6;

export function rectOf(centreX: number, centreY: number, width: number, height: number): Rect {
  const halfW = width / 2;
  const halfH = height / 2;
  return {
    left: centreX - halfW,
    right: centreX + halfW,
    centreX,
    top: centreY - halfH,
    bottom: centreY + halfH,
    centreY
  };
}

/**
 * The nearest alignment for a moving rectangle against a set of fixed ones.
 * Each axis is decided independently — a node can be centred horizontally on
 * one neighbour while its top edge meets another.
 */
export function snap(moving: Rect, others: Rect[], threshold = SNAP_THRESHOLD): SnapResult {
  const guides: Guide[] = [];

  const best = (candidates: number[], targets: number[]): { delta: number; at: number } | undefined => {
    let winner: { delta: number; at: number } | undefined;

    for (const candidate of candidates) {
      for (const target of targets) {
        const delta = target - candidate;
        if (Math.abs(delta) > threshold) continue;
        // Ties go to the first candidate, which is the leading edge — so a node
        // nudged between two equally close targets does not flicker.
        if (!winner || Math.abs(delta) < Math.abs(winner.delta)) {
          winner = { delta, at: target };
        }
      }
    }

    return winner;
  };

  const x = best(
    [moving.centreX, moving.left, moving.right],
    others.flatMap((rect) => [rect.centreX, rect.left, rect.right])
  );
  const y = best(
    [moving.centreY, moving.top, moving.bottom],
    others.flatMap((rect) => [rect.centreY, rect.top, rect.bottom])
  );

  if (x) guides.push({ axis: 'x', at: x.at });
  if (y) guides.push({ axis: 'y', at: y.at });

  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides };
}
