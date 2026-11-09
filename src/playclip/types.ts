// Runtime types for the playclip data injected into this Phaser template.
// These mirror the JSON produced by the editor's /api/export/json builder
// (assets are wrapped as { id, type, values }), but only the fields the scene
// actually consumes are typed here.

import type { GlowStyle, GradientStyle, ShadowStyle, StrokeStyle } from './animation/styles';

import type { OrientationFrames } from './animation/frame';
import type { ReversedSegment } from './animation/pingpong';

export type Orientation = 'portrait' | 'landscape';

export interface Vec2 {
  x: number;
  y: number;
}

export type OrientationValue<T> = T | { landscape: T; portrait: T };

export interface AssetStyle {
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  textAlign?: 'left' | 'center' | 'right';
  color?: string;
  backgroundColor?: string;
  padding?: string;
  borderRadius?: string;
  fontFamily?: string;
  borderColor?: string;
  borderWidth?: string;
  width?: string;
  height?: string;
  // Transform fields (mirrored from editor's AssetStyle)
  rotation?: number; // clockwise degrees
  flipX?: boolean;
  flipY?: boolean;
  // Animation fields (mirrored from editor's AssetStyle)
  animationStyle?: string;
  entryAnimation?: string;
  exitAnimation?: string;
  animationDuration?: number;
  animationEasing?: string;
  animationOpacityFrom?: number;
  animationOpacityTo?: number;
  animationScaleFrom?: number;
  animationScaleTo?: number;
  animationSlideDistance?: number;
  gestureSpeed?: number;
  gestureDistance?: number;
  entryDuration?: number;
  exitDuration?: number;
  /** Resting opacity 0–1. */
  opacity?: number;
  /** Rotation/scale pivot as % of the box (50/50 = centre). */
  anchorX?: number;
  anchorY?: number;
  /** Layer styles (see animation/styles.ts); absent = off. */
  shadow?: ShadowStyle;
  outerGlow?: GlowStyle;
  stroke?: StrokeStyle;
  gradient?: GradientStyle;
}

export interface ButtonAction {
  type: 'play' | 'seek' | 'cta';
  seekTime?: number;
  playStoreLink?: string | null;
  appStoreLink?: string | null;
}

export interface AudioAction {
  volume?: number;
  speed?: number; // Playback rate: 0.25, 0.5, 0.75, 1 (default), 1.25, 1.5, 2
  loop?: boolean;
  isActive?: boolean;
  muteVideo?: boolean;       // When true (default), mutes video while this asset plays
  playDuringFreeze?: boolean; // When true, audio continues playing during a freeze control
}

export type AssetType =
  | 'text'
  | 'button'
  | 'image'
  | 'audio'
  | 'transparent-button'
  | 'endcard';

export interface PlayclipAsset {
  id: string;
  time: number;
  endTime: number;
  type: AssetType;
  content: string;
  position: OrientationValue<Vec2>;
  style?: OrientationValue<AssetStyle>;
  buttonAction?: ButtonAction;
  imageUrl?: string;
  audioUrl?: string;
  audioAction?: AudioAction;
  landscapeWidthPercentage?: number;
  landscapeHeightPercentage?: number;
  portraitWidthPercentage?: number;
  portraitHeightPercentage?: number;
  /** Stacking layer (see animation/layers.ts). */
  zIndex?: number;
}

export interface PlayclipVideo {
  videoSrc: string | null;
  portraitSrc: string | null;
  landscapeSrc: string | null;
  /** Ping-pong loops baked into the video (see animation/pingpong.ts). */
  pingPong?: ReversedSegment[];
}

// Each asset arrives wrapped with its editable schema; the scene only needs
// `values`. Raw assets (no wrapper) are also tolerated for flexibility.
export interface AssetEntry {
  id: string;
  type: AssetType;
  values: PlayclipAsset;
}

export interface PlayclipData {
  /** Orientation frames (see animation/frame.ts); absent = the video is the frame. */
  layout?: { frames?: OrientationFrames };
  version?: number;
  templateId?: string | null;
  name?: string | null;
  orientation?: Orientation | null;
  videoDuration?: number | null;
  video: PlayclipVideo;
  assets: Array<AssetEntry | PlayclipAsset>;
  controls?: unknown;
}
