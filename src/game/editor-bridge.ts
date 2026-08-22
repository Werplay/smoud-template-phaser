import type * as Phaser from 'phaser';
import { setDoc } from './doc-source';
import type { GameScene, RuntimeMode } from './GameScene';
import type { GameDoc } from './types';

export const EDITOR_MESSAGE = {
  doc: 'game-editor:doc',
  select: 'game-editor:select',
  ready: 'game-editor:ready',
  error: 'game-editor:error',
  selected: 'game-editor:selected',
  moved: 'game-editor:moved'
} as const;

interface EditorPayload {
  type?: string;
  doc?: GameDoc;
  mode?: RuntimeMode;
  /** Which scene the editor is showing; only meaningful while editing. */
  scene?: 'game' | 'endcard';
  nodeId?: string | null;
}

/**
 * Preview-only wiring: the editor posts a document in, the scene restarts on
 * it, and anything that throws goes back to the editor rather than dying in a
 * console the author never opens. Selection and drags travel the other way.
 *
 * This is bundled ONLY into the preview build — nothing in the normal entry
 * imports it, so an exported playable carries no message listener and cannot
 * have its content swapped by whatever page embeds it.
 */
export function installEditorBridge(game: Phaser.Game): void {
  const send = (message: Record<string, unknown>) => {
    window.parent?.postMessage(message, '*');
  };

  const report = (message: string) => send({ type: EDITOR_MESSAGE.error, message });

  const scene = () => game.scene.getScene('GameScene') as GameScene | null;

  // Phaser reuses the scene instance across a restart, so the hooks only have
  // to be attached once — but the game boots asynchronously, so the first
  // attempt may come before the scene exists.
  let hooked = false;
  const ensureHooks = () => {
    if (hooked) return;
    const current = scene();
    if (!current) return;
    current.setEditorHooks(send);
    hooked = true;
  };

  window.addEventListener('error', (event) => report(event.message));
  window.addEventListener('unhandledrejection', (event) => report(String(event.reason)));

  window.addEventListener('message', (event: MessageEvent) => {
    const payload = event.data as EditorPayload | null;
    if (!payload) return;
    ensureHooks();

    try {
      if (payload.type === EDITOR_MESSAGE.doc && payload.doc) {
        setDoc(payload.doc);
        // Restarting re-runs init/preload/create, so new assets load and every
        // piece of runtime state (counters, tweens, spawned nodes) is discarded.
        // The mode rides along because init reads it before create builds.
        scene()?.scene.restart({
          mode: payload.mode ?? 'edit',
          scene: payload.scene ?? 'game'
        });
        return;
      }

      if (payload.type === EDITOR_MESSAGE.select) {
        scene()?.setSelected(payload.nodeId ?? null);
      }
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  });

  ensureHooks();
  send({ type: EDITOR_MESSAGE.ready });
}
