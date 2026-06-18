import * as Phaser from 'phaser';
import { sdk } from '@smoud/playable-sdk';
import { PLAYCLIP_DATA } from '../playclip-data';
import type {
  AssetEntry,
  AssetStyle,
  Orientation,
  OrientationValue,
  PlayclipAsset,
  PlayclipData,
  Vec2,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Extract the first number found in a CSS-ish string (e.g. "12px 16px" -> 12).
function firstNumber(input: string | number | undefined, fallback: number): number {
  if (typeof input === 'number') return input;
  if (!input) return fallback;
  const match = String(input).match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : fallback;
}

// Fit (natW x natH) inside (W x H) preserving aspect ratio, centered —
// mirrors the playclip's object-fit: contain + letterbox math.
function containRect(natW: number, natH: number, W: number, H: number): Rect {
  if (!natW || !natH) return { left: 0, top: 0, width: W, height: H };
  const videoAspect = natW / natH;
  const containerAspect = W / H;
  let width: number;
  let height: number;
  if (videoAspect > containerAspect) {
    width = W;
    height = W / videoAspect;
  } else {
    height = H;
    width = H * videoAspect;
  }
  return { left: (W - width) / 2, top: (H - height) / 2, width, height };
}

// Resolve an orientation-specific value (position/style) to a single value.
function pickOriented<T>(
  value: OrientationValue<T> | undefined,
  orientation: Orientation,
): T | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'landscape' in (value as object) &&
    'portrait' in (value as object)
  ) {
    return (value as { landscape: T; portrait: T })[orientation];
  }
  return value as T | undefined;
}

function cssColorToInt(color: string | undefined): number | undefined {
  if (!color) return undefined;
  try {
    return Phaser.Display.Color.ValueToColor(color).color;
  } catch {
    return undefined;
  }
}

function fontStyleString(style: AssetStyle): string {
  const parts: string[] = [];
  if (style.fontWeight === 'bold' || style.fontWeight === '700') parts.push('bold');
  if (style.fontStyle === 'italic') parts.push('italic');
  return parts.join(' ') || 'normal';
}

// A rendered overlay plus a closure that re-lays-it-out for a given video rect.
interface Overlay {
  asset: PlayclipAsset;
  root: Phaser.GameObjects.GameObject & {
    setVisible(value: boolean): unknown;
  };
  layout: (rect: Rect, orientation: Orientation) => void;
  clicked: boolean;
  // Visibility tracking for entry/exit animation transitions.
  wasVisible: boolean;
  // Called when the asset enters its time window (image overlays only).
  onShow?: () => void;
  // Called when the asset leaves its time window; invoke done() to actually hide.
  onHide?: (done: () => void) => void;
}

// Timeline control (loop / jump / freeze).
interface Control {
  id: string;
  startTime: number;
  endTime: number;
}

