// Runtime types for the playclip data injected into this Phaser template.
// These mirror the JSON produced by the editor's /api/export/json builder
// (assets are wrapped as { id, type, values }), but only the fields the scene
// actually consumes are typed here.

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
}

export interface ButtonAction {
  type: 'play' | 'seek' | 'cta';
  seekTime?: number;
  playStoreLink?: string | null;
  appStoreLink?: string | null;
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
  landscapeWidthPercentage?: number;
  landscapeHeightPercentage?: number;
  portraitWidthPercentage?: number;
  portraitHeightPercentage?: number;
}

export interface PlayclipVideo {
  videoSrc: string | null;
  portraitSrc: string | null;
  landscapeSrc: string | null;
}

// Each asset arrives wrapped with its editable schema; the scene only needs
// `values`. Raw assets (no wrapper) are also tolerated for flexibility.
export interface AssetEntry {
  id: string;
  type: AssetType;
  values: PlayclipAsset;
}

export interface PlayclipData {
  version?: number;
  templateId?: string | null;
  name?: string | null;
  orientation?: Orientation | null;
  videoDuration?: number | null;
  video: PlayclipVideo;
  assets: Array<AssetEntry | PlayclipAsset>;
  controls?: unknown;
}
