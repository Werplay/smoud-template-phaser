import type * as Phaser from 'phaser';
import { setDoc } from './doc-source';
import type { GameDoc } from './types';

export const EDITOR_MESSAGE = {
  doc: 'game-editor:doc',
  ready: 'game-editor:ready',
  error: 'game-editor:error'
} as const;

/**
 * Preview-only wiring: the editor posts a document in, the scene restarts on
 * it, and anything that throws goes back to the editor rather than dying in a
 * console the author never opens.
 *
 * This is bundled ONLY into the preview build — nothing in the normal entry
 * imports it, so an exported playable carries no message listener and cannot
 * have its content swapped by whatever page embeds it.
 */
export function installEditorBridge(game: Phaser.Game): void {
  const report = (message: string) => {
    window.parent?.postMessage({ type: EDITOR_MESSAGE.error, message }, '*');
  };

  window.addEventListener('error', (event) => report(event.message));
  window.addEventListener('unhandledrejection', (event) => report(String(event.reason)));

  window.addEventListener('message', (event: MessageEvent) => {
    const payload = event.data as { type?: string; doc?: GameDoc } | null;
    if (!payload || payload.type !== EDITOR_MESSAGE.doc || !payload.doc) return;

    try {
      setDoc(payload.doc);
      // Restarting re-runs init/preload/create, so new assets load and every
      // piece of runtime state (counters, tweens, spawned nodes) is discarded.
      game.scene.getScene('GameScene')?.scene.restart();
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  });

  window.parent?.postMessage({ type: EDITOR_MESSAGE.ready }, '*');
}
