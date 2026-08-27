import * as Phaser from 'phaser';
import { GAME_DATA } from './game-data';
import { GameScene } from './game/GameScene';
import { SPINE_PLUGIN } from './game/spine-plugin';

export class Game extends Phaser.Game {
  constructor(width: number, height: number) {
    super({
      type: Phaser.AUTO,
      width,
      height,
      backgroundColor: GAME_DATA.settings.backgroundColor,
      parent: document.body,
      scale: {
        // The SDK owns sizing; the scene lays itself out from the resize event.
        mode: Phaser.Scale.NONE,
        autoCenter: Phaser.Scale.CENTER_BOTH
      },
      physics: {
        // Arcade only: axis-aligned bodies, no joints. Every genre the editor
        // targets is catch, dodge, drag or scroll, and Matter would cost bytes
        // in a budget that starts ~1.2MB down.
        default: 'arcade',
        arcade: {
          // Per-scene values come from the document; these are the floor.
          gravity: { x: 0, y: 0 },
          debug: false
        }
      },
      scene: GameScene,
      // Registered only when the build carries it, which is per project.
      ...(SPINE_PLUGIN
        ? {
            plugins: {
              scene: [
                {
                  key: 'spine.SpinePlugin',
                  plugin: SPINE_PLUGIN,
                  mapping: 'spine'
                }
              ]
            }
          }
        : {})
    });
  }

  public resize(width: number, height: number): void {
    this.scale.resize(width, height);
  }

  public pause(): void {
    this.scene.pause('GameScene');
  }

  public resume(): void {
    this.scene.resume('GameScene');
  }

  public volume(value: number): void {
    this.sound.setVolume(value);
  }

  public finish(): void {
    // The SDK has taken over; nothing further to tear down here.
  }
}
