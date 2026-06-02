import * as Phaser from 'phaser';
import { PlayclipScene } from './playclip/PlayclipScene';

export class Game extends Phaser.Game {
  constructor(width: number, height: number) {
    super({
      type: Phaser.AUTO,
      width,
      height,
      backgroundColor: '#000000',
      parent: document.body,
      scale: {
        mode: Phaser.Scale.NONE, // Manual scaling driven by the SDK resize event.
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: PlayclipScene,
    });
  }

  private get playclip(): PlayclipScene | undefined {
    return this.scene.getScene("PlayclipScene") as PlayclipScene | undefined;
  }

  public resize(width: number, height: number): void {
    this.scale.resize(width, height);
  }

  public pause(): void {
    this.playclip?.pauseVideo();
  }

  public resume(): void {
    this.playclip?.resumeVideo();
  }

  public volume(value: number): void {
    this.sound.setVolume(value);
    this.playclip?.setVolumeLevel(value);
  }

  public finish(): void {
    // Ad lifecycle finished; nothing to tear down for the core playclip scene.
  }
}