// Core subset of asset types this scene renders. Audio, transparent-button
// and endcard are intentionally deferred.
const SUPPORTED_TYPES: PlayclipAsset['type'][] = [
  'text',
  'image',
  'button',
  'transparent-button',
];

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export class PlayclipScene extends Phaser.Scene {
  // NOTE: do NOT name this `data` — Phaser's Scene reserves `this.playclipData` for its
  // DataManager and overwrites any field of that name during scene boot.
  private playclipData: PlayclipData = PLAYCLIP_DATA;
  private assets: PlayclipAsset[] = [];
  private overlays: Overlay[] = [];

  private video?: Phaser.GameObjects.Video;
  private videoRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  private videoReady = false;
  // Video sources are loaded up front (one per orientation that was provided).
  private videoKeys: { default?: string; portrait?: string; landscape?: string } = {};
  private lastVideoKey: string | null = null;

  private orientation: Orientation = 'landscape';
  // The playable holds on its first frame until the first tap anywhere.
  private started = false;
  private posterHeld = false;
  // Completion is signalled to the network SDK exactly once (drives the SDK's
  // end hook, e.g. Mintegral's window.gameEnd()).
  private finished = false;

  // Timeline controls (seek-based playback behaviour).
  private loops: Control[] = [];
  private jumps: Control[] = [];
  private freezes: Control[] = [];
  private currentLoop: Control | null = null;
  private currentJump: Control | null = null;
  private currentFreeze: Control | null = null;
  // Freeze ids already stopped on; kept until the playhead leaves their window so
  // breaking out of a freeze doesn't immediately re-trap it.
  private triggeredFreezes = new Set<string>();

  constructor() {
    super({ key: 'PlayclipScene' });
  }

  private rawAssets(): PlayclipAsset[] {
    return (this.playclipData.assets || [])
      .map((entry) =>
        entry && (entry as AssetEntry).values
          ? (entry as AssetEntry).values
          : (entry as PlayclipAsset),
      )
      .filter(Boolean);
  }

  private rawControls(kind: 'loops' | 'jumps' | 'freezes'): Control[] {
    const controls = (this.playclipData.controls || {}) as Record<
      string,
      Array<{ values?: Control } & Partial<Control>>
    >;
    return (controls[kind] || [])
      .map((entry) => (entry && entry.values ? entry.values : (entry as Control)))
      .filter((c): c is Control => !!c && typeof c.startTime === 'number');
  }

  preload(): void {
    // Load image textures (data URIs) up front so create() can place them.
    this.rawAssets().forEach((asset) => {
      if (asset.type === 'image' && asset.imageUrl) {
        this.load.image(`img-${asset.id}`, asset.imageUrl);
      }
    });

    // Load the video source(s) via the loader so the Video object is ready
    // (texture + dimensions) by create() — far more reliable than runtime
    // loadURL(), whose 'created' event only fires once playback begins.
    const v = this.playclipData.video || ({} as PlayclipData['video']);
    if (v.videoSrc) {
      this.videoKeys.default = 'clip_default';
      this.load.video('clip_default', v.videoSrc, true);
    }
    if (v.portraitSrc) {
      this.videoKeys.portrait = 'clip_portrait';
      this.load.video('clip_portrait', v.portraitSrc, true);
    }
    if (v.landscapeSrc) {
      this.videoKeys.landscape = 'clip_landscape';
      this.load.video('clip_landscape', v.landscapeSrc, true);
    }
  }

  create(): void {
    this.assets = this.rawAssets().filter((a) => SUPPORTED_TYPES.includes(a.type));
    this.loops = this.rawControls('loops');
    this.jumps = this.rawControls('jumps');
    this.freezes = this.rawControls('freezes');
    this.orientation = this.computeOrientation();

    this.createVideo();
    this.createOverlays();
    this.relayout();

    this.scale.on('resize', this.relayout, this);
    this.input.on('pointerdown', this.onPointerDown, this);

    sdk.start();
  }

  // --- Orientation & video ------------------------------------------------

  private computeOrientation(): Orientation {
    const video = this.playclipData.video || ({} as PlayclipData['video']);
    if (video.portraitSrc && !video.landscapeSrc) return 'portrait';
    if (video.landscapeSrc && !video.portraitSrc) return 'landscape';
    const { width, height } = this.scale.gameSize;
    return height >= width ? 'portrait' : 'landscape';
  }

  private currentVideoKey(): string | undefined {
    const k = this.videoKeys;
    if (this.orientation === 'portrait' && k.portrait) return k.portrait;
    if (this.orientation === 'landscape' && k.landscape) return k.landscape;
    return k.default || k.landscape || k.portrait;
  }

  private createVideo(): void {
    const key = this.currentVideoKey();
    if (!key || !this.cache.video.exists(key)) {
      // No (loaded) video — create an empty object so layout calls are safe.
      this.video = this.add.video(0, 0).setOrigin(0.5).setDepth(0);
      return;
    }

    const video = this.add.video(0, 0, key).setOrigin(0.5).setDepth(0);
    this.video = video;
    this.lastVideoKey = key;
    this.videoReady = true; // loader already prepared the texture + dimensions
    this.layoutVideo();

    // The loader prepares the element but the intrinsic dimensions
    // (videoWidth/videoHeight) aren't known until metadata/first frame are
    // ready. Until then the video rect falls back to the full game rect, so both
    // the video AND every overlay (which are positioned/sized relative to that
    // rect) are laid out wrong. Re-layout EVERYTHING — via relayout(), not just
    // layoutVideo() — as soon as the real size is available so assets are correct
    // on launch rather than only after the first resize.
    const el = video.video as HTMLVideoElement | undefined;
    if (el && !el.videoWidth) {
      el.addEventListener('loadedmetadata', () => this.relayout(), { once: true });
    }
    video.once(Phaser.GameObjects.Events.VIDEO_CREATED, () => this.relayout());

    // When the clip plays through to its end, the playable is complete — tell the
    // network SDK so it fires its end hook (Mintegral's window.gameEnd(), etc.).
    // Guarded by `started` so the muted poster-decode pass (paused on the first
    // frame in update()) can't trigger a premature completion.
    video.on(Phaser.GameObjects.Events.VIDEO_COMPLETE, () => {
      if (this.started) this.finishAd();
    });

    // A loaded-but-unplayed Phaser video renders nothing, so briefly play
    // (muted) to decode the first frame, then update() pauses on it as the
    // poster. Playback proper begins on the first tap (see startPlayback).
    video.setMute(true);
    video.play(false);
  }

  private maybeSwapVideoSource(): void {
    if (!this.video || !this.videoReady) return;
    const key = this.currentVideoKey();
    if (!key || key === this.lastVideoKey || !this.cache.video.exists(key)) return;
    this.lastVideoKey = key;
    // changeSource keeps playing if we're already started.
    this.video.changeSource(key, this.started);
    if (this.started) this.video.setMute(false);
  }

  private layoutVideo(): void {
    if (!this.video) return;
    const { width: W, height: H } = this.scale.gameSize;
    const element = this.video.video as HTMLVideoElement | undefined;
    const natW = element?.videoWidth || this.video.width || 0;
    const natH = element?.videoHeight || this.video.height || 0;

    this.videoRect = containRect(natW, natH, W, H);
    this.video.setPosition(
      this.videoRect.left + this.videoRect.width / 2,
      this.videoRect.top + this.videoRect.height / 2,
    );
    if (this.videoRect.width && this.videoRect.height) {
      this.video.setDisplaySize(this.videoRect.width, this.videoRect.height);
    }
  }

  // --- Overlays -----------------------------------------------------------

  private createOverlays(): void {
    this.assets.forEach((asset) => {
      let overlay: Overlay | undefined;
      if (asset.type === 'text') overlay = this.buildText(asset);
      else if (asset.type === 'image') overlay = this.buildImage(asset);
      else if (asset.type === 'button') overlay = this.buildButton(asset);
      else if (asset.type === 'transparent-button')
        overlay = this.buildTransparentButton(asset);
      if (overlay) {
        overlay.root.setVisible(false);
        this.overlays.push(overlay);
      }
    });
  }

  private centerOf(asset: PlayclipAsset, rect: Rect, orientation: Orientation): Vec2 {
    const pos = (pickOriented(asset.position, orientation) || { x: 50, y: 50 }) as Vec2;
    return {
      x: rect.left + (pos.x / 100) * rect.width,
      y: rect.top + (pos.y / 100) * rect.height,
    };
  }

  private widthPct(asset: PlayclipAsset, orientation: Orientation): number | undefined {
    return orientation === 'portrait'
      ? asset.portraitWidthPercentage
      : asset.landscapeWidthPercentage;
  }

  private heightPct(asset: PlayclipAsset, orientation: Orientation): number | undefined {
    return orientation === 'portrait'
      ? asset.portraitHeightPercentage
      : asset.landscapeHeightPercentage;
  }

  private buildText(asset: PlayclipAsset): Overlay {
    const style = (pickOriented(asset.style, this.orientation) || {}) as AssetStyle;
    const text = this.add
      .text(0, 0, asset.content || '', {
        fontFamily: style.fontFamily || 'Arial, sans-serif',
        fontSize: `${style.fontSize || 24}px`,
        color: style.color || '#ffffff',
        fontStyle: fontStyleString(style),
        align: style.textAlign || 'center',
        backgroundColor: style.backgroundColor || undefined,
      })
      .setOrigin(0.5)
      .setDepth(10);

    const pad = firstNumber(style.padding, 0);
    if (pad) text.setPadding(pad);

    return {
      asset,
      root: text,
      clicked: false,
      wasVisible: false,
      layout: (rect, orientation) => {
        const st = (pickOriented(asset.style, orientation) || {}) as AssetStyle;
        text.setFontSize(st.fontSize || 24);
        text.setColor(st.color || '#ffffff');
        const c = this.centerOf(asset, rect, orientation);
        text.setPosition(c.x, c.y);
      },
    };
  }

  private buildImage(asset: PlayclipAsset): Overlay {
    const key = `img-${asset.id}`;
    const image = this.textures.exists(key)
      ? this.add.image(0, 0, key)
      : this.add.image(0, 0, '__MISSING');
    image.setOrigin(0.5).setDepth(10);

    // Base position/scale updated by layout() on every resize.
    let baseX = 0;
    let baseY = 0;
    let baseScaleX = 1;
    let baseScaleY = 1;
    // Current video rect — updated by layout() so startLoop() can compute
    // gesture distances as a percentage of the video dimensions.
    let layoutRect: Rect = { left: 0, top: 0, width: 0, height: 0 };

    // Resolve CSS easing name to a Phaser ease string.
    const toEase = (css?: string): string => {
      const m: Record<string, string> = {
        linear: 'Linear',
        'ease-in': 'Sine.easeIn',
        'ease-out': 'Sine.easeOut',
        'ease-in-out': 'Sine.easeInOut',
      };
      return m[css ?? ''] ?? 'Sine.easeInOut';
    };

    const getStyle = (): AssetStyle | undefined =>
      (pickOriented(asset.style, this.orientation) || undefined) as AssetStyle | undefined;

    // Kill all tweens targeting this image (loop + any ongoing transition).
    const killAll = (): void => {
      this.tweens.killTweensOf(image);
    };

    // Reset image to the clean base state (position/scale/alpha/angle).
    const resetToBase = (): void => {
      image.setPosition(baseX, baseY);
      image.setScale(baseScaleX, baseScaleY);
      image.setAlpha(1);
      image.setAngle(0);
    };

    // Start an infinite looping animation based on animationStyle.
    // Default speeds match the CSS animation-duration values defined in css-builder.ts.
    // gestureSpeed overrides the default when the user has set it explicitly.
    const startLoop = (): void => {
      const style = getStyle();
      const anim = style?.animationStyle;
      if (!anim || anim === 'none') return;

      // Per-type default durations mirroring the CSS (css-builder.ts hardcoded values).
      // Gesture animations (tap/swipe/circle) use gestureSpeed; static ones use fixed CSS defaults.
      const DEFAULT_SPEED: Record<string, number> = {
        glow: 2000, pulse: 1500, bounce: 800, shake: 500, float: 3000,
        tap: 1200, swipeLeft: 1400, swipeRight: 1400, swipeUp: 1400, swipeDown: 1400, circle: 2000,
      };
      const speed = style?.gestureSpeed ?? DEFAULT_SPEED[anim] ?? 1400;
      // gestureDistance is treated as % of video rect dimension (width for
      // horizontal, height for vertical, min-dimension for circle). Tap uses
      // it as a 0-100 depth %, so it is excluded from the responsive conversion.
      const distPct = style?.gestureDistance ?? 24;
      const hDist = (distPct / 100) * layoutRect.width;
      const vDist = (distPct / 100) * layoutRect.height;
      const rDist = (distPct / 100) * Math.min(layoutRect.width, layoutRect.height);

      // CSS applies a single ease-in-out to the whole animation; all Phaser tween
      // segments use the same easing to replicate that behaviour.
      const E = 'Sine.easeInOut';

      switch (anim) {
        case 'glow': {
          // Use Phaser's Glow FX in WebGL; fall back to alpha pulse in Canvas.
          const glow = image.preFX?.addGlow(0x3b82f6, 4, 0, false);
          if (glow) {
            this.tweens.add({ targets: glow, outerStrength: 12, duration: speed / 2, yoyo: true, repeat: -1, ease: E });
          } else {
            this.tweens.add({ targets: image, alpha: 0.65, duration: speed / 2, yoyo: true, repeat: -1, ease: E });
          }
          break;
        }
        case 'pulse':
          // CSS: scale(1) → scale(1.05) → scale(1), 1.5s ease-in-out
          this.tweens.add({ targets: image, scaleX: baseScaleX * 1.05, scaleY: baseScaleY * 1.05, duration: speed / 2, yoyo: true, repeat: -1, ease: E });
          break;
        case 'bounce':
          // CSS: translateY(0) → translateY(-5px) → translateY(0), 0.8s ease-in-out
          this.tweens.add({ targets: image, y: baseY - 5, duration: speed / 2, yoyo: true, repeat: -1, ease: E });
          break;
        case 'shake':
          // CSS keyframes at 0%, 25%, 75%, 100% with hardcoded ±2px, 0.5s ease-in-out
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, x: baseX - 2, duration: speed * 0.25, ease: E },
            { targets: image, x: baseX + 2, duration: speed * 0.5,  ease: E },
            { targets: image, x: baseX,     duration: speed * 0.25, ease: E },
          ]});
          break;
        case 'float':
          // CSS: translateY(0) rotate(0) → translateY(-3px) rotate(1deg) → back, 3s ease-in-out
          this.tweens.add({ targets: image, y: baseY - 3, angle: 1, duration: speed / 2, yoyo: true, repeat: -1, ease: E });
          break;
        case 'tap': {
          // CSS keyframes at 0%, 40%, 65%, 100%; gestureDistance is 0-100 depth %.
          // HTML builder converts: --gesture-tap-depth = Math.min(1, gestureDistance / 100)
          const tapDist = style?.gestureDistance ?? 18;
          const depth = Math.min(1, tapDist / 100);
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, scaleX: baseScaleX * (1 - depth), scaleY: baseScaleY * (1 - depth), duration: speed * 0.4,  ease: E },
            { targets: image, scaleX: baseScaleX * 1.04,        scaleY: baseScaleY * 1.04,        duration: speed * 0.25, ease: E },
            { targets: image, scaleX: baseScaleX,               scaleY: baseScaleY,               duration: speed * 0.35, ease: E },
          ]});
          break;
        }
        case 'swipeLeft':
          // CSS keyframes: 0%=0, 60%=-hDist, 100%=0; ease-in-out
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, x: baseX - hDist, duration: speed * 0.6, ease: E },
            { targets: image, x: baseX,         duration: speed * 0.4, ease: E },
          ]});
          break;
        case 'swipeRight':
          // CSS keyframes: 0%=0, 60%=+hDist, 100%=0; ease-in-out
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, x: baseX + hDist, duration: speed * 0.6, ease: E },
            { targets: image, x: baseX,         duration: speed * 0.4, ease: E },
          ]});
          break;
        case 'swipeUp':
          // CSS keyframes: 0%=0, 60%=-vDist, 100%=0; ease-in-out
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, y: baseY - vDist, duration: speed * 0.6, ease: E },
            { targets: image, y: baseY,         duration: speed * 0.4, ease: E },
          ]});
          break;
        case 'swipeDown':
          // CSS keyframes: 0%=0, 60%=+vDist, 100%=0; ease-in-out
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, y: baseY + vDist, duration: speed * 0.6, ease: E },
            { targets: image, y: baseY,         duration: speed * 0.4, ease: E },
          ]});
          break;
        case 'circle': {
          // CSS: linear ease (smooth circular path), keyframes at 0%/25%/50%/75%/100%
          const r = rDist || 14;
          this.tweens.chain({ loop: -1, tweens: [
            { targets: image, x: baseX + r, y: baseY - r,        duration: speed * 0.25, ease: 'Linear' },
            { targets: image, x: baseX,     y: baseY - r * 1.57, duration: speed * 0.25, ease: 'Linear' },
            { targets: image, x: baseX - r, y: baseY - r,        duration: speed * 0.25, ease: 'Linear' },
            { targets: image, x: baseX,     y: baseY,             duration: speed * 0.25, ease: 'Linear' },
          ]});
          break;
        }
      }
    };

    // Play a one-shot entry animation; call onComplete when done (or immediately if none).
    const playEntry = (onComplete: () => void): void => {
      const style = getStyle();
      const entry = style?.entryAnimation;
      if (!entry || entry === 'none') { onComplete(); return; }

      const dur  = style?.animationDuration ?? 500;
      const ease = toEase(style?.animationEasing);
      const opFrom   = style?.animationOpacityFrom  ?? 0;
      const opTo     = style?.animationOpacityTo    ?? 1;
      const scFrom   = style?.animationScaleFrom    ?? 0;
      const scTo     = style?.animationScaleTo      ?? 1;
      const slideDist = style?.animationSlideDistance ?? 100;

      switch (entry) {
        case 'fadeIn':
          image.setAlpha(opFrom);
          this.tweens.add({ targets: image, alpha: opTo, duration: dur, ease, onComplete });
          break;
        case 'slideInLeft':
          image.setAlpha(0.6).setPosition(baseX - slideDist, baseY);
          this.tweens.add({ targets: image, x: baseX, alpha: 1, duration: dur, ease, onComplete });
          break;
        case 'slideInRight':
          image.setAlpha(0.6).setPosition(baseX + slideDist, baseY);
          this.tweens.add({ targets: image, x: baseX, alpha: 1, duration: dur, ease, onComplete });
          break;
        case 'slideInTop':
          image.setAlpha(0.6).setPosition(baseX, baseY - slideDist);
          this.tweens.add({ targets: image, y: baseY, alpha: 1, duration: dur, ease, onComplete });
          break;
        case 'slideInBottom':
          image.setAlpha(0.6).setPosition(baseX, baseY + slideDist);
          this.tweens.add({ targets: image, y: baseY, alpha: 1, duration: dur, ease, onComplete });
          break;
        case 'scaleIn':
          image.setAlpha(0.5).setScale(baseScaleX * scFrom, baseScaleY * scFrom);
          this.tweens.add({ targets: image, scaleX: baseScaleX * scTo, scaleY: baseScaleY * scTo, alpha: 1, duration: dur, ease, onComplete });
          break;
        case 'bounceIn':
          image.setAlpha(0).setScale(baseScaleX * scFrom, baseScaleY * scFrom);
          this.tweens.add({ targets: image, scaleX: baseScaleX * scTo, scaleY: baseScaleY * scTo, alpha: 1, duration: dur, ease: 'Bounce.easeOut', onComplete });
          break;
        default:
          onComplete();
      }
    };

    // Play a one-shot exit animation; call done() when the image should be hidden.
    const playExit = (done: () => void): void => {
      const style = getStyle();
      const exit = style?.exitAnimation;
      if (!exit || exit === 'none') { done(); return; }

      const dur  = style?.animationDuration ?? 500;
      const ease = toEase(style?.animationEasing);
      const opTo      = style?.animationOpacityTo    ?? 0;
      const scTo      = style?.animationScaleTo      ?? 0;
      const slideDist = style?.animationSlideDistance ?? 100;

      switch (exit) {
        case 'fadeOut':
          this.tweens.add({ targets: image, alpha: opTo, duration: dur, ease, onComplete: done });
          break;
        case 'slideOutLeft':
          this.tweens.add({ targets: image, x: baseX - slideDist, alpha: 0.6, duration: dur, ease, onComplete: done });
          break;
        case 'slideOutRight':
          this.tweens.add({ targets: image, x: baseX + slideDist, alpha: 0.6, duration: dur, ease, onComplete: done });
          break;
        case 'slideOutTop':
          this.tweens.add({ targets: image, y: baseY - slideDist, alpha: 0.6, duration: dur, ease, onComplete: done });
          break;
        case 'slideOutBottom':
          this.tweens.add({ targets: image, y: baseY + slideDist, alpha: 0.6, duration: dur, ease, onComplete: done });
          break;
        case 'scaleOut':
          this.tweens.add({ targets: image, scaleX: baseScaleX * scTo, scaleY: baseScaleY * scTo, alpha: 0.5, duration: dur, ease, onComplete: done });
          break;
        default:
          done();
      }
    };

    // Build the overlay; layout is assigned after so it can close over `overlay`.
    const overlay: Overlay = {
      asset,
      root: image,
      clicked: false,
      wasVisible: false,

      onShow: () => {
        // Cancel any in-flight tweens (e.g. a stale exit animation), reset to
        // the clean base state, then play the entry anim and start the loop.
        killAll();
        resetToBase();
        playEntry(() => startLoop());
      },

      onHide: (done) => {
        // Stop the looping animation, then play the exit anim before hiding.
        // If onShow is called before done() fires, killAll() in onShow kills the
        // exit tween so done() (and therefore setVisible(false)) never runs.
        killAll();
        playExit(done);
      },

      layout: (rect, orientation) => {
        // Kill every tween first — both loop and any in-flight transition tween.
        killAll();

        // Existing responsiveness logic (unchanged).
        const wPct = this.widthPct(asset, orientation);
        const hPct = this.heightPct(asset, orientation);
        const w = wPct ? wPct * rect.width : undefined;
        const h = hPct ? hPct * rect.height : undefined;

        if (w && h) {
          image.setDisplaySize(w, h);
        } else if (w && image.width) {
          image.setDisplaySize(w, w * (image.height / image.width));
        } else if (image.width) {
          // Fallback: ~20% of the video width, preserving aspect ratio.
          image.setScale((0.2 * rect.width) / image.width);
        }

        const c = this.centerOf(asset, rect, orientation);
        image.setPosition(c.x, c.y);

        // Update base values that animations use as their origin.
        baseX = c.x;
        baseY = c.y;
        baseScaleX = image.scaleX;
        baseScaleY = image.scaleY;
        layoutRect = rect;

        // Reset any animated state so the image is clean after a resize.
        image.setAlpha(1).setAngle(0);

        // Re-derive whether this asset should be visible right now (recovers from
        // any killed exit-animation that never called setVisible(false)).
        const t = (this.video?.getCurrentTime?.() ?? 0) as number;
        const within = t >= asset.time && t <= (asset.endTime || asset.time + 5);
        image.setVisible(within);
        overlay.wasVisible = within;

        // Restart the loop animation at the new base position if visible.
        if (within) startLoop();
      },
    };

    return overlay;
  }

  private buildButton(asset: PlayclipAsset): Overlay {
    const container = this.add.container(0, 0).setDepth(20);
    const graphics = this.add.graphics();
    const label = this.add.text(0, 0, asset.content || '', { fontSize: '20px' }).setOrigin(0.5);
    container.add([graphics, label]);

    const overlay: Overlay = {
      asset,
      root: container,
      clicked: false,
      wasVisible: false,
      layout: (rect, orientation) => {
        const st = (pickOriented(asset.style, orientation) || {}) as AssetStyle;

        label.setText(asset.content || '');
        label.setStyle({
          fontFamily: st.fontFamily || 'Arial, sans-serif',
          fontSize: `${st.fontSize || 20}px`,
          color: st.color || '#ffffff',
          fontStyle: fontStyleString(st),
        });

        const padX = firstNumber(st.padding, 16) || 16;
        const padY = Math.max(8, padX * 0.6);
        const wPct = this.widthPct(asset, orientation);
        const hPct = this.heightPct(asset, orientation);
        const bw = wPct ? wPct * rect.width : label.width + padX * 2;
        const bh = hPct ? hPct * rect.height : label.height + padY * 2;
        const radius = firstNumber(st.borderRadius, 8);

        graphics.clear();
        graphics.fillStyle(cssColorToInt(st.backgroundColor) ?? 0x6d28d9, 1);
        graphics.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);
        const borderColor = cssColorToInt(st.borderColor);
        if (borderColor !== undefined) {
          graphics.lineStyle(firstNumber(st.borderWidth, 2), borderColor, 1);
          graphics.strokeRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);
        }

        const c = this.centerOf(asset, rect, orientation);
        container.setPosition(c.x, c.y);
        container.setSize(bw, bh);

        // Keep an up-to-date hit area; the actual click is dispatched centrally
        // from onPointerDown (so the first tap can be reserved for "start").
        const hit = new Phaser.Geom.Rectangle(-bw / 2, -bh / 2, bw, bh);
        if (container.input && container.input.hitArea) {
          container.input.hitArea = hit;
        } else {
          container.setInteractive(hit, Phaser.Geom.Rectangle.Contains);
          if (container.input) container.input.cursor = 'pointer';
        }
      },
    };

    return overlay;
  }

  // A transparent-button is an invisible clickable area (commonly the CTA). It
  // renders nothing but occupies a hit region sized from its width/height
  // percentages; the tap is dispatched from onPointerDown like a normal button.
  private buildTransparentButton(asset: PlayclipAsset): Overlay {
    const container = this.add.container(0, 0).setDepth(25);

    return {
      asset,
      root: container,
      clicked: false,
      wasVisible: false,
      layout: (rect, orientation) => {
        const wPct = this.widthPct(asset, orientation);
        const hPct = this.heightPct(asset, orientation);
        const bw = wPct ? wPct * rect.width : rect.width * 0.4;
        const bh = hPct ? hPct * rect.height : rect.height * 0.1;
        const c = this.centerOf(asset, rect, orientation);
        container.setPosition(c.x, c.y);
        // Drives the hit-test in onPointerDown (centre ± displayWidth/2).
        container.setSize(bw, bh);
      },
    };
  }

  // --- Interaction --------------------------------------------------------

  // An overlay accepts taps if it's a button, a transparent-button, or an image
  // with a configured action. (Static images without an action stay non-interactive.)
  private isInteractive(overlay: Overlay): boolean {
    return (
      overlay.asset.type === 'button' ||
      overlay.asset.type === 'transparent-button' ||
      (overlay.asset.type === 'image' && !!overlay.asset.buttonAction)
    );
  }

  // Single entry point for all taps. The very first tap anywhere only starts
  // the ad; later taps are routed to whatever interactive overlay was hit.
  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.started) {
      this.startPlayback();
      return;
    }
    // Hit-test against each overlay's actual drawn rectangle (centre ± half its
    // display size) rather than Phaser's `currentlyOver`. A button is a Container
    // whose only sized child is a Graphics object, which reports no measurable
    // bounds — so relying on the container's auto hit area / getBounds() leaves
    // the clickable region not matching what's drawn. Both Containers and Images
    // are centre-origin, so centre ± displayWidth/2 covers each case uniformly.
    const px = pointer.worldX;
    const py = pointer.worldY;
    for (const overlay of this.overlays) {
      if (!this.isInteractive(overlay) || overlay.clicked) continue;
      const node = overlay.root as unknown as {
        x: number;
        y: number;
        displayWidth: number;
        displayHeight: number;
        visible: boolean;
      };
      if (!node.visible) continue;
      const halfW = node.displayWidth / 2;
      const halfH = node.displayHeight / 2;
      if (
        px >= node.x - halfW &&
        px <= node.x + halfW &&
        py >= node.y - halfH &&
        py <= node.y + halfH
      ) {
        this.activateButton(overlay);
        break;
      }
    }
  }

  private startPlayback(): void {
    if (this.started) return;
    this.started = true;
    this.posterHeld = false;
    if (this.video) {
      this.video.setMute(false);
      this.video.setVolume(typeof sdk.volume === 'number' ? sdk.volume : 1);
      // Resume from the held poster frame (or start, if not ready yet).
      this.video.setPaused(false);
      if (this.videoReady && !this.video.isPlaying()) this.video.play(false);
    }
  }

  // Signal end-of-playable to the network SDK exactly once. The SDK maps this to
  // the active network's completion hook (e.g. Mintegral calls window.gameEnd()).
  private finishAd(): void {
    if (this.finished) return;
    this.finished = true;
    sdk.finish();
  }

  private activateButton(overlay: Overlay): void {
    // Debounce a single appearance of the button; this is re-armed in update()
    // once the button leaves its time window (so it can be pressed again if its
    // range comes back around). It does NOT drive visibility — see update().
    overlay.clicked = true;

    const v = this.video;
    const action = overlay.asset.buttonAction;

    // Pressing any button breaks out of an active freeze and resumes playback.
    // The freeze stays in triggeredFreezes so it won't immediately re-trap as the
    // playhead plays back out through its window.
    if (this.currentFreeze && v) {
      this.currentFreeze = null;
      v.setPaused(false);
    }

    if (action?.type === 'seek' && typeof action.seekTime === 'number' && v) {
      // Seeking outside an active loop/jump breaks out of it (mirrors the HTML
      // runtime's handleButtonClick loop-breakout behaviour).
      if (
        this.currentLoop &&
        (action.seekTime < this.currentLoop.startTime ||
          action.seekTime > this.currentLoop.endTime)
      ) {
        this.currentLoop = null;
      }
      this.currentJump = null;
      v.setCurrentTime(action.seekTime);
      v.setPaused(false);
      return;
    }

    if (action?.type === 'cta') {
      // Hand off to the network SDK's store routing. Per-playable store links are
      // baked into build.json at build time.
      sdk.install();
      // A CTA press also completes the playable — signal end so networks that
      // wait for it (e.g. Mintegral's window.gameEnd()) are notified even when the
      // user converts before the clip plays out.
      this.finishAd();
      return;
    }

    // 'play' (or unspecified): advance so the video continues past the button.
    // If a loop is currently holding the playhead inside the button's window,
    // break out of it by seeking just past the loop end — otherwise the loop
    // would immediately re-engage (it re-activates whenever the playhead is in
    // range) and the button would never leave its time window.
    if (v) {
      if (this.currentLoop) {
        const resumeAt = this.currentLoop.endTime + 0.001;
        this.currentLoop = null;
        v.setCurrentTime(resumeAt);
      }
      this.currentJump = null;
      v.setPaused(false);
    }
  }

  // --- Per-frame & resize -------------------------------------------------

  update(): void {
    const v = this.video;
    const ready = !!v && this.videoReady;

    if (!this.started) {
      // Poster: let the first frame decode, then hold it until the first tap.
      if (ready && !this.posterHeld && v!.getCurrentTime() > 0) {
        v!.setPaused(true);
        this.posterHeld = true;
      }
    } else if (ready) {
      // A freeze holds the playhead until a button breaks out of it; while held,
      // don't let loops/jumps move it. Otherwise loops/jumps may seek the
      // playhead before we evaluate visibility.
      if (!this.currentFreeze) this.applyLoopsAndJumps(v!);
      this.applyFreezes(v!);
    }

    const t = ready ? v!.getCurrentTime() : 0;

    for (const overlay of this.overlays) {
      const start = overlay.asset.time;
      const end = overlay.asset.endTime || overlay.asset.time + 5;
      const within = t >= start && t <= end;

      // Transition-based visibility: only act on state changes so that image
      // overlays can play entry/exit animations instead of snapping.
      if (within && !overlay.wasVisible) {
        overlay.wasVisible = true;
        overlay.root.setVisible(true);
        overlay.onShow?.();
      } else if (!within && overlay.wasVisible) {
        overlay.wasVisible = false;
        if (overlay.onHide) {
          // Image overlays play an exit animation; done() hides the image.
          // If onShow fires before done() runs, killAll() in onShow kills the
          // exit tween so done() never fires — no spurious hide.
          overlay.onHide(() => overlay.root.setVisible(false));
        } else {
          overlay.root.setVisible(false);
        }
      }

      // Re-arm an interactive overlay once it leaves its window so it can be
      // pressed again if its time range comes back around (e.g. a looping intro).
      if (this.isInteractive(overlay) && !within) overlay.clicked = false;
    }
  }

  // Loops repeat a segment; jumps skip a segment. Loop takes precedence.
  // Mirrors the playclip HTML runtime's checkLoops/checkJumps behaviour.
  private applyLoopsAndJumps(v: Phaser.GameObjects.Video): void {
    const t = v.getCurrentTime();

    if (this.currentLoop) {
      if (t >= this.currentLoop.endTime - 0.02) {
        v.setCurrentTime(this.currentLoop.startTime + 0.001);
        return;
      }
      if (t < this.currentLoop.startTime || t > this.currentLoop.endTime + 0.1) {
        this.currentLoop = null;
      }
    } else {
      const found = this.loops.find((l) => t >= l.startTime && t <= l.endTime);
      if (found) {
        this.currentLoop = found;
        return;
      }
    }
    if (this.currentLoop) return; // a loop owns the playhead

    if (this.currentJump) {
      if (t < this.currentJump.startTime || t > this.currentJump.endTime + 0.1) {
        this.currentJump = null;
      }
    } else {
      const found = this.jumps.find((j) => t >= j.startTime - 0.26 && t <= j.startTime);
      if (found) {
        this.currentJump = found;
        v.setCurrentTime(found.endTime + 0.001);
      }
    }
  }

  // A freeze stops the video at its startTime and holds it there until a button
  // is pressed to break out (see activateButton). Mirrors the HTML runtime's
  // checkFreezes: once broken out of, the freeze stays in triggeredFreezes so it
  // doesn't immediately re-trap as the playhead plays back out through its window,
  // and re-arms once the playhead leaves the window.
  private applyFreezes(v: Phaser.GameObjects.Video): void {
    if (this.freezes.length === 0) return;
    // Loops and jumps take priority over freezes.
    if (this.currentLoop || this.currentJump) return;
    const t = v.getCurrentTime();

    if (this.currentFreeze) {
      // Release the freeze only if the playhead has moved outside its window
      // (e.g. a seek action). Otherwise keep the frame held.
      if (t < this.currentFreeze.startTime || t > this.currentFreeze.endTime + 0.1) {
        this.currentFreeze = null;
      } else if (!v.isPaused()) {
        v.setPaused(true);
      }
      return;
    }

    // Re-arm freezes once the playhead has left their window.
    this.freezes.forEach((f) => {
      if (this.triggeredFreezes.has(f.id) && (t < f.startTime || t > f.endTime + 0.1)) {
        this.triggeredFreezes.delete(f.id);
      }
    });

    // Stop at the start of the first not-yet-triggered freeze and hold there.
    const found = this.freezes.find(
      (f) => t >= f.startTime && t <= f.endTime && !this.triggeredFreezes.has(f.id),
    );
    if (found) {
      this.currentFreeze = found;
      this.triggeredFreezes.add(found.id);
      v.setPaused(true);
    }
  }

  private relayout = (): void => {
    this.orientation = this.computeOrientation();
    this.maybeSwapVideoSource();
    this.layoutVideo();
    this.overlays.forEach((overlay) => overlay.layout(this.videoRect, this.orientation));
  };

  // --- Public controls (driven by Game / SDK events) ----------------------

  pauseVideo(): void {
    this.video?.setPaused(true);
  }

  resumeVideo(): void {
    // Don't fight an active freeze hold (the SDK may resume on app foreground).
    if (!this.currentFreeze) this.video?.setPaused(false);
  }

  setVolumeLevel(value: number): void {
    if (!this.video) return;
    if (value > 0 && this.started) this.video.setMute(false);
    this.video.setVolume(value);
  }

  shutdown(): void {
    this.scale.off('resize', this.relayout, this);
    this.input.off('pointerdown', this.onPointerDown, this);
  }
}
