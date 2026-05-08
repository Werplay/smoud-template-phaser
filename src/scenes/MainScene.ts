import { sdk } from '@smoud/playable-sdk';
import * as Phaser from 'phaser';
import { calculateVideoLayout } from '../video/layout';
import { ALL_VIDEO_KEYS, HAS_REAL_PORTRAIT_SOURCE, VIDEO_SOURCES } from '../video/sources';
import { FitMode, VideoKey } from '../video/types';

export class MainScene extends Phaser.Scene {
  private video?: Phaser.GameObjects.Video;
  private availableVideoKeys: VideoKey[] = [];
  private activeVideoKey: VideoKey | null = null;
  private videoAspectRatio = 16 / 9;
  private fitMode: FitMode = 'cover';

  constructor() {
    super({ key: 'MainScene' });
  }

  preload() {
    this.load.video('bg-portrait', VIDEO_SOURCES.portrait);
    this.load.video('bg-landscape', VIDEO_SOURCES.landscape);
  }

  create() {
    sdk.on('resize', this.resize, this);

    this.availableVideoKeys = ALL_VIDEO_KEYS.filter((key) => this.cache.video.exists(key));

    const initialKey = this.pickVideoKey(this.scale.width, this.scale.height);
    if (initialKey) {
      this.createAndPlayVideo(initialKey, this.scale.width, this.scale.height);
    }

    this.resize(this.scale.width, this.scale.height);
    sdk.start();
  }

  private resize = (width: number, height: number) => {
    this.updateVideoLayout(width, height);
  };

  private updateVideoLayout(width: number, height: number): void {
    const nextVideoKey = this.pickVideoKey(width, height);
    if (!nextVideoKey) return;

    const isPortraitScreen = height > width;
    const hasPortraitVideo = this.availableVideoKeys.includes('bg-portrait') && HAS_REAL_PORTRAIT_SOURCE;
    this.fitMode = isPortraitScreen && !hasPortraitVideo ? 'contain' : 'cover';

    if (this.activeVideoKey !== nextVideoKey) {
      this.createAndPlayVideo(nextVideoKey, width, height);
      return;
    }

    if (this.video) {
      this.layoutVideo(width, height);
    }
  }

  private pickVideoKey(width: number, height: number): VideoKey | null {
    if (this.availableVideoKeys.length === 0) return null;
    const preferredKey: VideoKey = width >= height ? 'bg-landscape' : 'bg-portrait';
    if (this.availableVideoKeys.includes(preferredKey)) return preferredKey;
    return this.availableVideoKeys[0] ?? null;
  }

  private createAndPlayVideo(key: VideoKey, width: number, height: number): void {
    if (this.video) {
      this.video.stop();
      this.video.destroy();
    }

    this.video = this.add.video(width / 2, height / 2, key);
    this.video.once('created', () => {
      const el = (this.video as unknown as { video?: HTMLVideoElement }).video;
      if (el?.videoWidth && el?.videoHeight) {
        this.videoAspectRatio = el.videoWidth / el.videoHeight;
      }
      this.layoutVideo(this.scale.width, this.scale.height);
    });

    this.layoutVideo(width, height);
    this.video.setLoop(false);
    this.video.setMute(false);
    this.video.play(false);
    this.activeVideoKey = key;
  }

  private layoutVideo(width: number, height: number): void {
    if (!this.video) return;
    const size = calculateVideoLayout(width, height, this.fitMode, this.videoAspectRatio);
    this.video.setPosition(width / 2, height / 2);
    this.video.setDisplaySize(size.width, size.height);
  }

  shutdown() {
    sdk.off('resize', this.resize, this);
    if (this.video) {
      this.video.stop();
      this.video.destroy();
      this.video = undefined;
    }
  }
}
