import { sdk } from '@smoud/playable-sdk';
import * as Phaser from 'phaser';
// Using assets/* alias configured in tsconfig.json for direct assets import
import buttonBg from 'assets/button.png';

// Used when the app-constants script is missing or a field was removed, so a
// stripped-down HTML still runs instead of throwing at boot.
const DEFAULT_TEXT: GameDataText = {
  label: 'Headline',
  type: 'text',
  tooltip: 'Headline shown in the middle of the screen',
  value: 'Tap to Play',
  FontSize: 24,
  TextColor: '#ffffff',
  OriginX: 0.5,
  OriginY: 0.5,
  Align: 'center',
  StrokeColor: '#000000',
  StrokeThickness: 2
};

function textField(): GameDataText {
  const data = typeof GameData === 'undefined' ? undefined : GameData;
  return { ...DEFAULT_TEXT, ...data?.Text };
}

// Gap between the headline and the install button, in unscaled pixels.
const BUTTON_OFFSET_Y = 110;

class MainScene extends Phaser.Scene {
  private installButton!: Phaser.GameObjects.Container;
  private headline!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainScene' });
  }

  preload() {
    this.load.image('button', buttonBg);
  }

  create() {
    // Set up resize listener
    sdk.on('resize', this.resize, this);

    // Headline from the editor's GameData, dead centre.
    const text = textField();
    this.headline = this.add
      .text(this.cameras.main.centerX, this.cameras.main.centerY, text.value, {
        fontFamily: 'cursive',
        fontSize: `${text.FontSize}px`,
        color: text.TextColor,
        align: text.Align,
        stroke: text.StrokeColor,
        strokeThickness: text.StrokeThickness
      })
      .setOrigin(text.OriginX, text.OriginY);

    // Create container for button positioning. Sits below the headline now that
    // the headline owns the centre.
    this.installButton = this.add.container(
      this.cameras.main.centerX,
      this.cameras.main.centerY + BUTTON_OFFSET_Y
    );

    // Create animation container
    const animationContainer = this.add.container(0, 0);
    this.installButton.add(animationContainer);

    // Create button sprite
    const buttonBackground = this.add.image(0, 0, 'button');
    buttonBackground.setScale(0.35);

    // Create text
    const installText = this.add
      .text(0, 0, 'Install', {
        fontFamily: 'cursive',
        fontSize: '35px',
        color: '#ffffff',
        fontStyle: 'bold'
      })
      .setOrigin(0.5);

    // Add shadow to text
    installText.setShadow(4, 4, '#fffc6a', 9, true, true);

    // Add elements to animation container
    animationContainer.add([buttonBackground, installText]);

    // Add pulsing animation to the animation container
    this.tweens.add({
      targets: animationContainer,
      scaleX: 1.1,
      scaleY: 1.1,
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    // Make button interactive
    buttonBackground.setInteractive({ useHandCursor: true });
    buttonBackground.on('pointerdown', () => {
      sdk.install();
      sdk.finish();
    });

    // Set up interaction listener
    sdk.on('interaction', (count: number) => {
      console.log(`Interaction count: ${count}`);

      if (sdk.interactions >= 10) {
        sdk.finish();
      }
    });

    sdk.start();
  }

  private resize = (width: number, height: number) => {
    // Calculate scale based on screen dimensions
    const scaleX = width / 320;
    const scaleY = height / 480;
    const scale = Math.min(scaleX, scaleY); // Use smaller scale to fit both dimensions

    if (this.headline) {
      this.headline.setPosition(width / 2, height / 2);
      this.headline.setScale(scale);
    }

    if (this.installButton) {
      this.installButton.setPosition(width / 2, height / 2 + BUTTON_OFFSET_Y * scale);
      this.installButton.setScale(scale);
    }
  };

  shutdown() {
    // Clean up listeners when scene is shut down
    sdk.off('resize', this.resize, this);
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
