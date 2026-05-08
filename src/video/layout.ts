import { FitMode } from './types';

export interface VideoLayoutResult {
  width: number;
  height: number;
}

export function calculateVideoLayout(
  viewportWidth: number,
  viewportHeight: number,
  fitMode: FitMode,
  videoAspectRatio: number
): VideoLayoutResult {
  const screenRatio = viewportWidth / viewportHeight;
  const ar = fitMode === 'contain' ? 16 / 9 : videoAspectRatio || 16 / 9;

  if (fitMode === 'contain') {
    if (screenRatio > ar) {
      return { width: viewportHeight * ar, height: viewportHeight };
    }
    return { width: viewportWidth, height: viewportWidth / ar };
  }

  if (screenRatio > ar) {
    return { width: viewportWidth, height: viewportWidth / ar };
  }
  return { width: viewportHeight * ar, height: viewportHeight };
}
