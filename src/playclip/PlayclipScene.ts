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
}

// Timeline control (loop / jump). Freeze is still deferred.
interface Control {
  id: string;
  startTime: number;
  endTime: number;
}

// Core subset of asset types this scene renders. Audio, transparent-button
// and endcard are intentionally deferred.
const SUPPORTED_TYPES: PlayclipAsset['type'][] = ['text', 'image', 'button'];

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
  private pausedForButtonId: string | null = null;
  // The playable holds on its first frame until the first tap anywhere.
  private started = false;
  private posterHeld = false;

  // Timeline controls (seek-based playback behaviour).
  private loops: Control[] = [];
  private jumps: Control[] = [];
  private currentLoop: Control | null = null;
  private currentJump: Control | null = null;

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
    // ready. Until then layoutVideo() falls back to the full game rect and the
    // video looks stretched. Re-layout as soon as the real size is available so
    // it's correct on launch rather than only after the first resize.
    const el = video.video as HTMLVideoElement | undefined;
    if (el && !el.videoWidth) {
      el.addEventListener('loadedmetadata', () => this.layoutVideo(), { once: true });
    }
    video.once(Phaser.GameObjects.Events.VIDEO_CREATED, () => this.layoutVideo());

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

    return {
      asset,
      root: image,
      clicked: false,
      layout: (rect, orientation) => {
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
      },
    };
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

  // --- Interaction --------------------------------------------------------

  // Single entry point for all taps. The very first tap anywhere only starts
  // the ad; later taps are routed to whatever button was hit.
  private onPointerDown(
    _pointer: Phaser.Input.Pointer,
    currentlyOver: Phaser.GameObjects.GameObject[],
  ): void {
    if (!this.started) {
      this.startPlayback();
      return;
    }
    for (const overlay of this.overlays) {
      if (
        overlay.asset.type === 'button' &&
        !overlay.clicked &&
        currentlyOver.includes(overlay.root as Phaser.GameObjects.GameObject)
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

  private activateButton(overlay: Overlay): void {
    overlay.clicked = true;

    const action = overlay.asset.buttonAction;
    if (action?.type === 'seek' && typeof action.seekTime === 'number' && this.video) {
      this.video.setCurrentTime(action.seekTime);
      this.video.setPaused(false);
    } else if (action?.type === 'play' && this.video) {
      this.video.setPaused(false);
    } else {
      // cta (or unspecified): hand off to the network SDK's store routing.
      // Per-playable store links are baked into build.json at build time.
      sdk.install();
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
      // Loops/jumps may seek the playhead before we evaluate visibility.
      this.applyLoopsAndJumps(v!);
    }

    const t = ready ? v!.getCurrentTime() : 0;
    let activeButton: Overlay | null = null;

    for (const overlay of this.overlays) {
      const start = overlay.asset.time;
      const end = overlay.asset.endTime || overlay.asset.time + 5;
      const within = t >= start && t <= end;
      const isButton = overlay.asset.type === 'button';
      const show = isButton ? within && !overlay.clicked : within;
      overlay.root.setVisible(show);
      if (isButton && show && !activeButton) activeButton = overlay;
    }

    // Button-pause: hold the video while an unclicked button is on screen.
    if (ready && this.started) {
      if (activeButton) {
        if (!v!.isPaused()) v!.setPaused(true);
        this.pausedForButtonId = activeButton.asset.id;
      } else if (this.pausedForButtonId) {
        this.pausedForButtonId = null;
        if (v!.isPaused()) v!.setPaused(false);
      }
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
    // Don't fight the button-pause hold.
    if (!this.pausedForButtonId) this.video?.setPaused(false);
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
