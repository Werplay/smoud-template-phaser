/**
 * Layout maths, kept free of Phaser so it can be reasoned about (and tested)
 * on its own. The document is authored against a fixed design canvas; every
 * device is that canvas at a different size, so a root node's placement is
 * (anchor point in the real viewport) + (its authored offset, scaled).
 */

import type { Anchor, Fit, Orientation, Transform, TransformOverrides } from './types';

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export function orientationOf(view: Size): Orientation {
  return view.height >= view.width ? 'portrait' : 'landscape';
}

/**
 * Per-axis scale from the design canvas to the real one.
 * `fit` uses the smaller ratio so nothing is cropped; `fill` the larger so
 * nothing is letterboxed; `stretch` follows each axis independently.
 */
export function layoutScale(fit: Fit, design: Size, view: Size): { sx: number; sy: number } {
  if (fit === 'none' || !design.width || !design.height) return { sx: 1, sy: 1 };

  const rx = view.width / design.width;
  const ry = view.height / design.height;

  if (fit === 'stretch') return { sx: rx, sy: ry };

  const s = fit === 'fill' ? Math.max(rx, ry) : Math.min(rx, ry);
  return { sx: s, sy: s };
}

/** The point in the real viewport a node's offset is measured from. */
export function anchorPoint(anchor: Anchor, view: Size): { x: number; y: number } {
  const [vertical, horizontal] = anchor.split('-') as [string, string];

  const x = horizontal === 'left' ? 0 : horizontal === 'right' ? view.width : view.width / 2;
  const y = vertical === 'top' ? 0 : vertical === 'bottom' ? view.height : view.height / 2;

  return { x, y };
}

/**
 * The base transform with its orientation patch applied. Patches are sparse:
 * an unset key inherits, so editing the base still moves both orientations.
 */
export function resolveTransform(
  base: Transform,
  overrides: TransformOverrides | undefined,
  orientation: Orientation
): Transform {
  const patch = overrides && overrides[orientation];
  return patch ? { ...base, ...patch } : base;
}

/**
 * Where a ROOT node lands. Children are not placed this way: they sit in their
 * parent's local design space and inherit its scale, so only the roots are
 * anchored to the viewport.
 */
export function rootPlacement(transform: Transform, design: Size, view: Size): Placement {
  const { sx, sy } = layoutScale(transform.fit, design, view);
  const origin = anchorPoint(transform.anchor, view);

  return {
    x: origin.x + transform.x * sx,
    y: origin.y + transform.y * sy,
    scaleX: transform.scaleX * sx,
    scaleY: transform.scaleY * sy
  };
}
