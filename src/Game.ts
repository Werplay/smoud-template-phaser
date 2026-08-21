import * as Phaser from 'phaser';
import { GAME_DATA } from './game-data';
import { GameScene } from './game/GameScene';

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
      scene: GameScene
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
