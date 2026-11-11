import * as Phaser from 'phaser';
import { sdk } from '@smoud/playable-sdk';
import { PLAYCLIP_DATA } from '../playclip-data';
import { isEndcardVisible } from './endcard-visibility';
import { bindHeatmap, track } from './analytics';
import { sampleAnimation, type AnimStyle } from './animation/sample';
import { layerOf } from './animation/layers';
import {
  actionsFor,
  dropZoneOf,
  hasActions,
  holdTimes,
  idleMsOf,
  interactionsOf,
  movesPlayback,
  needsPress,
  runActions,
  type Action,
  type GestureEvent,
} from './animation/interactions';
import { IdleHints, Press, TapCounter } from './animation/gestures';
import { fillOf, PROGRESS_DEFAULTS, Vars } from './animation/vars';
import {
  isPingPong,
  reverseEndVideoTime,
  sourceDuration,
  toSourceTime,
  toVideoTime,
  type LoopMode,
  type ReversedSegment,
} from './animation/pingpong';
import {
  activeTextAnimator,
  sampleTextUnit,
  TEXT_ANIMATORS,
  textAnimatorDone,
  type TextAnimatorStyle,
} from './animation/text';
import {
  DESIGN_SCREEN,
  stageLayout,
  type OrientationFrames,
  type ResolvedFrame,
} from './animation/frame';
import {
  colorInt,
  DROP_SHADOW_BLUR_SCALE,
  glowOf,
  gradientLine,
  gradientOf,
  rgba,
  shadowOf,
  shadowOffset,
  strokeOf,
  stylePadding,
  type GlowStyle,
} from './animation/styles';
import {
  computePlaybackTime,
  getPostRollConfig,
  isPostRollComplete,
  type PostRollConfig,
} from './playback-time';
import type {
  AssetEntry,
  AssetStyle,
  AudioAction,
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

// Parse CSS padding shorthand (e.g. "8px 12px" -> { x: 8, y: 12 }).
function paddingXY(
  padding: string | undefined,
  fallbackX: number,
  fallbackY: number,
): { x: number; y: number } {
  if (!padding) return { x: fallbackX, y: fallbackY };
  const nums = String(padding).match(/-?\d+(\.\d+)?/g);
  if (!nums || nums.length === 0) return { x: fallbackX, y: fallbackY };
  const x = parseFloat(nums[0]);
  const y = nums.length > 1 ? parseFloat(nums[1]) : x;
  return { x, y };
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

// Anchor (rotation/scale pivot) as fractions of the box; 0.5/0.5 = centre.
function anchorOf(style: AssetStyle): { ax: number; ay: number } {
  return { ax: (style.anchorX ?? 50) / 100, ay: (style.anchorY ?? 50) / 100 };
}

// --- Layer styles drawn with the 2D canvas --------------------------------
// The canvas shadow model (colour, blur, offset) is CSS's, so shadows/glows
// drawn this way match the editor's CSS box-shadow / drop-shadow.

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Draw only the shadow of a shape, not the shape, so translucent pixels
// aren't darkened by drawing the shape twice. The shape is drawn into the right
// half of a double-width scratch canvas with its shadow offset into the left
// half, which is then copied over. (Drawing the shape off-canvas instead fails:
// browsers skip drawImage calls outside the canvas, shadow included.)
let scratch: HTMLCanvasElement | undefined;
function shadowPass(
  ctx: CanvasRenderingContext2D,
  color: string,
  blur: number,
  ox: number,
  oy: number,
  draw: (target: CanvasRenderingContext2D, dx: number) => void,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  scratch ??= document.createElement('canvas');
  scratch.width = w * 2;
  scratch.height = h;
  const s = scratch.getContext('2d')!;
  s.clearRect(0, 0, w * 2, h);
  s.save();
  s.shadowColor = color;
  s.shadowBlur = blur;
  s.shadowOffsetX = ox - w;
  s.shadowOffsetY = oy;
  draw(s, w);
  s.restore();
  ctx.drawImage(scratch, 0, 0, w, h, 0, 0, w, h);
}

function cssColorToInt(color: string | undefined): number | undefined {
  if (!color) return undefined;
  try {
    return Phaser.Display.Color.ValueToColor(color).color;
  } catch {
    return undefined;
  }
}

/** A CSS colour as Phaser's int plus its alpha (rgba() keeps its opacity). */
function colorAndAlpha(css: string): { color: number; alpha: number } {
  try {
    const c = Phaser.Display.Color.ValueToColor(css);
    return { color: c.color, alpha: c.alphaGL };
  } catch {
    return { color: 0xffffff, alpha: 1 };
  }
}

function textBackgroundColor(color: string | undefined): string | undefined {
  if (!color || color === 'transparent') return undefined;
  return color;
}

function fontStyleString(style: AssetStyle): string {
  const parts: string[] = [];
  if (style.fontWeight === 'bold' || style.fontWeight === '700') parts.push('bold');
  if (style.fontStyle === 'italic') parts.push('italic');
  return parts.join(' ') || 'normal';
}

// The transform calls animation needs; Text, Image and Container all have them.
type AnimatableRoot = Phaser.GameObjects.GameObject & {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  setVisible(value: boolean): unknown;
  setPosition(x: number, y: number): unknown;
  setScale(x: number, y: number): unknown;
  setAngle(degrees: number): unknown;
  setAlpha(value: number): unknown;
  preFX?: Phaser.GameObjects.Components.FX | null;
  postFX?: Phaser.GameObjects.Components.FX | null;
};

// A rendered overlay plus a closure that re-lays-it-out for a given video rect.
interface Overlay {
  asset: PlayclipAsset;
  root: AnimatableRoot;
  layout: (rect: Rect, orientation: Orientation) => void;
  clicked: boolean;
  wasVisible: boolean;
  // Scene time (ms) when the overlay last entered its window; drives entry + loop.
  appearedAt: number;
  // Transform produced by layout(); animation offsets are applied on top of it.
  base?: { x: number; y: number; scaleX: number; scaleY: number; angle: number };
  // Editor px → screen px, so animation distances keep their designed size.
  designScale: number;
  // root position minus the box centre: the anchor (pivot) offset, so taps
  // still hit-test against the drawn box.
  anchorOffset?: Vec2;
  // The drawn box when the texture is padded for shadows/glows (hit-testing).
  hitSize?: { w: number; h: number };
  // Outer-glow layer style FX (text), recreated when colour/size change.
  styleGlowFx?: Phaser.FX.Glow;
  styleGlowKey?: string;
  // Glow FX, created on first use; null when the renderer can't do FX.
  glow?: Phaser.FX.Glow | null;
  // Text animator: crops of the styled text's own texture, one per
  // character/word, shown in place of the text while it reveals.
  textUnits?: TextUnits;
  // Where a drag trigger moved it (screen px); kept after a drop until the
  // overlay leaves its window.
  drag?: Vec2;
  // A progress bar: redraws its fill (0–1) each frame (see update()).
  drawFill?: (fill: number) => void;
}

interface TextUnits {
  container: Phaser.GameObjects.Container;
  units: Array<{ img: Phaser.GameObjects.Image; i: number; y: number }>;
  n: number;
  fontPx: number;
  style: TextAnimatorStyle;
}

// Glow preset colour/strength, matching the editor's CSS button glow.
const GLOW_COLOR = 0x667eea;
const GLOW_STRENGTH = 4;

// Timeline control (loop / jump / freeze).
interface Control {
  id: string;
  startTime: number;
  endTime: number;
  /** Loops: 'pingpong' plays forward then backward (baked, see pingPong). */
  mode?: LoopMode;
}

// Core overlay asset types rendered on the video timeline. Audio is deferred;
// endcard is handled separately (full-screen post-roll).
const SUPPORTED_TYPES: PlayclipAsset['type'][] = [
  'text',
  'image',
  'button',
  'transparent-button',
  'progress',
];

// Draw order mirrors the editor: the video at the bottom, then every overlay at
// its layer (animation/layers.ts — per-type defaults, or the asset's zIndex),
// with the end card behind them.
const DEPTH_VIDEO = 0;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export class PlayclipScene extends Phaser.Scene {
  // NOTE: do NOT name this `data` — Phaser's Scene reserves `this.playclipData` for its
  // DataManager and overwrites any field of that name during scene boot.
  private playclipData: PlayclipData = PLAYCLIP_DATA;
  private assets: PlayclipAsset[] = [];
  private overlays: Overlay[] = [];
  // The press being read for hold / swipe / drag (animation/gestures.ts).
  private press: {
    overlay: Overlay;
    p: Press;
    timers: Phaser.Time.TimerEvent[];
  } | null = null;
  private tapCounter = new TapCounter();
  // Idle hints: overlays with an idle trigger show once nothing is touched.
  private idleHints = new IdleHints(0);
  // Counters for this run of the ad (animation/vars.ts).
  private vars = new Vars();
  private endcardAsset?: PlayclipAsset;
  private endcardOverlay?: Overlay;
  private videoEnded = false;
  private postRollClockStart = 0;

  private video?: Phaser.GameObjects.Video;
  // The frame overlays are laid out in: the video itself, or for an adapted
  // orientation the design screen shape (see animation/frame.ts).
  private videoRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  private adapted: ResolvedFrame | null = null;
  // What fills an adapted frame's bars: a blurred copy of the video (sharing
  // its texture, so nothing is decoded twice) or a colour.
  private frameBlur?: Phaser.GameObjects.Image;
  private frameColor?: Phaser.GameObjects.Rectangle;
  private videoReady = false;
  // Geometry mask clipping every overlay to the video rect, so an asset placed
  // partly outside the video view is cropped at the edge rather than spilling
  // into the letterbox. Mirrors the DOM export's `.video-wrapper { overflow:
  // hidden }`.
  private cropShape?: Phaser.GameObjects.Graphics;
  private cropMask?: Phaser.Display.Masks.GeometryMask;
  // Video sources are loaded up front (one per orientation that was provided).
  private videoKeys: { default?: string; portrait?: string; landscape?: string } = {};
  private lastVideoKey: string | null = null;

  private orientation: Orientation = 'landscape';
  // The playable holds on its first frame until the first tap anywhere.
  private started = false;
  // Scene time (ms) of the first tap; animations hold their first frame before it.
  private startedAt = 0;
  private posterHeld = false;
  // Completion is signalled to the network SDK exactly once (drives the SDK's
  // end hook, e.g. Mintegral's window.gameEnd()).
  private finished = false;

  // Audio assets and their native HTMLAudioElement instances.
  private audioAssets: PlayclipAsset[] = [];
  private audioElements: Map<string, HTMLAudioElement> = new Map();
  private currentAudioId: string | null = null;
  private videoMutedForAudio = false;

  // Timeline controls (seek-based playback behaviour).
  private loops: Control[] = [];
  // Ping-pong loops whose reversed copies are baked into the video. Every
  // time in the data is in the original video's timeline ("source time");
  // srcTime/seekSrc map to and from the baked video's clock.
  private pingPong: ReversedSegment[] = [];
  private jumps: Control[] = [];
  private freezes: Control[] = [];
  private currentLoop: Control | null = null;
  private currentJump: Control | null = null;
  private currentFreeze: Control | null = null;
  // Previous video time seen by applyFreezes; -1 so a freeze at t=0 can still fire
  // once playback starts. Used to detect the playhead crossing a freeze point even
  // when a frame jumps past it.
  private lastFreezeTime = -1;
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
      if (asset.type === 'endcard' && asset.imageUrl) {
        this.load.image(`endcard-${asset.id}`, asset.imageUrl);
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
    const allAssets = this.rawAssets();
    const endcards = allAssets.filter((a) => a.type === 'endcard');
    if (endcards.length > 1) {
      console.warn('[PlayclipScene] Multiple endcard assets; using the first.');
    }
    this.endcardAsset = endcards[0];
    this.assets = allAssets.filter((a) => SUPPORTED_TYPES.includes(a.type));
    this.loops = this.rawControls('loops');
    this.pingPong = this.playclipData.video?.pingPong ?? [];
    this.jumps = this.rawControls('jumps');
    this.freezes = this.rawControls('freezes');
    this.orientation = this.computeOrientation();

    // Initialise audio assets — active ones with a URL, separate from visual overlays.
    this.audioAssets = this.rawAssets().filter(
      (a) => a.type === 'audio' && !!a.audioUrl && a.audioAction?.isActive !== false,
    );
    this.audioAssets.forEach((asset) => {
      const el = new Audio(asset.audioUrl!);
      el.volume = asset.audioAction?.volume ?? 0.5;
      el.playbackRate = asset.audioAction?.speed ?? 1;
      el.loop = asset.audioAction?.loop ?? false;
      this.audioElements.set(asset.id, el);
    });

    this.createVideo();
    this.createOverlays();
    if (this.endcardAsset) {
      this.endcardOverlay = this.buildEndcard(this.endcardAsset);
      this.endcardOverlay.root.setVisible(false);
    }
    this.relayout();

    this.scale.on('resize', this.relayout, this);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);

    sdk.start();
    bindHeatmap();
    track('gameReady');
  }

  // --- Orientation & video ------------------------------------------------

  private computeOrientation(): Orientation {
    const video = this.playclipData.video || ({} as PlayclipData['video']);
    const frames = this.playclipData.layout?.frames || {};
    // A single-orientation video stays in that orientation, unless a frame is
    // set up for the other one.
    if (video.portraitSrc && !video.landscapeSrc && !frames.landscape) return 'portrait';
    if (video.landscapeSrc && !video.portraitSrc && !frames.portrait) return 'landscape';
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
      this.video = this.add.video(0, 0).setOrigin(0.5).setDepth(DEPTH_VIDEO);
      return;
    }

    const video = this.add.video(0, 0, key).setOrigin(0.5).setDepth(DEPTH_VIDEO);
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
    // The blurred frame background shares the video's texture, which exists
    // once the first frame is decoded.
    video.once(Phaser.GameObjects.Events.VIDEO_TEXTURE, () => this.relayout());

    // When the clip plays through to its end, the playable is complete — tell the
    // network SDK so it fires its end hook (Mintegral's window.gameEnd(), etc.).
    // Guarded by `started` so the muted poster-decode pass (paused on the first
    // frame in update()) can't trigger a premature completion.
    video.on(Phaser.GameObjects.Events.VIDEO_COMPLETE, () => {
      if (!this.started) return;
      this.videoEnded = true;
      video.setPaused(true);
      const duration = video.getDuration();
      if (Number.isFinite(duration) && duration > 0) {
        video.setCurrentTime(duration);
      }
      if (this.endcardAsset && this.endcardOverlay) {
        this.postRollClockStart = this.time.now;
        const t = this.getPlaybackTime();
        if (isEndcardVisible(this.endcardAsset, t, true)) {
          this.endcardOverlay.wasVisible = true;
          this.endcardOverlay.root.setVisible(true);
        }
        if (!this.getPostRollConfig()) {
          this.finishAd();
        }
        return;
      }
      this.finishAd();
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

    const layout =
      natW && natH
        ? stageLayout(this.orientation, W, H, natW / natH, this.frames())
        : null;
    this.adapted = layout?.adapted ?? null;
    // Unadapted: exactly as before (the video, contained, is the frame).
    this.videoRect = layout?.adapted ? layout.frame : containRect(natW, natH, W, H);
    const v = layout?.adapted ? layout.video : this.videoRect;
    this.video.setPosition(v.left + v.width / 2, v.top + v.height / 2);
    if (v.width && v.height) {
      this.video.setDisplaySize(v.width, v.height);
    }
    this.layoutFrameBackground(W, H);
  }

  /** Frames apply to single-video playclips only. */
  private frames(): OrientationFrames | null {
    const v = this.playclipData.video || ({} as PlayclipData['video']);
    if (v.portraitSrc && v.landscapeSrc && v.portraitSrc !== v.landscapeSrc) return null;
    return this.playclipData.layout?.frames || null;
  }

  // Fill the screen behind an adapted frame: a blurred, dimmed copy of the
  // video covering it, or a flat colour.
  private layoutFrameBackground(W: number, H: number): void {
    const a = this.adapted;
    const blur = a?.background === 'blur';
    if (a && !blur) {
      if (!this.frameColor) {
        this.frameColor = this.add.rectangle(0, 0, 1, 1, 0).setOrigin(0).setDepth(DEPTH_VIDEO - 1);
      }
      this.frameColor.setPosition(0, 0).setSize(W, H).setFillStyle(colorInt(a.backgroundColor)).setVisible(true);
    } else {
      this.frameColor?.setVisible(false);
    }
    const texture = this.video?.videoTexture;
    if (!blur || !texture) {
      this.frameBlur?.setVisible(false);
      return;
    }
    if (!this.frameBlur) {
      this.frameBlur = this.add.image(0, 0, texture).setDepth(DEPTH_VIDEO - 1).setTint(0xbfbfbf);
      // WebGL only; the Canvas renderer shows the dimmed copy unblurred.
      this.frameBlur.preFX?.addBlur(1, 2, 2, 1.5, 0xffffff, 8);
    }
    const tw = this.frameBlur.frame.realWidth || 1;
    const th = this.frameBlur.frame.realHeight || 1;
    const k = Math.max(W / tw, H / th) * 1.1;
    this.frameBlur.setPosition(W / 2, H / 2).setScale(k).setVisible(true);
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
      else if (asset.type === 'progress') overlay = this.buildProgress(asset);
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

  // Editor font sizes are px in video-bounds space; recover that width from
  // stored width % + style width when possible, else use a typical preview size.
  private designVideoBounds(
    asset: PlayclipAsset,
    orientation: Orientation,
    style: AssetStyle,
    rect: Rect,
  ): { width: number; height: number } {
    const wPct = this.widthPct(asset, orientation);
    const hPct = this.heightPct(asset, orientation);
    const styleW = firstNumber(style.width, 0);
    const styleH = firstNumber(style.height, 0);
    if (wPct && wPct > 0 && styleW > 0 && hPct && hPct > 0 && styleH > 0) {
      return { width: styleW / wPct, height: styleH / hPct };
    }

    const element = this.video?.video as HTMLVideoElement | undefined;
    const natW = element?.videoWidth || this.video?.width || 0;
    const natH = element?.videoHeight || this.video?.height || 0;
    const refGameW = orientation === 'portrait' ? 360 : 640;
    const refGameH = orientation === 'portrait' ? 640 : 360;
    if (this.adapted) {
      // An adapted frame has the design screen's shape in the editor too.
      const d = DESIGN_SCREEN[orientation];
      const ref = containRect(d.width, d.height, refGameW, refGameH);
      return { width: ref.width, height: ref.height };
    }
    if (natW && natH) {
      const ref = containRect(natW, natH, refGameW, refGameH);
      return { width: ref.width, height: ref.height };
    }
    return { width: rect.width || refGameW, height: rect.height || refGameH };
  }

  // Editor anchors the centre of a fixed box (style width/height or stored %).
  private textBoxDimensions(
    asset: PlayclipAsset,
    rect: Rect,
    orientation: Orientation,
    style: AssetStyle,
    scale: number,
  ): { width: number; height: number } {
    const wPct = this.widthPct(asset, orientation);
    const hPct = this.heightPct(asset, orientation);
    const styleW = firstNumber(style.width, 60);
    const styleH = firstNumber(style.height, 40);
    const width = wPct ? wPct * rect.width : styleW * scale;
    const height = hPct ? hPct * rect.height : styleH * scale;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  private layoutTextOverlay(
    text: Phaser.GameObjects.Text,
    asset: PlayclipAsset,
    rect: Rect,
    orientation: Orientation,
  ): void {
    const st = (pickOriented(asset.style, orientation) || {}) as AssetStyle;
    const design = this.designVideoBounds(asset, orientation, st, rect);
    const scale = design.width > 0 ? rect.width / design.width : 1;
    const baseFont = st.fontSize ?? 16;
    const fontSize = Math.max(1, baseFont * scale);

    const { x: padX, y: padY } = paddingXY(st.padding, 8, 12);
    const scaledPadX = padX * scale;
    const scaledPadY = padY * scale;
    const box = this.textBoxDimensions(asset, rect, orientation, st, scale);

    text.setText(asset.content || '');
    text.setStyle({
      fontFamily: st.fontFamily || 'Arial, sans-serif',
      fontSize: `${fontSize}px`,
      color: st.color || '#ffffff',
      fontStyle: fontStyleString(st),
      align: st.textAlign || 'center',
      backgroundColor: textBackgroundColor(st.backgroundColor),
    });
    text.setPadding(scaledPadX, scaledPadY, scaledPadX, scaledPadY);
    text.setWordWrapWidth(Math.max(1, box.width - scaledPadX * 2), true);
    text.setFixedSize(box.width, box.height);

    // Layer styles: native canvas text stroke/shadow (glyph-shaped, like the
    // editor's -webkit-text-stroke / text-shadow), gradient letters, FX glow.
    if (st.stroke) {
      const s = strokeOf(st.stroke);
      text.setStroke(s.color, s.width * scale);
    } else {
      text.setStroke('#000000', 0);
    }
    if (st.shadow) {
      const d = shadowOf(st.shadow);
      const o = shadowOffset(d.angle, d.distance * scale);
      text.setShadow(o.x, o.y, rgba(d.color, d.opacity), d.blur * scale, true, true);
    } else {
      text.setShadow(0, 0, '#000000', 0, false, false);
    }
    if (st.gradient) {
      const g = gradientOf(st.gradient);
      // Span the content area (inside the padding), like the editor's block span.
      const cw = Math.max(1, text.width - scaledPadX * 2);
      const ch = Math.max(1, text.height - scaledPadY * 2);
      const line = gradientLine(g.angle, cw, ch);
      const fill = text.context.createLinearGradient(
        scaledPadX + line.x0,
        scaledPadY + line.y0,
        scaledPadX + line.x1,
        scaledPadY + line.y1,
      );
      fill.addColorStop(0, g.from);
      fill.addColorStop(1, g.to);
      text.setFill(fill);
    }

    // Pivot on the anchor: move the origin there and shift the position so
    // the box stays where it was. Flip mirrors the texture in place.
    const c = this.centerOf(asset, rect, orientation);
    const { ax, ay } = anchorOf(st);
    const ox = (ax - 0.5) * text.displayWidth;
    const oy = (ay - 0.5) * text.displayHeight;
    text.setOrigin(ax, ay);
    text.setPosition(c.x + ox, c.y + oy);
    text.setAngle(st.rotation || 0);
    text.setFlipX(!!st.flipX);
    text.setFlipY(!!st.flipY);
    const overlay = this.overlays.find((o) => o.root === text);
    if (overlay) {
      overlay.anchorOffset = { x: ox, y: oy };
      this.syncStyleGlow(overlay, text, st.outerGlow, scale);
      this.layoutTextUnits(overlay, text, st as TextAnimatorStyle, fontSize);
    }
  }

  // Split the laid-out text into per-unit crops of its texture. Each line is
  // cut into contiguous spans at the units' starts (measured as Phaser draws
  // them), so together the crops are exactly the text's pixels — stroke,
  // shadow and gradient included.
  private layoutTextUnits(
    overlay: Overlay,
    text: Phaser.GameObjects.Text,
    st: TextAnimatorStyle,
    fontPx: number,
  ): void {
    overlay.textUnits?.container.destroy();
    overlay.textUnits = undefined;
    const preset = activeTextAnimator(st);
    if (!preset) return;
    const kind = TEXT_ANIMATORS[preset].unit;
    const style = text.style;
    const ctx = text.context;
    style.syncFont(text.canvas, ctx);
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = text.getWrappedText();
    const pad = {
      left: text.padding.left ?? 0,
      right: text.padding.right ?? 0,
      top: text.padding.top ?? 0,
    };
    const stroke = style.strokeThickness;
    // As GetTextSize: a space is taken off only when `style.wordWrap` is set.
    const wrapTrim = (style as unknown as { wordWrap?: unknown }).wordWrap ? measure(' ') : 0;
    const lineWidths = lines.map((l) => Math.ceil(stroke + measure(l) - wrapTrim));
    const maxLine = Math.max(0, ...lineWidths);
    const textWidth = style.fixedWidth
      ? Math.max(style.fixedWidth - pad.left - pad.right, maxLine)
      : maxLine;
    const lineHeight = style.getTextMetrics().fontSize + stroke + text.lineSpacing;
    const W = text.width;
    const H = text.height;
    const { originX, originY } = text;

    // A copy of the styled text to crop from. (Cropping the Text's own
    // texture doesn't work: its source keeps reporting 1×1, so crop UVs
    // come out as the whole texture.)
    const key = `text-units-${overlay.asset.id}`;
    const tex = this.styleCanvas(key, W, H);
    tex.context.drawImage(text.canvas, 0, 0, W, H);
    tex.refresh();

    const container = this.add.container(0, 0).setDepth(text.depth);
    const units: TextUnits['units'] = [];
    let n = 0;
    lines.forEach((line, li) => {
      const align = style.align === 'right' ? 1 : style.align === 'center' ? 0.5 : 0;
      const x0 = pad.left + stroke / 2 + (textWidth - lineWidths[li]) * align;
      const top = li === 0 ? 0 : pad.top + stroke / 2 + li * lineHeight;
      const bottom = li === lines.length - 1 ? H : pad.top + stroke / 2 + (li + 1) * lineHeight;
      // Unit starts on this line (x in texture px).
      const starts: number[] = [];
      // By code point, as the engine counts units (an emoji is one character).
      let k = 0;
      let prev = ' ';
      for (const ch of Array.from(line)) {
        const isStart = !/\s/.test(ch) && (kind === 'chars' || /\s/.test(prev));
        if (isStart) starts.push(x0 + measure(line.slice(0, k)));
        k += ch.length;
        prev = ch;
      }
      starts.forEach((sx, j) => {
        const left = j === 0 ? 0 : sx;
        const right = j === starts.length - 1 ? W : starts[j + 1];
        const img = this.add.image(0, 0, key);
        img.setCrop(left, top, right - left, bottom - top);
        // Origin at the unit's centre so it scales in place; positioned in
        // the text's local space (the container carries its transform).
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;
        img.setOrigin(cx / W, cy / H);
        const y = cy - originY * H;
        img.setPosition(cx - originX * W, y);
        container.add(img);
        units.push({ img, i: n++, y });
      });
    });
    container.setVisible(false);
    if (this.cropMask) container.setMask(this.cropMask);
    overlay.textUnits = { container, units, n, fontPx, style: st };
  }

  // Pose a text's units for this frame, standing in for the text itself.
  private animateTextUnits(overlay: Overlay, since: number): void {
    const tu = overlay.textUnits;
    if (!tu) return;
    const text = overlay.root as Phaser.GameObjects.Text;
    if (textAnimatorDone(tu.style, tu.n, since)) {
      tu.container.setVisible(false);
      return;
    }
    tu.container
      .setVisible(true)
      .setPosition(text.x, text.y)
      .setAngle(text.angle)
      .setScale(text.scaleX * (text.flipX ? -1 : 1), text.scaleY * (text.flipY ? -1 : 1))
      .setAlpha(text.alpha);
    text.setAlpha(0);
    for (const u of tu.units) {
      const s = sampleTextUnit(tu.style, u.i, tu.n, since);
      u.img.setAlpha(s.opacity).setScale(s.scale).setY(u.y + s.y * tu.fontPx);
    }
  }

  // Outer glow for text via the Glow FX (WebGL); its radius is fixed when
  // created, so recreate it when the colour or size changes.
  private syncStyleGlow(
    overlay: Overlay,
    target: Phaser.GameObjects.Text,
    glow: GlowStyle | undefined,
    k: number,
  ): void {
    const fx = target.preFX;
    if (!fx) return;
    const g = glow ? glowOf(glow) : undefined;
    const key = g ? `${g.color}|${Math.round(g.size * k)}` : '';
    if (overlay.styleGlowKey !== key) {
      if (overlay.styleGlowFx) fx.remove(overlay.styleGlowFx);
      overlay.styleGlowFx = g
        ? fx.addGlow(colorInt(g.color), 0, 0, false, 0.1, Math.max(1, Math.round(g.size * k)))
        : undefined;
      overlay.styleGlowKey = key;
    }
    if (overlay.styleGlowFx && g) overlay.styleGlowFx.outerStrength = 2 * g.opacity;
  }

  // A canvas texture for an overlay's styled drawing, reused across layouts.
  private styleCanvas(key: string, w: number, h: number): Phaser.Textures.CanvasTexture {
    const width = Math.max(1, Math.ceil(w));
    const height = Math.max(1, Math.ceil(h));
    let tex = this.textures.exists(key)
      ? (this.textures.get(key) as Phaser.Textures.CanvasTexture)
      : this.textures.createCanvas(key, width, height)!;
    if (tex.width !== width || tex.height !== height) tex.setSize(width, height);
    tex.context.clearRect(0, 0, width, height);
    return tex;
  }

  private buildText(asset: PlayclipAsset): Overlay {
    const style = (pickOriented(asset.style, this.orientation) || {}) as AssetStyle;
    const text = this.add
      .text(0, 0, asset.content || '', {
        fontFamily: style.fontFamily || 'Arial, sans-serif',
        fontSize: `${style.fontSize ?? 16}px`,
        color: style.color || '#ffffff',
        fontStyle: fontStyleString(style),
        align: style.textAlign || 'center',
        backgroundColor: textBackgroundColor(style.backgroundColor),
      })
      .setOrigin(0.5)
      .setDepth(layerOf(asset));

    return {
      asset,
      root: text,
      clicked: false,
      wasVisible: false,
      appearedAt: 0,
      designScale: 1,
      layout: (rect, orientation) => this.layoutTextOverlay(text, asset, rect, orientation),
    };
  }

  private buildImage(asset: PlayclipAsset): Overlay {
    const key = `img-${asset.id}`;
    const image = this.textures.exists(key)
      ? this.add.image(0, 0, key)
      : this.add.image(0, 0, '__MISSING');
    image.setOrigin(0.5).setDepth(layerOf(asset));

    const overlay: Overlay = {
      asset,
      root: image,
      clicked: false,
      wasVisible: false,
      appearedAt: 0,
      designScale: 1,
      layout: (rect, orientation) => {
        // Start from the source texture: a previous layout may have swapped in
        // a styled (shadow/glow) canvas.
        image.setTexture(this.textures.exists(key) ? key : '__MISSING');
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

        // Pivot on the anchor (see layoutTextOverlay).
        const c = this.centerOf(asset, rect, orientation);
        const st = (pickOriented(asset.style, orientation) || {}) as AssetStyle;
        const { ax, ay } = anchorOf(st);
        const boxW = image.displayWidth;
        const boxH = image.displayHeight;
        const ox = (ax - 0.5) * boxW;
        const oy = (ay - 0.5) * boxH;

        // Layer styles: redraw the image with its shadow/glow into a padded
        // canvas (alpha-shaped, like the editor's filter: drop-shadow).
        overlay.hitSize = undefined;
        if ((st.shadow || st.outerGlow) && this.textures.exists(key)) {
          const design = this.designVideoBounds(asset, orientation, st, rect);
          const k = design.width > 0 ? rect.width / design.width : 1;
          // Image shadows are drop-shadows in the editor: blur is a std. deviation.
          const blurK = k * DROP_SHADOW_BLUR_SCALE;
          const pad = stylePadding(st, k, DROP_SHADOW_BLUR_SCALE);
          const tex = this.styleCanvas(`fx-${key}`, boxW + pad * 2, boxH + pad * 2);
          const ctx = tex.context;
          const src = this.textures.get(key).getSourceImage() as CanvasImageSource;
          const drawAt = (target: CanvasRenderingContext2D, dx: number) =>
            target.drawImage(src, pad + dx, pad, boxW, boxH);
          if (st.outerGlow) {
            const g = glowOf(st.outerGlow);
            shadowPass(ctx, rgba(g.color, g.opacity), g.size * blurK, 0, 0, drawAt);
          }
          if (st.shadow) {
            const d = shadowOf(st.shadow);
            const o = shadowOffset(d.angle, d.distance * k);
            shadowPass(ctx, rgba(d.color, d.opacity), d.blur * blurK, o.x, o.y, drawAt);
          }
          drawAt(ctx, 0);
          tex.refresh();
          image.setTexture(tex.key);
          image.setDisplaySize(tex.width, tex.height);
          image.setOrigin((pad + ax * boxW) / tex.width, (pad + ay * boxH) / tex.height);
          overlay.hitSize = { w: boxW, h: boxH };
        } else {
          image.setOrigin(ax, ay);
        }
        image.setPosition(c.x + ox, c.y + oy);
        image.setAngle(st.rotation || 0);
        image.setFlipX(!!st.flipX);
        image.setFlipY(!!st.flipY);
        overlay.anchorOffset = { x: ox, y: oy };
      },
    };
    return overlay;
  }

  private buildButton(asset: PlayclipAsset): Overlay {
    // Outer container sits on the anchor and takes rotation/scale (so they pivot
    // there); the inner box holds the drawing, offset back to the centre, and
    // takes the flip (so mirroring never moves the button).
    const container = this.add.container(0, 0).setDepth(layerOf(asset));
    const box = this.add.container(0, 0);
    const graphics = this.add.graphics();
    // Canvas-drawn background, used instead of `graphics` when the button has
    // layer styles (shadow, glow, gradient).
    let styledBg: Phaser.GameObjects.Image | undefined;
    const label = this.add.text(0, 0, asset.content || '', { fontSize: '20px' }).setOrigin(0.5);
    box.add([graphics, label]);
    container.add(box);

    const overlay: Overlay = {
      asset,
      root: container,
      clicked: false,
      wasVisible: false,
      appearedAt: 0,
      designScale: 1,
      layout: (rect, orientation) => {
        const st = (pickOriented(asset.style, orientation) || {}) as AssetStyle;

        label.setText(asset.content || '');
        label.setStyle({
          fontFamily: st.fontFamily || 'Arial, sans-serif',
          fontSize: `${st.fontSize || 20}px`,
          color: st.color || '#ffffff',
          fontStyle: fontStyleString(st),
        });
        if (st.stroke) {
          const sk = strokeOf(st.stroke);
          label.setStroke(sk.color, sk.width);
        } else {
          label.setStroke('#000000', 0);
        }

        const padX = firstNumber(st.padding, 16) || 16;
        const padY = Math.max(8, padX * 0.6);
        const wPct = this.widthPct(asset, orientation);
        const hPct = this.heightPct(asset, orientation);
        const bw = wPct ? wPct * rect.width : label.width + padX * 2;
        const bh = hPct ? hPct * rect.height : label.height + padY * 2;
        const radius = firstNumber(st.borderRadius, 8);

        graphics.clear();
        const fillColor = cssColorToInt(st.backgroundColor) ?? 0x6d28d9;
        const borderColor = cssColorToInt(st.borderColor);
        const borderWidth = firstNumber(st.borderWidth, 2);
        if (st.shadow || st.outerGlow || st.gradient) {
          // Layer styles: draw glow → shadow → fill (colour or gradient) →
          // border into a padded canvas; canvas shadows follow CSS box-shadow.
          const pad = stylePadding(st, 1);
          const tex = this.styleCanvas(`fx-btn-${asset.id}`, bw + pad * 2, bh + pad * 2);
          const ctx = tex.context;
          const shape = (target: CanvasRenderingContext2D, dx: number) => {
            roundRectPath(target, pad + dx, pad, bw, bh, radius);
            target.fillStyle = '#000';
            target.fill();
          };
          if (st.outerGlow) {
            const g = glowOf(st.outerGlow);
            shadowPass(ctx, rgba(g.color, g.opacity), g.size, 0, 0, shape);
          }
          if (st.shadow) {
            const d = shadowOf(st.shadow);
            const o = shadowOffset(d.angle, d.distance);
            shadowPass(ctx, rgba(d.color, d.opacity), d.blur, o.x, o.y, shape);
          }
          roundRectPath(ctx, pad, pad, bw, bh, radius);
          if (st.gradient) {
            const g = gradientOf(st.gradient);
            const line = gradientLine(g.angle, bw, bh);
            const fill = ctx.createLinearGradient(
              pad + line.x0,
              pad + line.y0,
              pad + line.x1,
              pad + line.y1,
            );
            fill.addColorStop(0, g.from);
            fill.addColorStop(1, g.to);
            ctx.fillStyle = fill;
          } else {
            ctx.fillStyle = st.backgroundColor || '#6d28d9';
          }
          ctx.fill();
          if (borderColor !== undefined) {
            ctx.lineWidth = borderWidth;
            ctx.strokeStyle = st.borderColor!;
            ctx.stroke();
          }
          tex.refresh();
          if (!styledBg) {
            styledBg = this.add.image(0, 0, tex.key);
            box.addAt(styledBg, 0);
          }
          styledBg.setTexture(tex.key).setOrigin(0.5).setVisible(true);
        } else {
          styledBg?.setVisible(false);
          graphics.fillStyle(fillColor, 1);
          graphics.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);
          if (borderColor !== undefined) {
            graphics.lineStyle(borderWidth, borderColor, 1);
            graphics.strokeRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);
          }
        }

        const c = this.centerOf(asset, rect, orientation);
        const { ax, ay } = anchorOf(st);
        const ox = (ax - 0.5) * bw;
        const oy = (ay - 0.5) * bh;
        container.setPosition(c.x + ox, c.y + oy);
        container.setSize(bw, bh);
        container.setAngle(st.rotation || 0);
        container.setScale(1, 1);
        box.setPosition(-ox, -oy);
        // Containers have no setFlipX/Y, so mirror the inner box via signed scale.
        box.setScale(st.flipX ? -1 : 1, st.flipY ? -1 : 1);
        overlay.anchorOffset = { x: ox, y: oy };

        // Keep an up-to-date hit area; the actual click is dispatched centrally
        // from onPointerDown (so the first tap can be reserved for "start").
        const hit = new Phaser.Geom.Rectangle(-bw / 2 - ox, -bh / 2 - oy, bw, bh);
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
    const container = this.add.container(0, 0).setDepth(layerOf(asset));

    return {
      asset,
      root: container,
      clicked: false,
      wasVisible: false,
      appearedAt: 0,
      designScale: 1,
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

  // A progress bar: a track with a fill drawn from its counter every frame
  // (update() → drawFill; animation/vars.ts). Taps pass through it.
  private buildProgress(asset: PlayclipAsset): Overlay {
    const container = this.add.container(0, 0).setDepth(layerOf(asset));
    const g = this.add.graphics();
    container.add(g);
    let w = 0;
    let h = 0;
    let st: AssetStyle = {};
    let drawn = -1;
    const draw = (fill: number) => {
      if (fill === drawn) return;
      drawn = fill;
      const r = Math.min(firstNumber(st.borderRadius, 999), h / 2);
      const track = colorAndAlpha(st.backgroundColor || PROGRESS_DEFAULTS.track);
      const bar = colorAndAlpha(st.color || PROGRESS_DEFAULTS.fill);
      g.clear();
      g.fillStyle(track.color, track.alpha);
      g.fillRoundedRect(-w / 2, -h / 2, w, h, r);
      const fw = w * fill;
      if (fw > 0) {
        g.fillStyle(bar.color, bar.alpha);
        g.fillRoundedRect(-w / 2, -h / 2, fw, h, Math.min(r, fw / 2));
      }
    };
    return {
      asset,
      root: container,
      clicked: false,
      wasVisible: false,
      appearedAt: 0,
      designScale: 1,
      drawFill: draw,
      layout: (rect, orientation) => {
        st = (pickOriented(asset.style, orientation) || {}) as AssetStyle;
        const design = this.designVideoBounds(asset, orientation, st, rect);
        const k = design.width > 0 ? rect.width / design.width : 1;
        const wPct = this.widthPct(asset, orientation);
        const hPct = this.heightPct(asset, orientation);
        w = wPct ? wPct * rect.width : firstNumber(st.width, 200) * k;
        h = hPct ? hPct * rect.height : firstNumber(st.height, 20) * k;
        const c = this.centerOf(asset, rect, orientation);
        container.setPosition(c.x, c.y);
        container.setSize(w, h);
        container.setAngle(st.rotation || 0);
        const f = drawn < 0 ? 0 : drawn;
        drawn = -1;
        draw(f);
      },
    };
  }

  // Full-screen post-roll overlay shown when the clip ends (or within its time
  // window). Background color lives in `content`; optional image in `imageUrl`.
  // Color is always drawn first so transparent PNG regions match the editor.
  private buildEndcard(asset: PlayclipAsset): Overlay {
    const container = this.add.container(0, 0).setDepth(layerOf(asset));
    const imageKey = asset.imageUrl ? `endcard-${asset.id}` : undefined;
    const bgGraphics = this.add.graphics();
    container.add(bgGraphics);

    const bgImage =
      imageKey && this.textures.exists(imageKey)
        ? this.add.image(0, 0, imageKey).setOrigin(0, 0)
        : undefined;
    if (bgImage) {
      container.add(bgImage);
    }

    return {
      asset,
      root: container,
      clicked: false,
      wasVisible: false,
      appearedAt: 0,
      designScale: 1,
      layout: (rect, _orientation) => {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        container.setPosition(cx, cy);
        container.setSize(rect.width, rect.height);

        const color = cssColorToInt(asset.content || '#667eea') ?? 0x667eea;
        bgGraphics.clear();
        bgGraphics.fillStyle(color, 1);
        bgGraphics.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);

        if (bgImage) {
          bgImage.setPosition(-rect.width / 2, -rect.height / 2);
          bgImage.setDisplaySize(rect.width, rect.height);
        }
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
      (overlay.asset.type === 'image' && hasActions(overlay.asset))
    );
  }

  private hasVisiblePlayableOverlay(time: number): boolean {
    for (const overlay of this.overlays) {
      if (!this.isInteractive(overlay) || overlay.clicked) continue;
      const start = overlay.asset.time;
      const end = overlay.asset.endTime || overlay.asset.time + 5;
      if (time < start || time > end) continue;
      const node = overlay.root as unknown as { visible: boolean };
      if (!node.visible) continue;
      return true;
    }
    return false;
  }

  private isEndcardClickable(time: number): boolean {
    if (!this.endcardAsset || !this.endcardOverlay) return false;
    const root = this.endcardOverlay.root as unknown as { visible: boolean };
    if (!root.visible) return false;
    if (!this.videoReady || !this.video) return false;
    if (!this.video.isPaused() && !this.videoEnded) return false;
    if (!isEndcardVisible(this.endcardAsset, time, this.videoEnded)) return false;
    if (!this.videoEnded && this.hasVisiblePlayableOverlay(time)) return false;
    return true;
  }

  private pointerHitsVideoRect(px: number, py: number): boolean {
    const r = this.videoRect;
    return (
      px >= r.left &&
      px <= r.left + r.width &&
      py >= r.top &&
      py <= r.top + r.height
    );
  }

  private activateEndcard(): void {
    track('ctaCall', { element_id: 'endcard' });
    sdk.install();
    this.finishAd();
  }

  // Single entry point for all taps. The very first tap anywhere only starts
  // the ad; later taps are routed to whatever interactive overlay was hit.
  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    this.idleHints.input(this.time.now);
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
    const overlay = this.overlayAt(px, py);
    if (overlay) {
      // Hold, swipe and drag need the whole press; plain taps fire at once.
      if (needsPress(overlay.asset)) {
        this.startPress(overlay, px, py);
      } else {
        const count = this.tapCounter.tap(overlay.asset.id, this.time.now);
        this.activateButton(overlay, { kind: 'tap', count });
      }
      return;
    }

    const t = this.getPlaybackTime();
    if (this.isEndcardClickable(t) && this.pointerHitsVideoRect(px, py)) {
      this.activateEndcard();
    }
  }

  // The interactive overlay under (px, py), hit-tested against each overlay's
  // actual drawn rectangle (centre ± half its display size) rather than
  // Phaser's `currentlyOver`. A button is a Container whose only sized child
  // is a Graphics object, which reports no measurable bounds — so relying on
  // the container's auto hit area / getBounds() leaves the clickable region
  // not matching what's drawn. Both Containers and Images are centre-origin,
  // so centre ± displayWidth/2 covers each case uniformly.
  private overlayAt(px: number, py: number): Overlay | null {
    for (const overlay of this.overlays) {
      if (!this.isInteractive(overlay) || overlay.clicked) continue;
      if (this.overlayContains(overlay, px, py)) return overlay;
    }
    return null;
  }

  private overlayContains(overlay: Overlay, px: number, py: number): boolean {
    const node = overlay.root as unknown as {
      x: number;
      y: number;
      displayWidth: number;
      displayHeight: number;
      visible: boolean;
    };
    if (!node.visible) return false;
    const halfW = (overlay.hitSize?.w ?? Math.abs(node.displayWidth)) / 2;
    const halfH = (overlay.hitSize?.h ?? Math.abs(node.displayHeight)) / 2;
    const cx = node.x - (overlay.anchorOffset?.x ?? 0);
    const cy = node.y - (overlay.anchorOffset?.y ?? 0);
    return (
      px >= cx - halfW &&
      px <= cx + halfW &&
      py >= cy - halfH &&
      py <= cy + halfH
    );
  }

  private startPress(overlay: Overlay, px: number, py: number): void {
    this.endPress();
    const p = new Press(px, py, this.time.now);
    const timers = holdTimes(overlay.asset).map((ms) =>
      this.time.delayedCall(ms, () => {
        if (this.press?.p !== p || !p.still) return;
        p.held = true;
        this.activateButton(overlay, { kind: 'hold', ms });
      }),
    );
    this.press = { overlay, p, timers };
  }

  private endPress(): void {
    this.press?.timers.forEach((t) => t.remove());
    this.press = null;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const press = this.press;
    if (!press) return;
    press.p.move(pointer.worldX, pointer.worldY, this.time.now);
    if (dropZoneOf(press.overlay.asset) && !press.p.still)
      press.overlay.drag = { x: press.p.dx, y: press.p.dy };
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    const press = this.press;
    if (!press) return;
    this.endPress();
    const { overlay, p } = press;
    const px = pointer.worldX;
    const py = pointer.worldY;
    const result = p.end(px, py, this.time.now);
    const zoneId = dropZoneOf(overlay.asset);
    if (zoneId && !p.still) {
      const zone = this.overlays.find((o) => o.asset.id === zoneId);
      const over = !!zone && this.overlayContains(zone, px, py);
      // Dropped: it stays there until it leaves its window.
      if (!over || !this.activateButton(overlay, { kind: 'drop', zoneId }))
        overlay.drag = undefined;
      return;
    }
    if (result?.kind === 'tap') {
      const count = this.tapCounter.tap(overlay.asset.id, this.time.now);
      this.activateButton(overlay, { kind: 'tap', count });
    } else if (result?.kind === 'swipe') {
      this.activateButton(overlay, result);
    }
  }

  private startPlayback(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.time.now;
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

  // Run what `gesture` does on the overlay; true if anything ran.
  private activateButton(
    overlay: Overlay,
    gesture: GestureEvent,
    depth = 0,
  ): boolean {
    // A button with no interactions at all behaves as 'play' (as before).
    const actions: Action[] = interactionsOf(overlay.asset).length
      ? actionsFor(overlay.asset, gesture)
      : gesture.kind === 'tap'
        ? [{ kind: 'play' }]
        : [];
    if (!actions.length) return false;

    // Debounce a single appearance of the button; this is re-armed in update()
    // once the button leaves its time window (so it can be pressed again if its
    // range comes back around). It does NOT drive visibility — see update().
    // A counter tap leaves it armed so it can be tapped again and again.
    const moves = movesPlayback(actions);
    if (moves) overlay.clicked = true;

    const v = this.video;
    if (gesture.kind !== 'idle' && gesture.kind !== 'var')
      track(actions.some((a) => a.kind === 'cta') ? 'ctaCall' : 'click', {
        element_id: overlay.asset.id,
        element_content: overlay.asset.content,
      });

    // Pressing any button breaks out of an active freeze and resumes playback.
    // The freeze stays in triggeredFreezes so it won't immediately re-trap as the
    // playhead plays back out through its window.
    if (moves && this.currentFreeze && v) {
      this.currentFreeze = null;
      v.setPaused(false);
    }

    runActions(actions, {
      // A counter change fires what it reaches on overlays on screen
      // (depth-capped, in case counters set each other in a loop).
      setVar: (a) => {
        const c = this.vars.apply(a);
        if (!c || depth >= 8) return;
        for (const o of this.overlays)
          if (o.wasVisible) this.activateButton(o, { kind: 'var', ...c }, depth + 1);
      },
      seek: (t) => {
        if (!v) return;
        // Seeking outside an active loop/jump breaks out of it (mirrors the
        // HTML runtime's handleButtonClick loop-breakout behaviour).
        if (
          this.currentLoop &&
          (t < this.currentLoop.startTime || t > this.currentLoop.endTime)
        ) {
          this.currentLoop = null;
        }
        this.currentJump = null;
        this.seekSrc(v, t);
        // Re-baseline so the seek isn't read as a frame-by-frame freeze crossing.
        this.lastFreezeTime = t;
        v.setPaused(false);
      },
      cta: () => {
        // Hand off to the network SDK's store routing. Per-playable store links
        // are baked into build.json at build time.
        sdk.install();
        // A CTA press also completes the playable — signal end so networks that
        // wait for it (e.g. Mintegral's window.gameEnd()) are notified even when
        // the user converts before the clip plays out.
        this.finishAd();
      },
      play: () => {
        // Advance so the video continues past the button. If a loop is holding
        // the playhead inside the button's window, break out of it by seeking
        // just past the loop end — otherwise it would re-engage at once and the
        // button would never leave its time window.
        if (!v) return;
        if (this.currentLoop) {
          const resumeAt = this.currentLoop.endTime + 0.001;
          this.currentLoop = null;
          // Past the loop end, so also past a ping-pong loop's reversed copy.
          this.seekSrc(v, resumeAt);
          // Re-baseline so the loop-breakout seek isn't read as a freeze crossing.
          this.lastFreezeTime = resumeAt;
        }
        this.currentJump = null;
        v.setPaused(false);
      },
    });
    return true;
  }

  // --- Audio playback -----------------------------------------------------

  private applyAudio(t: number): void {
    if (!this.started) return;

    const v = this.video;
    const isFrozen = !!this.currentFreeze;
    const videoPaused = v?.isPaused() ?? true;

    // Find the first audio asset whose time window covers the current playhead.
    const activeAsset = this.audioAssets.find(
      (a) => t >= a.time && t <= (a.endTime || a.time + 5),
    ) ?? null;

    if (activeAsset) {
      const activeEl = this.audioElements.get(activeAsset.id);
      if (!activeEl) return;

      // Stop any other audio that might be playing.
      this.audioElements.forEach((el, id) => {
        if (id !== activeAsset.id && !el.paused) {
          el.pause();
          el.currentTime = 0;
        }
      });

      // Mute/unmute the video based on the active audio's muteVideo flag (default: mute).
      // If the active audio opts out, restore the video even if we had muted it earlier.
      if (activeAsset.audioAction?.muteVideo !== false) {
        if (!this.videoMutedForAudio) {
          v?.setMute(true);
          this.videoMutedForAudio = true;
        }
      } else if (this.videoMutedForAudio) {
        v?.setMute(false);
        this.videoMutedForAudio = false;
      }

      this.currentAudioId = activeAsset.id;
      // Keep volume and playback rate in sync with the asset value (may have changed).
      activeEl.volume = (activeAsset.audioAction as AudioAction | undefined)?.volume ?? 0.5;
      activeEl.playbackRate = (activeAsset.audioAction as AudioAction | undefined)?.speed ?? 1;

      // Play when the video is running, or when frozen and playDuringFreeze is on.
      const shouldPlay =
        !videoPaused || (isFrozen && activeAsset.audioAction?.playDuringFreeze === true);

      if (shouldPlay && activeEl.paused) {
        const audioOffset = t - activeAsset.time;
        if (audioOffset > 0 && isFinite(activeEl.duration) && audioOffset < activeEl.duration) {
          activeEl.currentTime = audioOffset;
        }
        activeEl.play().catch(() => {});
      } else if (!shouldPlay && !activeEl.paused) {
        activeEl.pause();
      }
    } else {
      // Nothing should be playing — stop all audio and restore video audio.
      this.audioElements.forEach((el) => {
        if (!el.paused) {
          el.pause();
          el.currentTime = 0;
        }
      });
      this.currentAudioId = null;

      if (this.videoMutedForAudio) {
        v?.setMute(false);
        this.videoMutedForAudio = false;
      }
    }
  }

  // --- Per-frame & resize -------------------------------------------------

  /** The video's position in source time (and whether it runs backwards). */
  private srcTime(v: Phaser.GameObjects.Video) {
    return toSourceTime(v.getCurrentTime(), this.pingPong);
  }

  /** Seek to a source time (on the forward pass). */
  private seekSrc(v: Phaser.GameObjects.Video, t: number): void {
    v.setCurrentTime(toVideoTime(t, this.pingPong));
  }

  private getPostRollConfig(): PostRollConfig | null {
    if (!this.endcardAsset || !this.video) return null;
    const duration = sourceDuration(this.video.getDuration(), this.pingPong);
    const videoDuration =
      Number.isFinite(duration) && duration > 0
        ? duration
        : this.endcardAsset.time;
    return getPostRollConfig(this.endcardAsset, videoDuration);
  }

  /** Timeline clock for overlay visibility (includes synthetic post-roll time). */
  private getPlaybackTime(): number {
    const videoTime = this.video ? this.srcTime(this.video).time : 0;
    if (!this.videoEnded) return videoTime;
    const postRoll = this.getPostRollConfig();
    const elapsed = (this.time.now - this.postRollClockStart) / 1000;
    return computePlaybackTime(videoTime, this.videoEnded, postRoll, elapsed);
  }

  update(): void {
    const v = this.video;
    const ready = !!v && this.videoReady;

    if (!this.started) {
      // Poster: let the first frame decode, then hold it until the first tap.
      if (ready && !this.posterHeld && v!.getCurrentTime() > 0) {
        v!.setPaused(true);
        this.posterHeld = true;
      }
    } else if (ready && !this.videoEnded) {
      // A freeze holds the playhead until a button breaks out of it; while held,
      // don't let loops/jumps move it. Otherwise loops/jumps may seek the
      // playhead before we evaluate visibility.
      if (!this.currentFreeze) this.applyLoopsAndJumps(v!);
      this.applyFreezes(v!);
    }

    const postRoll = this.videoEnded ? this.getPostRollConfig() : null;
    const t = this.getPlaybackTime();

    if (
      this.videoEnded &&
      postRoll &&
      isPostRollComplete(t, postRoll) &&
      !this.finished
    ) {
      this.finishAd();
    }

    this.applyAudio(t);

    for (const overlay of this.overlays) {
      const start = overlay.asset.time;
      const end = overlay.asset.endTime || overlay.asset.time + 5;
      const inWindow = t >= start && t <= end;

      // Entry, loop and exit all happen inside the asset's window (the exit
      // plays in its last animationDuration), so visibility is just the window
      // (an idle hint also waits until nothing has been touched for a while).
      const idleMs = idleMsOf(overlay.asset);
      const idle =
        idleMs === null
          ? null
          : this.idleHints.step(
              overlay.asset.id,
              inWindow && this.started,
              idleMs,
              this.time.now,
            );
      const within = idle ? idle.visible : inWindow;
      if (within && !overlay.wasVisible) {
        overlay.wasVisible = true;
        overlay.appearedAt = this.time.now;
        overlay.root.setVisible(true);
      } else if (!within && overlay.wasVisible) {
        overlay.wasVisible = false;
        overlay.drag = undefined; // a dropped overlay snaps back
        overlay.root.setVisible(false);
        overlay.textUnits?.container.setVisible(false);
      }
      if (overlay.wasVisible) this.animateOverlay(overlay, t, end);
      if (overlay.wasVisible && overlay.drawFill && overlay.asset.progress) {
        const p = overlay.asset.progress;
        overlay.drawFill(fillOf(this.vars.get(p.variable), p.max));
      }
      if (idle?.fire) this.activateButton(overlay, { kind: 'idle' });

      // Re-arm an interactive overlay once it leaves its window so it can be
      // pressed again if its time range comes back around (e.g. a looping intro).
      if (this.isInteractive(overlay) && !within) overlay.clicked = false;
    }

    this.updateEndcardVisibility(t);
  }

  // --- Animation -----------------------------------------------------------

  private captureBase(overlay: Overlay): void {
    const r = overlay.root;
    overlay.base = { x: r.x, y: r.y, scaleX: r.scaleX, scaleY: r.scaleY, angle: r.angle };
    const style = (pickOriented(overlay.asset.style, this.orientation) || {}) as AssetStyle;
    const design = this.designVideoBounds(overlay.asset, this.orientation, style, this.videoRect);
    overlay.designScale = design.width > 0 ? this.videoRect.width / design.width : 1;
  }

  // Apply the shared animation engine's sample for this frame (see
  // ./animation/sample.ts — the same code drives the editor and preview).
  private animateOverlay(overlay: Overlay, t: number, end: number): void {
    const base = overlay.base;
    if (!base) return;
    const style = pickOriented(overlay.asset.style, this.orientation) as AnimStyle | undefined;
    // Before the first tap the ad shows a poster: hold animations at frame 0.
    const since = this.started
      ? Math.max(0, (this.time.now - Math.max(overlay.appearedAt, this.startedAt)) / 1000)
      : 0;
    const s = sampleAnimation(style, { sinceStart: since, untilEnd: end - t }, overlay.asset.id);
    const k = overlay.designScale;
    const root = overlay.root;
    const drag = overlay.drag;
    root.setPosition(
      base.x + s.x * k + (drag?.x ?? 0),
      base.y + s.y * k + (drag?.y ?? 0),
    );
    root.setScale(base.scaleX * s.scale, base.scaleY * s.scale);
    root.setAngle(base.angle + s.rotation);
    root.setAlpha(s.opacity);
    this.applyGlow(overlay, s.glow);
    this.animateTextUnits(overlay, since);
  }

  private applyGlow(overlay: Overlay, amount: number): void {
    if (overlay.glow === null) return; // renderer has no FX (Canvas)
    if (!overlay.glow) {
      if (amount <= 0) return;
      const fx = overlay.root.preFX ?? overlay.root.postFX;
      overlay.glow = fx ? fx.addGlow(GLOW_COLOR, 0, 0, false) : null;
      if (!overlay.glow) return;
    }
    overlay.glow.outerStrength = amount * GLOW_STRENGTH;
  }

  private updateEndcardVisibility(time: number): void {
    if (!this.endcardAsset || !this.endcardOverlay) return;

    const shouldShow = isEndcardVisible(this.endcardAsset, time, this.videoEnded);
    const overlay = this.endcardOverlay;

    if (shouldShow && !overlay.wasVisible) {
      overlay.wasVisible = true;
      overlay.root.setVisible(true);
    } else if (!shouldShow && overlay.wasVisible) {
      overlay.wasVisible = false;
      overlay.root.setVisible(false);
      if (this.videoEnded && !this.finished) {
        this.finishAd();
      }
    }
  }

  // Loops repeat a segment; jumps skip a segment. Loop takes precedence.
  // Mirrors the playclip HTML runtime's checkLoops/checkJumps behaviour.
  private applyLoopsAndJumps(v: Phaser.GameObjects.Video): void {
    const now = this.srcTime(v);
    const t = now.time;
    const bakedIndex = (l: Control) =>
      isPingPong(l)
        ? this.pingPong.findIndex(
            (s) => s.startTime === l.startTime && s.endTime === l.endTime,
          )
        : -1;

    // Never play a reversed copy outside its own active loop (e.g. reaching it
    // after the loop was broken): skip to just past it.
    if (now.reversing && !(this.currentLoop && bakedIndex(this.currentLoop) === now.segment)) {
      this.seekSrc(v, this.pingPong[now.segment].endTime + 0.001);
      return;
    }

    if (this.currentLoop) {
      const seg = bakedIndex(this.currentLoop);
      if (seg >= 0) {
        // Ping-pong: forward runs straight on into the reversed copy; at the
        // end of that, start the forward pass again.
        if (v.getCurrentTime() >= reverseEndVideoTime(this.pingPong, seg) - 0.02) {
          this.seekSrc(v, this.currentLoop.startTime + 0.001);
          return;
        }
      } else if (t >= this.currentLoop.endTime - 0.02) {
        this.seekSrc(v, this.currentLoop.startTime + 0.001);
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
        this.seekSrc(v, found.endTime + 0.001);
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
    const t = this.srcTime(v).time;
    const prev = this.lastFreezeTime;
    this.lastFreezeTime = t;

    // Loops and jumps take priority over freezes.
    if (this.currentLoop || this.currentJump) return;

    if (this.currentFreeze) {
      // A freeze holds at its startTime; release only once the playhead has moved
      // outside that hold window (e.g. a seek action). Otherwise keep it held.
      if (
        t < this.currentFreeze.startTime - 0.001 ||
        t > this.currentFreeze.startTime + 0.1
      ) {
        this.currentFreeze = null;
      } else if (!v.isPaused()) {
        v.setPaused(true);
      }
      return;
    }

    // Re-arm freezes once the playhead has left their hold window.
    this.freezes.forEach((f) => {
      if (
        this.triggeredFreezes.has(f.id) &&
        (t < f.startTime - 0.001 || t > f.startTime + 0.1)
      ) {
        this.triggeredFreezes.delete(f.id);
      }
    });

    // Stop at the first not-yet-triggered freeze the playhead has reached or
    // crossed since the last frame (so a frame that jumps past it still stops
    // instead of skipping), seeking back to the exact freeze frame to hold it.
    const found = this.freezes.find(
      (f) =>
        !this.triggeredFreezes.has(f.id) &&
        t >= f.startTime - 0.001 &&
        prev < f.startTime - 0.001,
    );
    if (found) {
      this.currentFreeze = found;
      this.triggeredFreezes.add(found.id);
      if (Math.abs(t - found.startTime) > 0.001) {
        this.seekSrc(v, found.startTime);
        this.lastFreezeTime = found.startTime;
      }
      v.setPaused(true);
    }
  }

  private relayout = (): void => {
    this.orientation = this.computeOrientation();
    this.maybeSwapVideoSource();
    this.layoutVideo();
    this.overlays.forEach((overlay) => {
      // Layout sets position/size/angle; reset what it may leave untouched
      // (Text has no layout-driven scale) so the captured base is clean.
      overlay.root.setScale(1, 1);
      overlay.root.setAlpha(1);
      overlay.layout(this.videoRect, this.orientation);
      this.captureBase(overlay);
    });
    this.endcardOverlay?.layout(this.videoRect, this.orientation);
    this.updateCropMask();
  };

  // Clip overlays to the current video rect. An overlay can be positioned (or
  // sized/rotated) so it extends past the video edge; this crops the overflow
  // at the boundary instead of letting it render over the letterbox — matching
  // the DOM canvas/preview/export, where the video wrapper has overflow:hidden.
  private updateCropMask(): void {
    const r = this.videoRect;
    if (!r.width || !r.height) return;

    if (!this.cropShape) {
      // make.graphics() keeps the shape off the display list — it's only used as
      // the mask geometry, never rendered itself.
      this.cropShape = this.make.graphics({});
      this.cropMask = this.cropShape.createGeometryMask();
    }

    this.cropShape.clear();
    this.cropShape.fillStyle(0xffffff);
    this.cropShape.fillRect(r.left, r.top, r.width, r.height);

    const mask = this.cropMask;
    if (!mask) return;
    const masked = this.endcardOverlay
      ? [...this.overlays, this.endcardOverlay]
      : this.overlays;
    masked.forEach((overlay) => {
      const root = overlay.root as unknown as {
        setMask?: (m: Phaser.Display.Masks.GeometryMask) => void;
      };
      if (typeof root.setMask === 'function') root.setMask(mask);
    });
    this.overlays.forEach((o) => o.textUnits?.container.setMask(mask));
    // A filled (cropped) video stays inside its frame, as in the editor.
    if (this.video) {
      if (this.adapted) this.video.setMask(mask);
      else this.video.clearMask();
    }
  }

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
    this.input.off('pointermove', this.onPointerMove, this);
    this.input.off('pointerup', this.onPointerUp, this);
    this.audioElements.forEach((el) => {
      el.pause();
      el.src = '';
    });
    this.audioElements.clear();
  }
}
