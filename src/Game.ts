import * as Phaser from 'phaser';
import { PlayclipScene } from './playclip/PlayclipScene';

// Draw at device pixels (capped at 2x for fill rate), the canvas scaled back
// to CSS size by zoom: at CSS px a 3x phone upscaled the video 3x, soft and
// blocky. Layout is relative to the game size, so it scales along.
const PIXEL_RATIO = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
const px = (n: number) => Math.round(n * PIXEL_RATIO);

export class Game extends Phaser.Game {
  constructor(width: number, height: number) {
    super({
      type: Phaser.AUTO,
      width: px(width),
      height: px(height),
      backgroundColor: '#000000',
      parent: document.body,
      scale: {
        mode: Phaser.Scale.NONE, // Manual scaling driven by the SDK resize event.
        autoCenter: Phaser.Scale.CENTER_BOTH,
        zoom: 1 / PIXEL_RATIO,
      },
      scene: PlayclipScene,
    });
  }

  private get playclip(): PlayclipScene | undefined {
    return this.scene.getScene("PlayclipScene") as PlayclipScene | undefined;
  }

  public resize(width: number, height: number): void {
    this.scale.resize(px(width), px(height));
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
