// Orientation frames and auto layout, shared by the editor, Preview and the
// Phaser export.
//
// Assets are positioned in % of a "frame". By default the frame is the video
// itself (contained in the screen). For a single-video playclip, the
// orientation the video wasn't shot for can instead use an adapted frame: the
// whole screen at a design aspect (9:16 / 16:9), with the video fitted or
// cropped inside it and the leftover area filled with a blurred copy of the
// video or a colour. Asset layouts for that orientation are derived from the
// video's own orientation with a 9-point anchor resize (after EffectCraft's
// comp resize, crates/engine/src/cmd/comp.rs).

export type Orientation = 'portrait' | 'landscape';
export type VideoFit = 'fit' | 'fill';
export type FrameBackground = 'blur' | 'color';

export interface OrientationFrame {
  /** fit: the whole video is visible; fill: it's cropped to cover the frame. */
  fit?: VideoFit;
  /** What fills the area the video doesn't cover. */
  background?: FrameBackground;
  backgroundColor?: string;
  /** fill: the point of the video kept in view, 0–100 (as CSS object-position). */
  focusX?: number;
  focusY?: number;
}

export type ResolvedFrame = Required<OrientationFrame>;
export type OrientationFrames = Partial<Record<Orientation, OrientationFrame>>;

export const FRAME_DEFAULTS: ResolvedFrame = {
  fit: 'fit',
  background: 'blur',
  backgroundColor: '#000000',
  focusX: 50,
  focusY: 50,
};

export const frameOf = (f: OrientationFrame): ResolvedFrame => ({
  ...FRAME_DEFAULTS,
  ...f,
});

/** The adapted frame's shape per orientation (also the device, rotated). */
export const DESIGN_SCREEN: Record<
  Orientation,
  { width: number; height: number }
> = {
  portrait: { width: 9, height: 16 },
  landscape: { width: 16, height: 9 },
};

export type Rect = { left: number; top: number; width: number; height: number };

/** `aspect` (w/h) fitted inside W×H, centred. */
export function containRect(aspect: number, W: number, H: number): Rect {
  if (!(aspect > 0) || !(W > 0) || !(H > 0))
    return { left: 0, top: 0, width: W, height: H };
  const width = aspect > W / H ? W : H * aspect;
  const height = aspect > W / H ? W / aspect : H;
  return { left: (W - width) / 2, top: (H - height) / 2, width, height };
}

/** `aspect` covering W×H, aligned like CSS object-position: focusX% focusY%. */
export function coverRect(
  aspect: number,
  W: number,
  H: number,
  focusX = 50,
  focusY = 50,
): Rect {
  if (!(aspect > 0) || !(W > 0) || !(H > 0))
    return { left: 0, top: 0, width: W, height: H };
  const width = aspect > W / H ? H * aspect : W;
  const height = aspect > W / H ? H : W / aspect;
  return {
    left: ((W - width) * focusX) / 100,
    top: ((H - height) * focusY) / 100,
    width,
    height,
  };
}

/** The orientation a video was shot for. */
export const nativeOrientation = (aspect: number): Orientation =>
  aspect >= 1 ? 'landscape' : 'portrait';

export const otherOrientation = (o: Orientation): Orientation =>
  o === 'portrait' ? 'landscape' : 'portrait';

/**
 * The adapted frame used in `orientation`, or null for the default video
 * frame: only when a frame is set and the video was shot for the other
 * orientation.
 */
export function adaptedFrame(
  frames: OrientationFrames | null | undefined,
  orientation: Orientation,
  videoAspect: number | null | undefined,
): ResolvedFrame | null {
  const f = frames?.[orientation];
  if (!f || !videoAspect || !(videoAspect > 0)) return null;
  return nativeOrientation(videoAspect) === orientation ? null : frameOf(f);
}

export interface StageLayout {
  /** Where assets live (their % positions are of this rect). */
  frame: Rect;
  /** Where the video is drawn (may extend past the frame when filling). */
  video: Rect;
  adapted: ResolvedFrame | null;
}

/** Frame and video rects in a W×H stage (the screen or editor canvas). */
export function stageLayout(
  orientation: Orientation,
  W: number,
  H: number,
  videoAspect: number | null | undefined,
  frames?: OrientationFrames | null,
): StageLayout {
  const aspect =
    videoAspect && videoAspect > 0
      ? videoAspect
      : DESIGN_SCREEN[orientation].width / DESIGN_SCREEN[orientation].height;
  const a = adaptedFrame(frames, orientation, videoAspect);
  if (!a) {
    const v = containRect(aspect, W, H);
    return { frame: v, video: v, adapted: null };
  }
  const d = DESIGN_SCREEN[orientation];
  const frame = containRect(d.width / d.height, W, H);
  const inner =
    a.fit === 'fill'
      ? coverRect(aspect, frame.width, frame.height, a.focusX, a.focusY)
      : containRect(aspect, frame.width, frame.height);
  return {
    frame,
    video: {
      left: frame.left + inner.left,
      top: frame.top + inner.top,
      width: inner.width,
      height: inner.height,
    },
    adapted: a,
  };
}

/** The same layout in device units (portrait 9×16, landscape 16×9). */
export const designLayout = (
  orientation: Orientation,
  videoAspect: number | null | undefined,
  frames?: OrientationFrames | null,
) =>
  stageLayout(
    orientation,
    DESIGN_SCREEN[orientation].width,
    DESIGN_SCREEN[orientation].height,
    videoAspect,
    frames,
  );

