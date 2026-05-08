import * as Phaser from 'phaser';
import { MainScene } from './scenes/MainScene';

export class Game extends Phaser.Game {
  constructor(width: number, height: number) {
    super({
      type: Phaser.AUTO,
      width,
      height,
      backgroundColor: '#1c1c1c',
      parent: document.body,
      scale: {
        mode: Phaser.Scale.NONE, // We'll handle scaling manually
        autoCenter: Phaser.Scale.CENTER_BOTH
      },
      scene: MainScene
    });
  }

  public resize(width: number, height: number): void {
    this.scale.resize(width, height);
  }

  public pause(): void {
    this.scene.pause('MainScene');
    console.log('Game paused');
  }

  public resume(): void {
    this.scene.resume('MainScene');
    console.log('Game resumed');
  }

  public volume(value: number): void {
    this.sound.setVolume(value);
    console.log(`Volume changed to: ${value}`);
  }

  public finish(): void {
    console.log('Game finished');
  }
}
