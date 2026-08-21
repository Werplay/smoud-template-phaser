import { GAME_DATA } from '../game-data';
import type { GameDoc } from './types';

/**
 * The document the scene builds from. An exported playable never changes it —
 * GAME_DATA is baked in at export. The editor's preview build swaps it on every
 * edit through the editor bridge, so the scene has one place to read from
 * rather than two code paths for "exported" and "previewing".
 */
let current: GameDoc = GAME_DATA;

export function getDoc(): GameDoc {
  return current;
}

export function setDoc(doc: GameDoc): void {
  current = doc;
}