/**
 * What an auto-laid-out asset follows in the other orientation: the screen
 * (it keeps its distance from the nearest edge or centre) or the video (it
 * stays on the same spot of the footage, e.g. a tap zone on a character).
 */
export type LayoutPin = 'screen' | 'video';

export const defaultPin = (type: string): LayoutPin =>
  type === 'transparent-button' ? 'video' : 'screen';

const third = (p: number) => (p < 100 / 3 ? 0 : p > 200 / 3 ? 1 : 0.5);

/**
 * Map an asset between two layouts in the same physical units.
 * `box`: centre in % of `from.frame`; w/h in those units (0 = content-sized).
 * Returns the centre in % of `to.frame` and the size multiplier.
 *
 * Screen-pinned assets keep their physical size (shrunk only to fit) and
 * their offset from the nearest of the frame's 9 anchor points (a third of the
 * frame decides which); video-pinned ones follow the video's rect.
 */
export function deriveBox(
  box: { x: number; y: number; w: number; h: number },
  from: StageLayout,
  to: StageLayout,
  pin: LayoutPin,
): { x: number; y: number; scale: number } {
  const F = from.frame;
  const T = to.frame;
  const px = F.left + (box.x / 100) * F.width;
  const py = F.top + (box.y / 100) * F.height;
  let nx: number;
  let ny: number;
  let scale: number;
  if (pin === 'video') {
    const V = from.video;
    const W = to.video;
    scale = V.width > 0 ? W.width / V.width : 1;
    nx = W.left + ((px - V.left) / (V.width || 1)) * W.width;
    ny = W.top + ((py - V.top) / (V.height || 1)) * W.height;
  } else {
    const cx = third(box.x);
    const cy = third(box.y);
    scale = Math.min(
      1,
      box.w > 0 ? (T.width * 0.96) / box.w : 1,
      box.h > 0 ? (T.height * 0.96) / box.h : 1,
    );
    nx = T.left + cx * T.width + (px - (F.left + cx * F.width)) * scale;
    ny = T.top + cy * T.height + (py - (F.top + cy * F.height)) * scale;
    // Keep it on screen, unless it was already placed partly off-frame.
    const e = 1e-6;
    const inside =
      px - box.w / 2 >= F.left - e &&
      px + box.w / 2 <= F.left + F.width + e &&
      py - box.h / 2 >= F.top - e &&
      py + box.h / 2 <= F.top + F.height + e;
    const hw = (box.w * scale) / 2;
    const hh = (box.h * scale) / 2;
    if (inside && hw * 2 <= T.width)
      nx = Math.max(T.left + hw, Math.min(T.left + T.width - hw, nx));
    if (inside && hh * 2 <= T.height)
      ny = Math.max(T.top + hh, Math.min(T.top + T.height - hh, ny));
  }
  return {
    x: ((nx - T.left) / (T.width || 1)) * 100,
    y: ((ny - T.top) / (T.height || 1)) * 100,
    scale,
  };
}

// --- Scaling an asset's pixel values ----------------------------------------

const scalePx = (v: string | undefined, k: number): string | undefined =>
  typeof v === 'string'
    ? v.replace(
        /(-?\d*\.?\d+)px/g,
        (_, n) => `${+(parseFloat(n) * k).toFixed(2)}px`,
      )
    : v;
const scaleNum = (v: number | undefined, k: number) =>
  typeof v === 'number' ? +(v * k).toFixed(2) : v;

type PxStyle = {
  fontSize?: number;
  width?: string;
  height?: string;
  padding?: string;
  borderRadius?: string;
  borderWidth?: string;
  animationStyle?: string;
  animationSlideDistance?: number;
  gestureDistance?: number;
  shadow?: { distance?: number; blur?: number };
  outerGlow?: { size?: number };
  stroke?: { width?: number };
};

/** Multiply every pixel-valued field of a style by `k` (sizes, fonts, effects, motion). */
export function scaleStylePx<T extends PxStyle>(style: T, k: number): T {
  if (k === 1 || !(k > 0)) return { ...style };
  const s: T = { ...style };
  s.fontSize = scaleNum(style.fontSize, k);
  s.width = scalePx(style.width, k);
  s.height = scalePx(style.height, k);
  s.padding = scalePx(style.padding, k);
  s.borderRadius = scalePx(style.borderRadius, k);
  s.borderWidth = scalePx(style.borderWidth, k);
  s.animationSlideDistance = scaleNum(style.animationSlideDistance, k);
  // Tap depth is a percentage, not a distance.
  if (style.animationStyle !== 'tap')
    s.gestureDistance = scaleNum(style.gestureDistance, k);
  if (style.shadow)
    s.shadow = {
      ...style.shadow,
      distance: scaleNum(style.shadow.distance, k),
      blur: scaleNum(style.shadow.blur, k),
    };
  if (style.outerGlow)
    s.outerGlow = {
      ...style.outerGlow,
      size: scaleNum(style.outerGlow.size, k),
    };
  if (style.stroke)
    s.stroke = { ...style.stroke, width: scaleNum(style.stroke.width, k) };
  for (const key of Object.keys(s) as (keyof T)[])
    if (s[key] === undefined && !(key in style)) delete s[key];
  return s;
}
