import { sdk } from '@smoud/playable-sdk';
import * as Phaser from 'phaser';
import hulkCard from 'assets/Hulk10.png';
import abominationCard from 'assets/Abomination08.png';
import antManCard from 'assets/AntMan07.png';
import webImage from 'assets/web.png';

const WEB_START_ANCHOR_X = 292 / 405;
const WEB_START_ANCHOR_X_FLIPPED = 1 - WEB_START_ANCHOR_X;

class MainScene extends Phaser.Scene {
  private hulkSprite!: Phaser.GameObjects.Image;
  private abominationSprite!: Phaser.GameObjects.Image;
  private antManSprite!: Phaser.GameObjects.Image;
  private leftWebSprite!: Phaser.GameObjects.Image;
  private rightWebSprite!: Phaser.GameObjects.Image;
  private isSwapping = false;
  private webRevealProgress = 0;

  constructor() {
    super({ key: 'MainScene' });
  }

  preload() {
    this.load.image('hulk-card', hulkCard);
    this.load.image('abomination-card', abominationCard);
    this.load.image('ant-man-card', antManCard);
    this.load.image('web', webImage);
  }

  create() {
    sdk.on('resize', this.resize, this);

    this.abominationSprite = this.add.image(0, 0, 'abomination-card').setOrigin(0.5);
    this.antManSprite = this.add.image(0, 0, 'ant-man-card').setOrigin(0.5);
    this.hulkSprite = this.add.image(0, 0, 'hulk-card').setOrigin(0.5);
    this.leftWebSprite = this.add.image(0, 0, 'web').setOrigin(WEB_START_ANCHOR_X, 1).setDepth(10).setVisible(false);
    this.rightWebSprite = this.add
      .image(0, 0, 'web')
      .setOrigin(WEB_START_ANCHOR_X_FLIPPED, 1)
      .setDepth(10)
      .setVisible(false)
      .setFlipX(true);

    this.hulkSprite.setInteractive({ useHandCursor: true });
    this.hulkSprite.on('pointerdown', this.swapCenterCards, this);

    this.resize(this.scale.width, this.scale.height);

    sdk.on('interaction', (count: number) => {
      console.log(`Interaction count: ${count}`);

      if (sdk.interactions >= 10) {
        sdk.finish();
      }
    });

    sdk.start();
  }

  private swapCenterCards = () => {
    if (this.isSwapping) {
      return;
    }

    this.isSwapping = true;
    const abominationX = this.abominationSprite.x;
    const antManX = this.antManSprite.x;
    const swapDuration = 820;

    this.webRevealProgress = 0;
    this.leftWebSprite.setVisible(true).setAlpha(1);
    this.rightWebSprite.setVisible(true).setAlpha(1);
    this.drawSwapWebs();

    this.tweens.add({
      targets: this,
      webRevealProgress: 1,
      duration: 560,
      ease: 'Expo.easeIn',
      onUpdate: () => {
        this.drawSwapWebs();
      },
      onComplete: () => {
        this.startCardSwapTweens(abominationX, antManX, swapDuration);
      }
    });
  };

  private startCardSwapTweens(abominationX: number, antManX: number, swapDuration: number) {
    let completedTweens = 0;

    this.tweens.add({
      targets: this.abominationSprite,
      x: antManX,
      yoyo: false,
      duration: swapDuration,
      ease: 'Back.easeInOut',
      onUpdate: () => {
        this.drawSwapWebs();
      },
      onComplete: () => {
        completedTweens += 1;
        if (completedTweens === 2) {
          this.finishSwap();
        }
      }
    });

    this.tweens.add({
      targets: this.antManSprite,
      x: abominationX,
      yoyo: false,
      duration: swapDuration,
      ease: 'Back.easeInOut',
      onUpdate: () => {
        this.drawSwapWebs();
      },
      onComplete: () => {
        completedTweens += 1;
        if (completedTweens === 2) {
          this.finishSwap();
        }
      }
    });
  }

  private finishSwap() {
    this.time.delayedCall(480, () => {
      this.tweens.add({
        targets: [this.leftWebSprite, this.rightWebSprite],
        alpha: 0,
        duration: 320,
        ease: 'Sine.easeOut',
        onComplete: () => {
          this.leftWebSprite.setVisible(false);
          this.rightWebSprite.setVisible(false);
          this.leftWebSprite.setAlpha(1);
          this.rightWebSprite.setAlpha(1);
          this.leftWebSprite.setCrop();
          this.rightWebSprite.setCrop();
          this.isSwapping = false;
        }
      });
    });
  }

  private drawSwapWebs() {
    if (!this.leftWebSprite || !this.rightWebSprite) {
      return;
    }

    const leftTargetX = this.abominationSprite.x;
    const leftTargetY = this.abominationSprite.y;
    const rightTargetX = this.antManSprite.x;
    const rightTargetY = this.antManSprite.y;

    this.positionWebSprite(this.leftWebSprite, this.hulkSprite.x, this.hulkSprite.y, leftTargetX, leftTargetY);
    this.positionWebSprite(this.rightWebSprite, this.hulkSprite.x, this.hulkSprite.y, rightTargetX, rightTargetY);
  }

  private positionWebSprite(
    webSprite: Phaser.GameObjects.Image,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Phaser.Math.Angle.Between(fromX, fromY, toX, toY);
    const sourceHeight = webSprite.height || 1;

    webSprite.setPosition(fromX, fromY);
    webSprite.setRotation(angle + Phaser.Math.DegToRad(90));
    webSprite.setFlipX(false);
    webSprite.setScale(0.35, distance / sourceHeight);
    this.applyWebRevealCrop(webSprite);
  }

  private applyWebRevealCrop(webSprite: Phaser.GameObjects.Image) {
    const sourceWidth = webSprite.width || 1;
    const sourceHeight = webSprite.height || 1;
    const progress = Phaser.Math.Clamp(this.webRevealProgress, 0, 1);
    const revealHeight = sourceHeight * progress;
    const cropY = sourceHeight - revealHeight;

    webSprite.setCrop(0, cropY, sourceWidth, revealHeight);
  }

  private resize = (width: number, height: number) => {
    const centerX = width / 2;
    const centerY = height / 2 - 100;
    const centerGap = Math.min(260, width * 0.28);
    const cardScale = Math.min(width / 1200, height / 1500) * 0.8;

    if (this.abominationSprite && this.antManSprite && this.hulkSprite) {
      this.abominationSprite.setPosition(centerX - centerGap / 2, centerY);
      this.antManSprite.setPosition(centerX + centerGap / 2, centerY);
      this.hulkSprite.setPosition(centerX, height - this.hulkSprite.displayHeight * 0.5 - 20);

      this.abominationSprite.setScale(cardScale);
      this.antManSprite.setScale(cardScale);
      this.hulkSprite.setScale(cardScale);

      if (this.isSwapping) {
        this.drawSwapWebs();
      }
    }
  };

  shutdown() {
    sdk.off('resize', this.resize, this);
    this.hulkSprite?.off('pointerdown', this.swapCenterCards, this);
    this.leftWebSprite?.destroy();
    this.rightWebSprite?.destroy();
  }
}

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
