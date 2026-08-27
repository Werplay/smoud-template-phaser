/**
 * Structural mirror of the editor's GameDoc (src/types/game-editor.ts in the
 * app). The template is a separate project with its own deps, so it cannot
 * import the Zod schema; `game-data.ts` casts the generated payload to these
 * types, the same arrangement `playclip-data.ts` uses on the playclip branch.
 *
 * Keep in sync with the app schema. The doc is validated there before it is
 * ever written here, so the runtime trusts its shape and only guards against
 * references that could go stale (a missing texture, a deleted node).
 */

export type Orientation = 'portrait' | 'landscape';

export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type Fit = 'none' | 'fit' | 'fill' | 'stretch';

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  originX: number;
  originY: number;
  alpha: number;
  depth: number;
  visible: boolean;
  anchor: Anchor;
  fit: Fit;
}

export interface TransformOverrides {
  portrait?: Partial<Transform>;
  landscape?: Partial<Transform>;
}

export type NodeKind = 'container' | 'sprite' | 'text' | 'shape' | 'sound' | 'video';

export interface VideoProps {
  assetId: string;
  loop: boolean;
  muted: boolean;
  autoplay: boolean;
}

export interface SpriteProps {
  assetId: string;
}

export interface TextProps {
  text: Record<string, string>;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  fontAssetId?: string;
}

export interface ShapeProps {
  shape: 'rect' | 'circle';
  width: number;
  height: number;
  fill: string;
  fillAlpha: number;
}

export type NodeProps = Partial<SpriteProps & TextProps & ShapeProps & VideoProps>;

export type GameComponent =
  | { type: 'tappable'; paddingX: number; paddingY: number; enabled: boolean }
  | { type: 'draggable'; axis: 'both' | 'x' | 'y'; returnOnRelease: boolean; bringToTop: boolean }
  | {
      type: 'dropZone';
      accepts: string[];
      snap: boolean;
      lockOnCorrect: boolean;
      allowIncorrect: boolean;
    }
  | {
      type: 'spawner';
      sources: string[];
      rate: number;
      maxAlive: number;
      lifetime: number;
      area: { width: number; height: number };
      autoStart: boolean;
    }
  | { type: 'timer'; mode: 'countdown' | 'stopwatch'; seconds: number; autoStart: boolean }
  | { type: 'counter'; key: string; initial: number; min?: number; max?: number }
  | {
      type: 'body';
      kind: 'dynamic' | 'static';
      gravityY?: number;
      velocityX: number;
      velocityY: number;
      bounce: number;
      drag: number;
      collideWorldBounds: boolean;
      sizeScale: number;
    }
  | { type: 'audio'; assetId: string; loop: boolean; volume: number; autoPlay: boolean };

export type GameEvent =
  | { on: 'start' }
  | { on: 'tap' }
  | { on: 'dragStart' }
  | { on: 'dragEnd' }
  | { on: 'collide'; tag: string }
  | { on: 'overlap'; tag: string }
  | { on: 'drop'; correct?: boolean }
  | { on: 'timerComplete' }
  | { on: 'spawn' }
  | { on: 'leaveBounds' }
  | { on: 'counterChange'; key: string }
  | { on: 'stateEnter'; state: string };

export type Condition =
  | {
      check: 'counter';
      key: string;
      op: '<' | '<=' | '==' | '>=' | '>' | '!=';
      /** A fixed number, or another counter to compare against. */
      value: number | { counter: string };
    }
  | { check: 'state'; state: string };

export type Easing = 'linear' | 'quadIn' | 'quadOut' | 'quadInOut' | 'backOut' | 'bounceOut' | 'elasticOut' | 'custom';

/** Names the other participant in the event that fired. */
export const OTHER_TARGET = '@other';

export type GameAction =
  | {
      do: 'tween';
      target?: string;
      to: Partial<Transform>;
      duration: number;
      easing: Easing;
      /** x1, y1, x2, y2 of a cubic bezier, used when easing is 'custom'. */
      curve?: [number, number, number, number];
      repeat: number;
      yoyo: boolean;
    }
  | { do: 'setProperty'; target?: string; key: string; value: string | number | boolean }
  | { do: 'show'; target?: string }
  | { do: 'hide'; target?: string }
  | { do: 'destroy'; target?: string }
  | { do: 'spawn'; target?: string }
  | { do: 'playSound'; assetId: string }
  | { do: 'addToCounter'; key: string; amount: number }
  | { do: 'setCounter'; key: string; value: number }
  | { do: 'setState'; state: string }
  | { do: 'openCta' }
  | { do: 'resetPosition'; target?: string }
  | { do: 'resetPositions' }
  | { do: 'goToScene'; sceneId: string }
  | { do: 'shake'; target?: string; intensity: number; duration: number }
  | { do: 'wait'; seconds: number };

export interface Behavior {
  id: string;
  event: GameEvent;
  conditions: Condition[];
  actions: GameAction[];
  parallel: boolean;
}

export interface GameNode {
  id: string;
  name: string;
  kind: NodeKind;
  tags: string[];
  transform: Transform;
  overrides?: TransformOverrides;
  props?: NodeProps;
  components: GameComponent[];
  behaviors: Behavior[];
  children: GameNode[];
  locked: boolean;
  script: string;
}

export interface GameAsset {
  id: string;
  kind: 'image' | 'audio' | 'font' | 'video';
  url: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface GameSceneData {
  id: string;
  name: string;
  role: 'game' | 'endcard' | 'scene';
  nodes: GameNode[];
  script: string;
}

export interface GameSettings {
  designWidth: number;
  designHeight: number;
  orientations: Orientation[];
  backgroundColor: string;
  /** An asset id: an image drawn behind everything, on top of the colour. */
  backgroundImageId?: string;
  gravityY: number;
  physicsDebug: boolean;
  storeUrls: { android?: string; ios?: string };
}

export interface GameState {
  name: string;
  show: string[];
  hide: string[];
}

export interface Outcome {
  conditions: Condition[];
  state: string;
}

export interface GameDoc {
  schemaVersion: number;
  name: string;
  defaultLocale: string;
  locales: string[];
  settings: GameSettings;
  assets: GameAsset[];
  scenes: GameSceneData[];
  states: GameState[];
  win?: Outcome;
  lose?: Outcome;
}
