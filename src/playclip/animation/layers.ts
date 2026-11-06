// Layering and transform composition shared by the renderers.

/**
 * Default layer per asset type. An asset's explicit `zIndex` replaces it, so
 * an image can be put above a button. The order matches the editor's original
 * fixed stacking: end card at the back, hotspots on top.
 */
export const DEFAULT_LAYER: Record<string, number> = {
  endcard: 5,
  text: 10,
  image: 20,
  button: 30,
  'transparent-button': 40,
};

export function layerOf(asset: { type: string; zIndex?: number }): number {
  if (asset.type === 'endcard') return DEFAULT_LAYER.endcard;
  return asset.zIndex ?? DEFAULT_LAYER[asset.type] ?? 10;
}

export interface TransformParts {
  /** Animation offset in px (already scaled to screen). */
  x: number;
  y: number;
  /** Static rotation + animated rotation, degrees. */
  rotation: number;
  /** Animated scale multiplier. */
  scale: number;
  flipX: boolean;
  flipY: boolean;
  /** Anchor (pivot) as a percentage of the asset box, 50/50 = centre. */
  anchorX?: number;
  anchorY?: number;
}

/**
 * CSS transform for an asset whose left/top is its centre. Rotation and scale
 * pivot on the anchor; flip stays centred so mirroring never moves the box.
 */
export function cssTransform(p: TransformParts): string {
  const dx = (p.anchorX ?? 50) - 50;
  const dy = (p.anchorY ?? 50) - 50;
  const parts = [];
  if (p.x || p.y) parts.push(`translate(${p.x}px, ${p.y}px)`);
  parts.push('translate(-50%, -50%)');
  const pivot = dx !== 0 || dy !== 0;
  if (pivot) parts.push(`translate(${dx}%, ${dy}%)`);
  if (p.rotation) parts.push(`rotate(${p.rotation}deg)`);
  if (p.scale !== 1) parts.push(`scale(${p.scale})`);
  if (pivot) parts.push(`translate(${-dx}%, ${-dy}%)`);
  if (p.flipX || p.flipY)
    parts.push(`scale(${p.flipX ? -1 : 1}, ${p.flipY ? -1 : 1})`);
  return parts.join(' ');
}
