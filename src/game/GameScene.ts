import * as Phaser from 'phaser';
import { sdk } from '@smoud/playable-sdk';
import { getDoc } from './doc-source';
import { layoutScale, orientationOf, resolveTransform, rootOffsetFromScreen, rootPlacement, type Size } from './layout';
import { type Guide, type Rect, rectOf, snap } from './snapping';
import { OTHER_TARGET } from './types';
import type {
  Behavior,
  Condition,
  Easing,
  GameAction,
  GameComponent,
  GameDoc,
  GameNode,
  Orientation,
  Outcome,
  SpriteProps,
  Transform,
} from './types';

// Every component type is interpreted; the list is kept so a type added to the
// schema before the runtime catches up still warns rather than doing nothing.
const SKIPPED_COMPONENTS: string[] = [];

/** Ids for nodes a spawner clones, kept apart from anything an author typed. */
let spawnCounter = 0;

/**
 * Edit mode makes every node draggable and selectable and holds behaviours
 * back, so tapping a CTA to move it does not also fire it. Play mode is the
 * playable exactly as it ships. An exported build only ever runs 'play'.
 */
export type RuntimeMode = 'edit' | 'play';

const SELECTION_COLOR = 0xb8ff3c;
const GUIDE_COLOR = 0x3de8ff;
const HANDLE_RADIUS = 7;
const ROTATE_ARM_LENGTH = 28;
/** The box drawn for a node that has no size — an empty group, so far. */
const EMPTY_SELECTION_SIZE = 48;
/**
 * Where an overlay's depth starts, above anything a scene is likely to use and
 * below the editor's own handles at 10,000.
 */
const OVERLAY_DEPTH = 9000;
/** A node can be shrunk but not inverted or vanished by a corner drag. */
const MIN_SCALE = 0.05;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const EASING: Record<Exclude<Easing, 'custom'>, string> = {
  linear: 'Linear',
  quadIn: 'Quad.easeIn',
  quadOut: 'Quad.easeOut',
  quadInOut: 'Quad.easeInOut',
  backOut: 'Back.easeOut',
  bounceOut: 'Bounce.easeOut',
  elasticOut: 'Elastic.easeOut'
};

/**
 * A cubic bezier as an easing function, the same four numbers CSS takes.
 *
 * x is time and y is progress, and the curve is given as x(t), y(t) — so
 * finding the progress at a moment means solving x(t) = time first. Newton
 * converges in a couple of steps for the curves a person draws; the bisection
 * after it is for the ones they draw by accident, where the slope goes flat.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
  const curve = (a: number, b: number, t: number) => {
    const inverse = 1 - t;
    return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t;
  };
  const slope = (a: number, b: number, t: number) => {
    const inverse = 1 - t;
    return 3 * inverse * inverse * a + 6 * inverse * t * (b - a) + 3 * t * t * (1 - b);
  };

  return (time: number) => {
    if (time <= 0) return 0;
    if (time >= 1) return 1;

    let t = time;
    for (let step = 0; step < 4; step++) {
      const error = curve(x1, x2, t) - time;
      if (Math.abs(error) < 1e-4) return curve(y1, y2, t);
      const derivative = slope(x1, x2, t);
      if (Math.abs(derivative) < 1e-6) break;
      t -= error / derivative;
    }

    let low = 0;
    let high = 1;
    t = time;
    for (let step = 0; step < 20; step++) {
      const x = curve(x1, x2, t);
      if (Math.abs(x - time) < 1e-4) break;
      if (x > time) high = t;
      else low = t;
      t = (low + high) / 2;
    }
    return curve(y1, y2, t);
  };
}

function toColor(hex: string, fallback = 0x000000): number {
  try {
    return Phaser.Display.Color.HexStringToColor(hex).color;
  } catch {
    return fallback;
  }
}

/**
 * What a script registers with on(). The first argument is whatever the event
 * carries — the other node in a collision, the seconds elapsed in an update —
 * and the second is the raw event, for the rare script that wants the detail.
 */
type ScriptHandler = (payload?: unknown, event?: unknown) => void;

interface LiveNode {
  node: GameNode;
  /**
   * The sound this node owns, when it has an audio component. This is what a
   * script gets from find(), so `find('music').play()` is a real call on a real
   * Phaser sound rather than a method an empty container does not have.
   */
  sound?: Phaser.Sound.BaseSound;
  /** Which scene the node belongs to — scenes are shown one at a time. */
  sceneId: string;
  object: Phaser.GameObjects.GameObject;
  /** Authored transform with the current orientation's patch applied, mutated by tweens. */
  transform: Transform;
  isRoot: boolean;
}

export class GameScene extends Phaser.Scene {
  private doc: GameDoc = getDoc();
  private live = new Map<string, LiveNode>();
  private counters = new Map<string, number>();
  private orientation: Orientation = 'portrait';
  private state = '';
  private finished = false;
  /** Whether each outcome is currently satisfied, so it fires once per run. */
  private outcomeLatched: { win: boolean; lose: boolean } = { win: false, lose: false };
  private mode: RuntimeMode = 'play';
  /**
   * The scene on screen. Exactly one at a time: the endcard replaces the game
   * rather than covering it, which is what it does in a shipped playable and
   * what an author editing one expects to see.
   */
  private visibleScene = '';
  /** Nodes with a physics body, kept per tag so colliders can be declared between tags. */
  private bodiesByTag = new Map<string, Phaser.GameObjects.GameObject[]>();
  private timers: Phaser.Time.TimerEvent[] = [];
  private dropZones: {
    entry: LiveNode;
    accepts: string[];
    snap: boolean;
    lockOnCorrect: boolean;
    allowIncorrect: boolean;
    /** The node that filled it, so putting that one piece back frees it. */
    filledBy?: string;
    /**
     * What is sitting here, locked or not. Distinct from filledBy, which means
     * "locked in place and no longer a target": a zone that merely holds a
     * piece still accepts another, and a script still needs to know what is in
     * it — that is what makes a word puzzle scriptable.
     */
    holding?: string;
  }[] = [];
  /** Nodes a spawner uses as prototypes; hidden while playing. */
  private prototypes = new Set<string>();
  private aliveBySpawner = new Map<string, number>();
  private selectedIds: string[] = [];
  private selectionBox?: Phaser.GameObjects.Graphics;
  private guideLayer?: Phaser.GameObjects.Graphics;
  private snapEnabled = true;
  private handles: Phaser.GameObjects.Arc[] = [];
  /** Live gesture on a scale or rotate handle; absent while nothing is dragging. */
  private gesture?: {
    entry: LiveNode;
    role: 'scale' | 'rotate';
    center: { x: number; y: number };
    startDistance: number;
    startPointerAngle: number;
    startScaleX: number;
    startScaleY: number;
    startRotation: number;
  };
  /** Reports a drag or a selection back to the editor; unset in a shipped build. */
  private onEditorAction?: (message: Record<string, unknown>) => void;
  /** Handlers a script registered, keyed by what owns it then by event name. */
  private scriptHandlers = new Map<string, Map<string, ScriptHandler[]>>();
  /** One report per script: a throw inside update() would otherwise repeat 60 times a second. */
  private scriptErrors = new Set<string>();
  /** Blob URLs made for embedded audio, released when the run ends. */
  private blobUrls: string[] = [];
  /** Every video built this run, so a restart does not leave one playing. */
  private videos: Phaser.GameObjects.Video[] = [];
  /** The image behind everything, when the project has one. */
  private background?: Phaser.GameObjects.Image;

  constructor() {
    super({ key: 'GameScene' });
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Phaser reuses the scene instance across a restart, so every field the last
   * run touched is reset here. The editor restarts on each document change; a
   * counter or a spawned node surviving that would make the preview disagree
   * with a fresh load of the same document.
   */
  init(data?: { mode?: RuntimeMode; scene?: string; snap?: boolean }): void {
    this.doc = getDoc();
    if (data?.mode) this.mode = data.mode;
    this.snapEnabled = data?.snap ?? true;

    // Editing follows the tab the author is on; playing always opens on the
    // scene marked as the start, whatever it happens to be called.
    const start = this.doc.scenes.find((scene) => scene.role === 'game') ?? this.doc.scenes[0];
    const requested =
      this.mode === 'edit' && data?.scene ? this.doc.scenes.find((scene) => scene.id === data.scene) : undefined;
    this.visibleScene = (requested ?? start)?.id ?? '';
    this.live = new Map();
    this.counters = new Map();
    // Removed, not just stopped: the sound manager belongs to the game rather
    // than the scene, so it outlives a restart. Stopping left the instance
    // behind, and a scene rebuilt fifty times had fifty silent sounds in it —
    // and any script reading scene.sound.sounds saw all of them.
    this.sound.removeAll();
    this.state = '';
    this.finished = false;
    this.outcomeLatched = { win: false, lose: false };
    this.bodiesByTag = new Map();
    this.timers = [];
    this.dropZones = [];
    this.prototypes = new Set();
    this.videos = [];
    this.aliveBySpawner = new Map();
  }

  preload(): void {
    /**
     * Asked for with CORS, because a video is drawn from the element itself.
     *
     * Images never needed this: Phaser fetches them over XHR and hands WebGL a
     * blob, which is same-origin whatever it came from. A video goes straight
     * onto a <video> element, and an element holding another origin's bytes
     * taints the canvas — texImage2D then throws SecurityError and the whole
     * scene stops, which is what an editor preview did with a video on it. The
     * preview runs on an opaque origin, so every URL is another origin's,
     * including our own.
     */
    this.load.crossOrigin = 'anonymous';

    // Images arrive as data URIs (embedded at export) or URLs (editor preview);
    // either way the loader has the texture ready before create() places it.
    for (const asset of this.doc.assets) {
      if (asset.kind === 'image') {
        // Sliced at load time, because a texture is loaded once and Phaser
        // keeps the frame size with it. Two sprites cannot cut the same sheet
        // differently, which is why the cell size lives on the asset.
        if (asset.frameWidth && asset.frameHeight) {
          this.load.spritesheet(asset.id, asset.url, {
            frameWidth: asset.frameWidth,
            frameHeight: asset.frameHeight
          });
        } else {
          this.load.image(asset.id, asset.url);
        }
      }
      // Through Phaser rather than an Audio element, so a sound is an object a
      // script can hold: play, stop, setVolume, isPlaying. Phaser also waits
      // out the browser's gesture lock for us, which the element did not.
      if (asset.kind === 'audio') {
        this.load.audio(asset.id, this.loadableMediaUrl(asset.url));
      }
      // noAudio: false, because a video node can carry its own sound. Whether
      // it is heard is the node's business, and it is muted unless asked.
      if (asset.kind === 'video') {
        this.load.video(asset.id, this.loadableMediaUrl(asset.url), false);
      }
    }
  }

  create(): void {
    this.orientation = orientationOf(this.viewport());
    this.cameras.main.setBackgroundColor(this.doc.settings.backgroundColor);
    this.paintBackground();

    this.seedCounters();

    for (const scene of this.doc.scenes) {
      for (const node of scene.nodes) {
        this.buildNode(node, undefined, scene.id);
      }
    }

    if (this.mode === 'play') {
      const { width, height } = this.viewport();
      this.physics.world.setBounds(0, 0, width, height);
      this.physics.world.gravity.y = this.doc.settings.gravityY;

      if (this.doc.settings.physicsDebug) {
        this.physics.world.createDebugGraphic();
        this.physics.world.drawDebug = true;
      }

      // Declared after every node exists, so a rule can name a tag carried by
      // something built later in the tree.
      this.wireCollisions();
    }

    this.refreshTexts();
    this.relayout();
    this.scale.on('resize', this.relayout, this);
    this.events.once('shutdown', this.teardown, this);
    this.events.once('destroy', this.teardown, this);

    if (this.mode === 'edit') {
      this.selectionBox = this.add.graphics().setDepth(10_000);
      this.guideLayer = this.add.graphics().setDepth(9_999);
      this.createHandles();
      this.enableEditing();
      this.drawSelection();
    } else {
      // Play only. In edit mode a script's update loop would fight the author
      // for control of the thing they are trying to position.
      this.runScripts();
      this.fire({ on: 'start' });
      // The scene a run opens on has started too, and a handler written on it
      // should not have to be written twice to hear that.
      this.fireSceneStart(this.visibleScene);
    }

    sdk.start();
  }

  // --- editing --------------------------------------------------------------

  /** Called by the bridge when the editor switches mode or changes selection. */
  setEditorHooks(report: (message: Record<string, unknown>) => void): void {
    this.onEditorAction = report;
  }

  setSelected(nodeIds: string[]): void {
    this.selectedIds = nodeIds;
    this.drawSelection();
  }

  /** The node the handles belong to: the last one chosen. */
  private primarySelection(): LiveNode | undefined {
    const id = this.selectedIds[this.selectedIds.length - 1];
    return id ? this.live.get(id) : undefined;
  }

  /**
   * Every node becomes draggable. The object moves locally for the duration of
   * the gesture — the editor is only told on release, so a drag is one document
   * change and one undo step rather than one per pointer move.
   */
  private enableEditing(): void {
    for (const entry of Array.from(this.live.values())) {
      // An overlay is on every scene, so it is editable from every scene.
      if (
        entry.node.locked ||
        (entry.sceneId !== this.visibleScene && !entry.node.overlay)
      ) {
        continue;
      }

      const object = entry.object;

      // An empty container — a sound, say — has nothing to pick up, and asking
      // for input on it is what produced hitAreaCallback errors on every move.
      if (!this.makeInteractive(object, { draggable: true, useHandCursor: true })) {
        continue;
      }
      this.input.setDraggable(object, true);

      object.on('pointerdown', () => {
        // Clicking something already chosen keeps the group, so a drag can
        // start from any member of it.
        if (!this.selectedIds.includes(entry.node.id)) {
          this.setSelected([entry.node.id]);
          this.onEditorAction?.({ type: 'game-editor:selected', nodeId: entry.node.id });
        }
      });
    }

    // A click landing on nothing clears the selection. Phaser hands the
    // scene-level handler what the pointer is over, so "nothing" is knowable
    // without hit-testing by hand — and a handle counts as something, so
    // grabbing one never deselects what it belongs to.
    this.input.on('pointerdown', (_pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
      if (currentlyOver.length) return;
      this.setSelected([]);
      this.onEditorAction?.({ type: 'game-editor:selected', nodeId: null });
    });

    this.input.on('dragstart', (pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject) => {
      const role = object.getData?.('role') as 'scale' | 'rotate' | undefined;
      if (role) this.beginGesture(role, pointer);
    });

    this.input.on(
      'drag',
      (pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject, dragX: number, dragY: number) => {
        // A handle drives the selected node rather than moving itself; it is put
        // back where it belongs by drawSelection.
        if (object.getData?.('role')) {
          this.updateGesture(pointer);
          return;
        }

        const entry = Array.from(this.live.values()).find((candidate) => candidate.object === object);
        const moved = object as unknown as { x: number; y: number };

        // A toolbar toggle rather than a held modifier: keyboard modifiers
        // reach an iframe only when it holds focus, which during a drag begun
        // from the parent page it may not.
        const aligned =
          entry && this.snapEnabled
            ? this.alignWhileDragging(entry, dragX, dragY)
            : { x: dragX, y: dragY, guides: [] as Guide[] };

        // Everything else in the selection travels by the same amount, so a
        // group keeps its arrangement rather than collapsing onto one point.
        const shiftX = aligned.x - moved.x;
        const shiftY = aligned.y - moved.y;
        if (entry && this.selectedIds.length > 1 && this.selectedIds.includes(entry.node.id)) {
          for (const id of this.selectedIds) {
            if (id === entry.node.id) continue;
            const other = this.live.get(id);
            if (!other) continue;
            const target = other.object as unknown as { x: number; y: number };
            target.x += shiftX;
            target.y += shiftY;
          }
        }

        moved.x = aligned.x;
        moved.y = aligned.y;
        this.drawGuides(aligned.guides);
        this.drawSelection();
      }
    );

    this.input.on('dragend', (_pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject) => {
      if (object.getData?.('role')) {
        this.endGesture();
        this.drawSelection();
        return;
      }

      this.drawGuides([]);

      const entry = Array.from(this.live.values()).find((candidate) => candidate.object === object);
      if (!entry) return;

      const placed = object as unknown as { x: number; y: number };
      const design = {
        width: this.doc.settings.designWidth,
        height: this.doc.settings.designHeight
      };

      // Report the authored offset, not the screen position: a document holds
      // values that mean the same thing on every device.
      const offset = entry.isRoot
        ? rootOffsetFromScreen(placed, entry.transform, design, this.viewport())
        : { x: placed.x, y: placed.y };

      const x = Math.round(offset.x);
      const y = Math.round(offset.y);

      // A click is a drag of zero distance. Reporting it would put an edit in
      // the undo stack for merely selecting something.
      if (x !== Math.round(entry.transform.x) || y !== Math.round(entry.transform.y)) {
        entry.transform = { ...entry.transform, x, y };
        this.onEditorAction?.({ type: 'game-editor:moved', nodeId: entry.node.id, x, y });

        // The rest of a dragged group moved too, and each has its own offset.
        for (const id of this.selectedIds) {
          if (id === entry.node.id) continue;
          const other = this.live.get(id);
          if (!other) continue;

          const placed = other.object as unknown as { x: number; y: number };
          const theirs = other.isRoot
            ? rootOffsetFromScreen(placed, other.transform, design, this.viewport())
            : { x: placed.x, y: placed.y };

          const ox = Math.round(theirs.x);
          const oy = Math.round(theirs.y);
          other.transform = { ...other.transform, x: ox, y: oy };
          this.onEditorAction?.({ type: 'game-editor:moved', nodeId: id, x: ox, y: oy });
        }
      }

      this.drawSelection();
    });
  }

  /**
   * Four corners for scale and one arm for rotate. They are created once and
   * moved onto whatever is selected, so a restart does not leave orphans.
   */
  private createHandles(): void {
    const make = (role: 'scale' | 'rotate', corner: number) => {
      const handle = this.add.circle(0, 0, HANDLE_RADIUS, SELECTION_COLOR).setDepth(10_001).setVisible(false);
      handle.setData('role', role);
      handle.setData('corner', corner);
      handle.setInteractive({ draggable: true, useHandCursor: true });
      this.input.setDraggable(handle, true);
      return handle;
    };

    this.handles = [0, 1, 2, 3].map((corner) => make('scale', corner));
    this.handles.push(make('rotate', -1));
  }

  /**
   * The selected node's box in world space. Taken from the object's own
   * position and display size rather than its axis-aligned bounds, so the
   * outline and handles stay on the corners once it is rotated.
   *
   * ponytail: assumes a centred origin, which every node has by default. A node
   * with a shifted origin gets a box offset by the same amount; fix by folding
   * originX/Y in here if that ever becomes authorable.
   */
  private selectionGeometry(
    entry: LiveNode
  ): { center: { x: number; y: number }; halfW: number; halfH: number; angle: number } | undefined {
    const object = entry.object as Phaser.GameObjects.GameObject & {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      displayWidth?: number;
      displayHeight?: number;
      angle?: number;
      getBounds?: () => Phaser.Geom.Rectangle;
      getWorldTransformMatrix?: () => Phaser.GameObjects.Components.TransformMatrix;
    };

    /**
     * World space, not the object's own.
     *
     * A node inside a group has x and y local to that group, and the pointer
     * never does — so the outline and handles were drawn near the top-left of
     * the screen while the image sat in the middle, and dragging where the
     * handles appeared to be did nothing at all. Reported as a node that could
     * be selected and moved but not resized, which is exactly how it looks:
     * moving comes from Phaser's own drag coordinates and was always right.
     *
     * For a node with no parent this is the same answer as before.
     */
    const world = object.getWorldTransformMatrix?.();
    const center = world
      ? { x: world.tx, y: world.ty }
      : { x: object.x ?? 0, y: object.y ?? 0 };
    const scaleX = world ? world.scaleX : 1;
    const scaleY = world ? world.scaleY : 1;

    // Its own measurement times the whole chain of scales above it, rather
    // than displayWidth, which has only its own scale in it.
    const width = world ? (object.width ?? 0) * scaleX : (object.displayWidth ?? 0);
    const height = world ? (object.height ?? 0) * scaleY : (object.displayHeight ?? 0);

    if (width > 0 && height > 0) {
      return {
        center,
        halfW: width / 2,
        halfH: height / 2,
        angle: world ? world.rotation : Phaser.Math.DegToRad(object.angle ?? 0)
      };
    }

    // Containers have no display size of their own; their bounds come from
    // what is inside them, and those are never rotated as a unit here.
    const bounds = object.getBounds?.();
    if (bounds && bounds.width && bounds.height) {
      return {
        center: { x: bounds.centerX, y: bounds.centerY },
        halfW: bounds.width / 2,
        halfH: bounds.height / 2,
        angle: 0
      };
    }

    /**
     * A stand-in box for something with no size at all.
     *
     * An empty group is a real node in a real place, and selecting one used to
     * draw nothing whatsoever: no outline, no handles, no sign the click had
     * landed. Reported as not being able to resize a node from the editor, and
     * it was worse than that — the node was invisible once chosen.
     */
    return {
      center,
      halfW: EMPTY_SELECTION_SIZE / 2,
      halfH: EMPTY_SELECTION_SIZE / 2,
      angle: world ? world.rotation : Phaser.Math.DegToRad(object.angle ?? 0)
    };
  }

  private cornerPoints(box: {
    center: { x: number; y: number };
    halfW: number;
    halfH: number;
    angle: number;
  }): Phaser.Math.Vector2[] {
    const cos = Math.cos(box.angle);
    const sin = Math.sin(box.angle);

    return [
      [-box.halfW, -box.halfH],
      [box.halfW, -box.halfH],
      [box.halfW, box.halfH],
      [-box.halfW, box.halfH]
    ].map(([x, y]) => new Phaser.Math.Vector2(box.center.x + x * cos - y * sin, box.center.y + x * sin + y * cos));
  }

  /** The rectangle a node occupies on screen, for aligning against. */
  private screenRect(entry: LiveNode): Rect | undefined {
    const geometry = this.selectionGeometry(entry);
    if (!geometry) return undefined;
    return rectOf(geometry.center.x, geometry.center.y, geometry.halfW * 2, geometry.halfH * 2);
  }

  /**
   * Nudges a drag onto alignment with everything else visible, and with the
   * middle of the screen. Edges and centres both count, because "line these up"
   * means either depending on what is being built.
   */
  private alignWhileDragging(entry: LiveNode, dragX: number, dragY: number): { x: number; y: number; guides: Guide[] } {
    const geometry = this.selectionGeometry(entry);
    if (!geometry) return { x: dragX, y: dragY, guides: [] };

    const moving = rectOf(dragX, dragY, geometry.halfW * 2, geometry.halfH * 2);

    const others: Rect[] = [];
    for (const candidate of Array.from(this.live.values())) {
      if (candidate === entry || candidate.sceneId !== this.visibleScene) continue;
      if (!candidate.transform.visible) continue;
      const rect = this.screenRect(candidate);
      if (rect) others.push(rect);
    }

    // The centre of the view, so a node can be centred with nothing else on screen.
    const { width, height } = this.viewport();
    others.push(rectOf(width / 2, height / 2, 0, 0));

    const result = snap(moving, others);
    return { x: dragX + result.dx, y: dragY + result.dy, guides: result.guides };
  }

  private drawGuides(guides: Guide[]): void {
    const layer = this.guideLayer;
    if (!layer) return;

    layer.clear();
    if (!guides.length) return;

    const { width, height } = this.viewport();
    layer.lineStyle(1, GUIDE_COLOR, 0.9);

    for (const guide of guides) {
      if (guide.axis === 'x') layer.lineBetween(guide.at, 0, guide.at, height);
      else layer.lineBetween(0, guide.at, width, guide.at);
    }
  }

  private drawSelection(): void {
    const box = this.selectionBox;
    if (!box) return;

    box.clear();
    // Everything chosen is outlined; only the last one gets handles, because
    // scaling six things from one corner is not a gesture anyone means.
    for (const id of this.selectedIds) {
      const chosen = this.live.get(id);
      const outline = chosen ? this.selectionGeometry(chosen) : undefined;
      if (!outline) continue;
      box.lineStyle(2, SELECTION_COLOR, id === this.selectedIds[this.selectedIds.length - 1] ? 0.9 : 0.4);
      box.strokePoints(this.cornerPoints(outline), true);
    }

    const entry = this.primarySelection();
    const geometry = entry ? this.selectionGeometry(entry) : undefined;

    if (!geometry) {
      for (const handle of this.handles) handle.setVisible(false);
      return;
    }

    const corners = this.cornerPoints(geometry);

    // The rotate arm sticks out past the top edge, away from the box.
    const topMid = corners[0].clone().add(corners[1]).scale(0.5);
    const arm = new Phaser.Math.Vector2(Math.sin(geometry.angle), -Math.cos(geometry.angle)).scale(ROTATE_ARM_LENGTH);
    const rotatePoint = topMid.clone().add(arm);

    box.lineBetween(topMid.x, topMid.y, rotatePoint.x, rotatePoint.y);

    this.handles.forEach((handle) => {
      const corner = handle.getData('corner') as number;
      const point = corner >= 0 ? corners[corner] : rotatePoint;
      handle.setPosition(point.x, point.y).setVisible(true);
    });
  }

  /** Begins a scale or rotate gesture, capturing what it measures against. */
  private beginGesture(role: 'scale' | 'rotate', pointer: Phaser.Input.Pointer): void {
    const entry = this.primarySelection();
    const geometry = entry ? this.selectionGeometry(entry) : undefined;
    if (!entry || !geometry) return;
    // A locked node cannot be dragged and could still be scaled and rotated by
    // its handles, which is most of a lock not locking.
    if (entry.node.locked) return;

    this.gesture = {
      entry,
      role,
      center: geometry.center,
      startDistance: Phaser.Math.Distance.BetweenPoints(pointer, geometry.center) || 1,
      startPointerAngle: Phaser.Math.Angle.BetweenPoints(geometry.center, pointer),
      startScaleX: entry.transform.scaleX,
      startScaleY: entry.transform.scaleY,
      startRotation: entry.transform.rotation
    };
  }

  /**
   * Scale is applied as a ratio of the authored value, so no inverse of the
   * layout maths is needed: dragging a corner to twice the distance doubles the
   * authored scale, whatever the device happens to be showing it at.
   */
  private updateGesture(pointer: Phaser.Input.Pointer): void {
    const gesture = this.gesture;
    if (!gesture) return;

    if (gesture.role === 'scale') {
      const ratio = Phaser.Math.Distance.BetweenPoints(pointer, gesture.center) / gesture.startDistance;
      const clamped = Math.max(MIN_SCALE, ratio);
      gesture.entry.transform = {
        ...gesture.entry.transform,
        scaleX: round2(gesture.startScaleX * clamped),
        scaleY: round2(gesture.startScaleY * clamped)
      };
    } else {
      const delta = Phaser.Math.Angle.BetweenPoints(gesture.center, pointer) - gesture.startPointerAngle;
      gesture.entry.transform = {
        ...gesture.entry.transform,
        rotation: Math.round(gesture.startRotation + Phaser.Math.RadToDeg(delta))
      };
    }

    this.applyTransform(gesture.entry);
    this.drawSelection();
  }

  private endGesture(): void {
    const gesture = this.gesture;
    this.gesture = undefined;
    if (!gesture) return;

    const { scaleX, scaleY, rotation } = gesture.entry.transform;
    if (scaleX === gesture.startScaleX && scaleY === gesture.startScaleY && rotation === gesture.startRotation) {
      return;
    }

    this.onEditorAction?.({
      type: 'game-editor:transformed',
      nodeId: gesture.entry.node.id,
      scaleX,
      scaleY,
      rotation
    });
  }

  private viewport(): Size {
    const { width, height } = this.scale.gameSize;
    return { width, height };
  }

  // --- building -------------------------------------------------------------

  private buildNode(node: GameNode, parent: Phaser.GameObjects.Container | undefined, sceneId: string): void {
    const transform = resolveTransform(node.transform, node.overrides, this.orientation);
    const object = this.createObject(node);
    if (!object) return;

    // What the author called it, and what they tagged it — the two things a
    // script asks a node about itself. Phaser has a name field and leaves it
    // empty, so find('Text-B').name read as blank; tags were not there at all,
    // which is awkward when tags are what drop zones match on.
    object.name = node.name;
    Object.defineProperty(object, 'tags', {
      configurable: true,
      get: () => [...node.tags]
    });

    const entry: LiveNode = {
      node,
      sceneId,
      object,
      transform: { ...transform },
      isRoot: !parent
    };
    this.live.set(node.id, entry);

    if (parent) parent.add(object);
    this.applyTransform(entry);

    let tappable = false;

    for (const component of node.components) {
      if (component.type === 'counter') {
        this.counters.set(component.key, component.initial);
      } else if (component.type === 'tappable' && component.enabled) {
        this.makeTappable(node, object, component.paddingX, component.paddingY);
        tappable = true;
      } else if (component.type === 'audio') {
        entry.sound = this.attachSound(entry, component);
      } else if (component.type === 'body' && this.mode === 'play') {
        // Bodies only exist while playing: gravity pulling a node off screen
        // mid-edit would fight the author for it.
        this.attachBody(node, object, component);
      } else if (component.type === 'timer' && this.mode === 'play') {
        this.attachTimer(node, component);
      } else if (component.type === 'spawner' && this.mode === 'play') {
        this.attachSpawner(entry, component);
      } else if (component.type === 'draggable' && this.mode === 'play') {
        this.attachDraggable(entry, component);
      } else if (component.type === 'dropZone' && this.mode === 'play') {
        this.dropZones.push({
          entry,
          accepts: component.accepts,
          snap: component.snap,
          lockOnCorrect: component.lockOnCorrect,
          allowIncorrect: component.allowIncorrect,
          filledBy: undefined,
          holding: undefined
        });
      } else if (SKIPPED_COMPONENTS.indexOf(component.type) !== -1) {
        console.warn(`[GameScene] "${component.type}" on ${node.id} is not interpreted yet`);
      }
    }

    // A tap behaviour is itself a declaration that the node is tappable. Without
    // this, authoring "on tap" on a node that has no tappable component produces
    // a behaviour that can never fire and says nothing about why.
    if (!tappable && node.behaviors.some((behavior) => behavior.event.on === 'tap')) {
      this.makeTappable(node, object, 0, 0);
    }

    const container = object instanceof Phaser.GameObjects.Container ? object : undefined;
    for (const child of node.children) {
      if (!container) {
        console.warn(`[GameScene] ${node.id} is a ${node.kind}; only containers can hold children`);
        break;
      }
      this.buildNode(child, container, sceneId);
    }
  }

  private createObject(node: GameNode): Phaser.GameObjects.GameObject | undefined {
    const props = node.props || {};

    // A sound is an empty container: nothing is drawn, but the node still
    // exists, so its audio component runs like any other.
    if (node.kind === 'container' || node.kind === 'sound') {
      return this.add.container(0, 0);
    }

    if (node.kind === 'sprite') {
      const key = props.assetId;
      if (!key || !this.textures.exists(key)) {
        // A deleted or failed asset must not take the scene down with it.
        console.warn(`[GameScene] missing texture "${key}" for ${node.id}`);
        return undefined;
      }

      // A plain picture stays an Image: it is the cheaper object, and most
      // sprites in a playable never animate.
      if (!props.animation) {
        return this.add.image(0, 0, key, props.frame ?? undefined);
      }

      // Cells, not frames: a texture carries a __BASE entry whether or not it
      // was ever sliced, so a plain image reports one frame and has none.
      const cells = this.textures.get(key).frameTotal - 1;
      if (cells < 2) {
        // An animation on an unsliced image: the asset lost its frame size, or
        // nobody gave it one. Draw the picture rather than dying — Phaser hands
        // out frames that do not exist and throws deep inside its own renderer,
        // which took the whole scene with it.
        console.warn(`[GameScene] "${key}" is not cut into frames; ${node.id} cannot animate`);
        return this.add.image(0, 0, key);
      }

      const sprite = this.add.sprite(0, 0, key, props.animation.from);
      this.defineAnimation(sprite, node, props.animation, cells);
      return sprite;
    }

    if (node.kind === 'video') {
      const key = props.assetId;
      if (!key || !this.cache.video.exists(key)) {
        console.warn(`[GameScene] missing video "${key}" for ${node.id}`);
        return undefined;
      }

      const video = this.add.video(0, 0, key);
      this.videos.push(video);

      /**
       * Measured again when the video says how big it is.
       *
       * Phaser gives a video a 256x256 placeholder texture until its first
       * frame arrives, and everything sized before that is sized against the
       * placeholder: a real clip is larger, so its tap area came out a patch in
       * one corner. Reported as a video that could only be selected by
       * clicking its first quadrant.
       */
      video.once(Phaser.GameObjects.Events.VIDEO_CREATED, () => {
        const entry = this.live.get(node.id);
        if (!entry) return;

        const area = (video.input?.hitArea ?? null) as Phaser.Geom.Rectangle | null;
        if (area instanceof Phaser.Geom.Rectangle) {
          // The rectangle was built as (-padX, -padY, w + 2padX, h + 2padY), so
          // its own corner says what the padding was — a tap area widened for
          // thumbs stays widened.
          const padX = -area.x;
          const padY = -area.y;
          area.setTo(-padX, -padY, video.width + padX * 2, video.height + padY * 2);
        }

        // Origin is a fraction of the size, so it was wrong for the same reason.
        this.applyTransform(entry);
        this.drawSelection();
      });

      // Muted while editing whatever the node says, and played anyway: a still
      // black rectangle is not a picture of what this node is, and nobody
      // arranging a scene asked to be talked at by it.
      const muted = this.mode === 'edit' ? true : props.muted !== false;
      const loop = props.loop === true;
      video.setMute(muted);

      if (this.mode === 'edit' || props.autoplay !== false) {
        // A browser refuses to autoplay anything audible, and refuses quietly:
        // the video simply never starts, which reads as a broken asset.
        video.play(this.mode === 'edit' ? true : loop);
      }
      return video;
    }

    if (node.kind === 'text') {
      return this.add.text(0, 0, this.resolveText(node), {
        fontFamily: props.fontFamily || 'sans-serif',
        fontSize: `${props.fontSize || 32}px`,
        color: props.color || '#ffffff',
        align: props.align || 'center'
      });
    }

    const width = props.width || 100;
    const height = props.height || 100;
    const fill = toColor(props.fill || '#ffffff', 0xffffff);
    const alpha = props.fillAlpha ?? 1;
    return props.shape === 'circle'
      ? this.add.ellipse(0, 0, width, height, fill, alpha)
      : this.add.rectangle(0, 0, width, height, fill, alpha);
  }

  /**
   * Input, with a hit area Phaser can actually test. Enabling input without one
   * does not throw — it succeeds, and then dies on the first pointer move with
   * "hitAreaCallback is not a function", which is a long way from the call that
   * caused it. A container has no size of its own, so its area comes from what
   * is inside it, and an empty one gets no input at all: there is nothing there
   * to hit.
   *
   * Returns whether the object ended up interactive.
   */
  private makeInteractive(
    object: Phaser.GameObjects.GameObject,
    config: Record<string, unknown>,
    padX = 0,
    padY = 0
  ): boolean {
    const shaped = object as Phaser.GameObjects.GameObject & {
      width?: number;
      height?: number;
      x?: number;
      y?: number;
      scaleX?: number;
      scaleY?: number;
    };

    // A texture's hit area is measured from its top-left, whatever its origin.
    let left = -padX;
    let top = -padY;
    let width = (shaped.width || 0) + padX * 2;
    let height = (shaped.height || 0) + padY * 2;

    if (object instanceof Phaser.GameObjects.Container) {
      const bounds = object.getBounds();
      // ponytail: bounds are axis-aligned and world-space, so a rotated group
      // gets its bounding box rather than its shape. Fine for picking a group up.
      const scaleX = shaped.scaleX || 1;
      const scaleY = shaped.scaleY || 1;
      left = (bounds.x - (shaped.x || 0)) / scaleX - padX;
      top = (bounds.y - (shaped.y || 0)) / scaleY - padY;
      width = bounds.width / scaleX + padX * 2;
      height = bounds.height / scaleY + padY * 2;
    }

    if (width <= 0 || height <= 0) return false;

    object.setInteractive({
      ...config,
      hitArea: new Phaser.Geom.Rectangle(left, top, width, height),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains
    });
    return true;
  }

  private makeTappable(node: GameNode, object: Phaser.GameObjects.GameObject, padX: number, padY: number): void {
    if (!this.makeInteractive(object, { useHandCursor: true }, padX, padY)) {
      // Nothing to tap. Saying so beats a tap rule that silently never fires.
      console.warn(`[GameScene] "${node.name || node.id}" has nothing to tap`);
      return;
    }

    object.on('pointerdown', () => {
      if (this.mode === 'edit') return;
      this.fire({ on: 'tap' }, node.id);
    });
  }

  // --- text ------------------------------------------------------------------

  /**
   * Every counter the document mentions, whether or not a component declares
   * it. A behaviour can create one by adding to it, and until it does the value
   * is nothing — which would leave "{score}" showing literally to a player, or
   * a condition comparing against a counter that does not exist. Seeding them
   * at zero means a counter reads as zero from the first frame.
   *
   * Keys nothing mentions stay unknown on purpose: a mistyped "{scroe}" shows
   * itself rather than quietly rendering a zero the author never meant.
   */
  private seedCounters(): void {
    const note = (key: string) => {
      if (!this.counters.has(key)) this.counters.set(key, 0);
    };

    for (const scene of this.doc.scenes) {
      const walk = (nodes: GameNode[]): void => {
        for (const node of nodes) {
          for (const component of node.components) {
            if (component.type === 'counter') note(component.key);
          }
          for (const behavior of node.behaviors) {
            if (behavior.event.on === 'counterChange') note(behavior.event.key);
            for (const condition of behavior.conditions) {
              if (condition.check !== 'counter') continue;
              note(condition.key);
              if (typeof condition.value !== 'number') note(condition.value.counter);
            }
            for (const action of behavior.actions) {
              if (action.do === 'addToCounter' || action.do === 'setCounter') {
                note(action.key);
              }
            }
          }
          walk(node.children);
        }
      };
      walk(scene.nodes);
    }

    for (const outcome of [this.doc.win, this.doc.lose]) {
      for (const condition of outcome?.conditions ?? []) {
        if (condition.check !== 'counter') continue;
        note(condition.key);
        if (typeof condition.value !== 'number') note(condition.value.counter);
      }
    }
  }

  private authoredText(node: GameNode): string {
    const dictionary = node.props?.text || {};
    return dictionary[this.doc.defaultLocale] ?? Object.values(dictionary)[0] ?? '';
  }

  /**
   * What a text node actually shows. Counters are values with nowhere to appear
   * on their own, so text is where they surface:
   *
   *  - "{score} left" substitutes any counter named in braces, so a value can
   *    sit inside a sentence;
   *  - text carrying a counter component and no placeholder shows that
   *    counter's value, because attaching a counter to a piece of text is the
   *    gesture that means "display this".
   */
  /** Whether this node's text is derived from a counter, and so worth redrawing. */
  private bindsCounter(node: GameNode): boolean {
    return /\{[^}]+\}/.test(this.authoredText(node)) || node.components.some((component) => component.type === 'counter');
  }

  private resolveText(node: GameNode): string {
    const raw = this.authoredText(node);

    if (/\{[^}]+\}/.test(raw)) {
      return raw.replace(/\{([^}]+)\}/g, (match, key: string) => {
        const value = this.counters.get(key.trim());
        return value === undefined ? match : String(value);
      });
    }

    const own = node.components.find((component) => component.type === 'counter');
    return own ? String(this.counters.get(own.key) ?? 0) : raw;
  }

  /** Re-reads every text node after a counter moves. */
  private refreshTexts(): void {
    for (const entry of Array.from(this.live.values())) {
      if (entry.node.kind !== 'text') continue;
      // Only text that is a view of a counter. This runs on every counter
      // write, and it used to rewrite every text node in the scene from the
      // document — so a script that wrote to one had its work undone by the
      // next add(), which is how a noughts and crosses board kept showing the
      // letter it was authored with instead of the move that was played.
      if (!this.bindsCounter(entry.node)) continue;

      const target = entry.object as Phaser.GameObjects.Text;
      const next = this.resolveText(entry.node);
      if (target.text !== next) target.setText(next);
    }

    // A changed value changes the box the handles hang off.
    if (this.mode === 'edit') this.drawSelection();
  }

  // --- physics ---------------------------------------------------------------

  private attachBody(
    node: GameNode,
    object: Phaser.GameObjects.GameObject,
    component: Extract<GameComponent, { type: 'body' }>
  ): void {
    this.physics.add.existing(object, component.kind === 'static');

    const body = (
      object as Phaser.GameObjects.GameObject & {
        body?: Phaser.Physics.Arcade.Body;
      }
    ).body;

    if (body && component.kind === 'dynamic') {
      body.setVelocity(component.velocityX, component.velocityY);
      body.setBounce(component.bounce, component.bounce);
      body.setDrag(component.drag, component.drag);
      body.setCollideWorldBounds(component.collideWorldBounds);
      if (component.gravityY !== undefined) body.setGravityY(component.gravityY);

      if (component.sizeScale !== 1) {
        body.setSize(body.width * component.sizeScale, body.height * component.sizeScale, true);
      }

      // Leaving the world is only observable if Phaser is asked to watch for it.
      if (node.behaviors.some((behavior) => behavior.event.on === 'leaveBounds')) {
        body.onWorldBounds = true;
      }
    }

    // Indexed by tag so colliders are declared between tags rather than pairs.
    for (const tag of node.tags) {
      const group = this.bodiesByTag.get(tag) ?? [];
      group.push(object);
      this.bodiesByTag.set(tag, group);
    }
  }

  private attachTimer(node: GameNode, component: Extract<GameComponent, { type: 'timer' }>): void {
    if (!component.autoStart || component.mode !== 'countdown') return;

    this.timers.push(this.time.delayedCall(component.seconds * 1000, () => this.fire({ on: 'timerComplete' }, node.id)));
  }

  // --- spawning ----------------------------------------------------------------

  /**
   * A spawner clones prototypes on a timer. The prototypes are hidden while
   * playing: a node named as a spawner's source is a template rather than part
   * of the scene, and leaving it on screen puts a motionless copy in every game.
   */
  private attachSpawner(spawner: LiveNode, component: Extract<GameComponent, { type: 'spawner' }>): void {
    for (const sourceId of component.sources) {
      this.prototypes.add(sourceId);
      const prototype = this.live.get(sourceId);
      if (prototype) this.applyTransform(prototype);
    }

    if (!component.autoStart || component.rate <= 0 || !component.sources.length) return;

    this.timers.push(
      this.time.addEvent({
        delay: 1000 / component.rate,
        loop: true,
        callback: () => this.spawnOne(spawner, component)
      })
    );
  }

  private spawnOne(spawner: LiveNode, component: Extract<GameComponent, { type: 'spawner' }>): void {
    const alive = this.aliveBySpawner.get(spawner.node.id) ?? 0;
    if (component.maxAlive > 0 && alive >= component.maxAlive) return;

    const sourceId = component.sources[Math.floor(Math.random() * component.sources.length)];
    const prototype = this.live.get(sourceId);
    if (!prototype) return;

    const spread = (size: number) => (size ? (Math.random() - 0.5) * size : 0);
    const clone = this.cloneNode(prototype.node);
    clone.transform = {
      ...clone.transform,
      x: spawner.transform.x + spread(component.area.width),
      y: spawner.transform.y + spread(component.area.height)
    };

    this.buildNode(clone, undefined, spawner.sceneId);
    const spawned = this.live.get(clone.id);
    if (!spawned) return;

    this.aliveBySpawner.set(spawner.node.id, alive + 1);
    this.wireCollisionsFor(spawned);
    this.fire({ on: 'spawn' }, clone.id);

    const retire = () => {
      if (!this.live.has(clone.id)) return;
      spawned.object.destroy();
      this.live.delete(clone.id);
      this.aliveBySpawner.set(spawner.node.id, Math.max(0, (this.aliveBySpawner.get(spawner.node.id) ?? 1) - 1));
    };

    if (component.lifetime > 0) {
      this.timers.push(this.time.delayedCall(component.lifetime * 1000, retire));
    }
  }

  /** A deep copy with fresh ids, so clones never collide with their prototype. */
  private cloneNode(node: GameNode): GameNode {
    spawnCounter += 1;
    return {
      ...node,
      id: `${node.id}__spawn${spawnCounter}`,
      transform: { ...node.transform },
      components: node.components.map((component) => ({ ...component })),
      behaviors: node.behaviors.map((behavior) => ({ ...behavior })),
      children: node.children.map((child) => this.cloneNode(child))
    };
  }

  // --- dragging ----------------------------------------------------------------

  private attachDraggable(entry: LiveNode, component: Extract<GameComponent, { type: 'draggable' }>): void {
    const object = entry.object as Phaser.GameObjects.GameObject & {
      x?: number;
      y?: number;
    };

    if (!this.makeInteractive(object, { draggable: true, useHandCursor: true })) {
      console.warn(`[GameScene] "${entry.node.name || entry.node.id}" has nothing to drag`);
      return;
    }
    this.input.setDraggable(object as Phaser.GameObjects.GameObject, true);

    const home = { x: object.x ?? 0, y: object.y ?? 0 };

    object.on('dragstart', () => {
      home.x = object.x ?? 0;
      home.y = object.y ?? 0;
      if (component.bringToTop) this.children.bringToTop(entry.object);
      this.fire({ on: 'dragStart' }, entry.node.id);
    });

    object.on('drag', (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      if (component.axis !== 'y') object.x = dragX;
      if (component.axis !== 'x') object.y = dragY;
    });

    object.on('dragend', () => {
      const zone = this.dropZoneUnder(entry);
      if (zone) {
        const correct = entry.node.tags.some((tag) => zone.accepts.includes(tag));
        // A wrong piece is held only where the zone allows it; it still counts
        // as a wrong drop, so nothing scoring correct ones is affected.
        const held = correct || zone.allowIncorrect;

        if (held && zone.snap) {
          const target = zone.entry.object as unknown as { x: number; y: number };
          object.x = target.x;
          object.y = target.y;
        }
        if (held) {
          // One slot, one piece: a piece moving here leaves wherever it was.
          for (const other of this.dropZones) {
            if (other.holding === entry.node.id) other.holding = undefined;
          }
          zone.holding = entry.node.id;
        }

        if (correct && zone.lockOnCorrect) {
          // Placed is placed. Without this a piece can be pulled out and
          // dropped again, and anything counting correct drops counts it twice.
          this.input.setDraggable(entry.object as Phaser.GameObjects.GameObject, false);
          zone.filledBy = entry.node.id;
        }
        // Both sides hear it, each told who the other was: the piece that moved
        // and the slot that received it.
        this.fire({ on: 'drop', correct }, entry.node.id, zone.entry.node.id);
        this.fire({ on: 'drop', correct }, zone.entry.node.id, entry.node.id);
        // A held wrong piece stays where it was put, so it is never sprung back.
        if (held) return;
      }

      if (component.returnOnRelease) {
        this.tweens.add({
          targets: entry.object,
          x: home.x,
          y: home.y,
          duration: 200,
          ease: 'Quad.easeOut'
        });
      }

      this.fire({ on: 'dragEnd' }, entry.node.id);
    });
  }

  private dropZoneUnder(entry: LiveNode) {
    const bounds = (
      entry.object as Phaser.GameObjects.GameObject & {
        getBounds?: () => Phaser.Geom.Rectangle;
      }
    ).getBounds?.();
    if (!bounds) return undefined;

    return this.dropZones.find((zone) => {
      if (zone.filledBy) return false;
      const area = (
        zone.entry.object as Phaser.GameObjects.GameObject & {
          getBounds?: () => Phaser.Geom.Rectangle;
        }
      ).getBounds?.();
      return area ? Phaser.Geom.Intersects.RectangleToRectangle(bounds, area) : false;
    });
  }

  /**
   * Collisions are declared between tags, so one rule covers however many nodes
   * carry that tag — including ones that do not exist yet. Overlap passes
   * through; collide separates the bodies as well.
   */
  private wireCollisions(): void {
    for (const entry of Array.from(this.live.values())) this.wireCollisionsFor(entry);

    this.physics.world.on('worldbounds', (body: Phaser.Physics.Arcade.Body) => {
      const entry = Array.from(this.live.values()).find(
        (candidate) => (candidate.object as { body?: unknown }).body === body
      );
      if (entry) this.fire({ on: 'leaveBounds' }, entry.node.id);
    });
  }

  /**
   * Declares one node's collision rules. Each is against the ARRAY of bodies
   * carrying a tag, not the objects in it right now — Arcade re-reads the array
   * every step, so a node spawned later joins the rule simply by being pushed
   * into it. The array is created even when empty for the same reason: a rule
   * naming a tag nothing carries yet still has to be live when something does.
   */
  private wireCollisionsFor(entry: LiveNode): void {
    for (const behavior of entry.node.behaviors) {
      const event = behavior.event;
      if (event.on !== 'collide' && event.on !== 'overlap') continue;

      let others = this.bodiesByTag.get(event.tag);
      if (!others) {
        others = [];
        this.bodiesByTag.set(event.tag, others);
      }

      // Phaser hands the callback both bodies; the second is what was hit, and
      // naming it is what lets a rule act on the thing rather than on itself.
      const raise = (_self: unknown, hit: unknown) => {
        const other = Array.from(this.live.values()).find((candidate) => (candidate.object as unknown) === hit);
        this.fire({ on: event.on as 'collide' | 'overlap', tag: event.tag }, entry.node.id, other?.node.id);
      };

      if (event.on === 'overlap') this.physics.add.overlap(entry.object, others, raise);
      else this.physics.add.collider(entry.object, others, raise);
    }
  }

  // --- layout ---------------------------------------------------------------

  /**
   * One animation per node, named after it.
   *
   * Per node rather than per sheet: two sprites can share a texture and run
   * different ranges of it at different speeds, which is the whole point of
   * cutting a sheet into more than one animation.
   *
   * In edit mode it is defined but never started. An author positioning a
   * sprite wants to see a frame of it, not a thing that moves while they aim.
   */
  private defineAnimation(
    sprite: Phaser.GameObjects.Sprite,
    node: GameNode,
    animation: NonNullable<SpriteProps['animation']>,
    cells: number
  ): void {
    const key = `anim:${node.id}`;
    // Clamped to what the sheet actually has. A range typed against one cell
    // size still names frames after it is changed to another, and asking for a
    // frame that is not there is how this threw in the first place.
    const last = cells - 1;
    const from = Math.max(0, Math.min(animation.from, last));
    const to = Math.max(from, Math.min(animation.to, last));

    // Rebuilt on every restart: the range or the speed may have just changed,
    // and Phaser keeps animations on the game rather than the scene.
    if (this.anims.exists(key)) this.anims.remove(key);
    this.anims.create({
      key,
      frames: this.anims.generateFrameNumbers(node.props?.assetId as string, { start: from, end: to }),
      frameRate: animation.fps,
      repeat: animation.loop ? -1 : 0
    });

    if (this.mode === 'play' && animation.autoplay) sprite.play(key);
  }

  /**
   * The image behind everything.
   *
   * Sized to cover rather than to fit: a background that fits leaves bars, and
   * a playable is shown at whatever shape the network's frame happens to be.
   * The colour underneath still matters — it is what shows through a
   * transparent PNG, and what is there before the texture arrives.
   */
  private paintBackground(): void {
    const key = this.doc.settings.backgroundImageId;
    if (!key || !this.textures.exists(key)) return;

    this.background = this.add.image(0, 0, key).setDepth(-10_000).setScrollFactor(0);
    this.fitBackground();
  }

  private fitBackground(): void {
    if (!this.background) return;

    const { width, height } = this.viewport();
    const source = this.background.texture.getSourceImage();
    const scale = Math.max(width / source.width, height / source.height);

    this.background.setPosition(width / 2, height / 2).setScale(scale);
  }

  private relayout = (): void => {
    this.fitBackground();

    const orientation = orientationOf(this.viewport());
    const rotated = orientation !== this.orientation;
    this.orientation = orientation;

    for (const entry of Array.from(this.live.values())) {
      if (rotated) {
        // Re-resolve from the authored values so the other orientation's patch
        // is dropped rather than layered on top of it.
        entry.transform = { ...resolveTransform(entry.node.transform, entry.node.overrides, orientation) };
      }
      this.applyTransform(entry);
    }

    // The world is the visible area; a rotated device changes what "off screen"
    // means for collideWorldBounds and the leaveBounds event.
    if (this.mode === 'play') {
      const { width, height } = this.viewport();
      this.physics.world.setBounds(0, 0, width, height);
    }

    this.drawSelection();

    /**
     * Told after everything has been re-placed, not before.
     *
     * Layout looks after the nodes the panels positioned. A script that sized
     * something itself has no such rule — setDisplaySize is a measurement, and
     * a full-screen overlay measured once is the size the screen used to be.
     * This is the moment to measure again.
     */
    if (this.mode === 'play') this.fire({ on: 'resize' });
  };

  private applyTransform(entry: LiveNode): void {
    const { object, transform } = entry;
    // Once a body is simulating, the physics engine owns the position. Writing
    // the authored one back on every resize would teleport a falling node home.
    const simulating = this.mode === 'play' && !!(object as { body?: unknown }).body;
    const target = object as Phaser.GameObjects.GameObject & Record<string, (...args: never[]) => unknown>;
    const design = { width: this.doc.settings.designWidth, height: this.doc.settings.designHeight };

    const placement = entry.isRoot
      ? rootPlacement(transform, design, this.viewport())
      : { x: transform.x, y: transform.y, scaleX: transform.scaleX, scaleY: transform.scaleY };

    const setters = object as unknown as {
      setPosition?: (x: number, y: number) => void;
      setScale?: (x: number, y: number) => void;
      /** Phaser's own, stashed before a script's handle shadowed it. */
      nativeSetScale?: (x: number, y: number) => void;
      setAngle?: (deg: number) => void;
      setAlpha?: (a: number) => void;
      setDepth?: (d: number) => void;
      setVisible?: (v: boolean) => void;
      setOrigin?: (x: number, y: number) => void;
    };

    if (!simulating) setters.setPosition?.(placement.x, placement.y);
    /**
     * Called against the object, not as a bare function.
     *
     * `setters.setScale?.(x, y)` passes the object as `this`; wrapping the
     * choice in parentheses — `(a ?? b)?.(x, y)` — does not. Phaser's setScale
     * then ran with no receiver and set nothing, on code the build does not
     * put in strict mode, so it failed in complete silence: the document took
     * the new scale, the picture never changed, and moving a node still worked
     * because setPosition below kept its receiver.
     *
     * The original rather than the handle a script was given: that one calls
     * back into here, and the pair recursed until the stack ran out.
     */
    const applyScale = setters.nativeSetScale ?? setters.setScale;
    applyScale?.call(object, placement.scaleX, placement.scaleY);
    setters.setAngle?.(transform.rotation);
    setters.setAlpha?.(transform.alpha);
    /**
     * An overlay is above the scene it is over, whatever else is on it.
     *
     * Its own depth still orders overlays among themselves — two of them can
     * be layered — it is only lifted clear of the scene's own range. Below the
     * editor's handles, which have to stay on top of everything.
     */
    setters.setDepth?.(
      entry.node.overlay ? OVERLAY_DEPTH + transform.depth : transform.depth
    );
    setters.setVisible?.(
      transform.visible &&
        (entry.node.overlay || entry.sceneId === this.visibleScene) &&
        !(this.mode === 'play' && this.prototypes.has(entry.node.id))
    );
    // Containers have no origin; everything else is centred by default.
    setters.setOrigin?.(transform.originX, transform.originY);
    void target;
  }

  // --- behaviours -----------------------------------------------------------

  /** Run every behaviour whose event matches, optionally limited to one node. */
  /**
   * Told to one scene's own things, and nothing else.
   *
   * fire() sends an event to everything alive; this one is about a particular
   * screen arriving, so it goes only to what is on it. The same handler
   * written on two scenes therefore runs once for each, when each opens —
   * which is the whole point of asking for it per scene rather than per game.
   *
   * A node's script belongs to the scene the node is on; a scene's script to
   * the scene it is written on.
   */
  private fireSceneStart(sceneId: string): void {
    if (this.mode !== 'play') return;

    const event = { on: 'sceneStart' } as const;
    const scene = this.doc.scenes.find((candidate) => candidate.id === sceneId);
    const label = scene?.name || sceneId;

    for (const entry of Array.from(this.live.values())) {
      if (entry.sceneId !== sceneId) continue;
      for (const behavior of entry.node.behaviors) {
        if (!this.eventMatches(behavior.event, event)) continue;
        if (!behavior.conditions.every((condition) => this.conditionHolds(condition))) continue;
        this.runActions(behavior, entry);
      }
    }

    for (const [owner, handlers] of Array.from(this.scriptHandlers.entries())) {
      const ownerScene = owner.startsWith('scene:')
        ? owner.slice('scene:'.length)
        : this.live.get(owner)?.sceneId;
      if (ownerScene !== sceneId) continue;

      this.callHandlers(owner, handlers.get('sceneStart'), label, event);
    }
  }

  private fire(event: Behavior['event'], nodeId?: string, subjectId?: string): void {
    for (const entry of Array.from(this.live.values())) {
      if (nodeId && entry.node.id !== nodeId) continue;

      for (const behavior of entry.node.behaviors) {
        if (!this.eventMatches(behavior.event, event)) continue;
        if (!behavior.conditions.every((condition) => this.conditionHolds(condition))) continue;
        this.runActions(behavior, entry, subjectId);
      }
    }

    this.dispatchToScripts(event, nodeId, subjectId);
  }

  // --- scripts --------------------------------------------------------------

  /**
   * Authored code runs as data, not as part of the bundle: the same document
   * plays here and in the exported file, so what an author tests is what ships.
   * Nothing is compiled per project, which is what keeps the preview instant
   * instead of a webpack run per keystroke.
   *
   * ponytail: that means an exported file needs `new Function`. If a network
   * ever ships a CSP that forbids it, compile scripts into the bundle at export
   * — at the cost of a build per preview.
   */
  private runScripts(): void {
    this.scriptHandlers.clear();
    this.scriptErrors.clear();

    for (const scene of this.doc.scenes) {
      if (scene.script.trim()) {
        this.runScript(`scene:${scene.id}`, scene.name || scene.id, scene.script);
      }
    }

    for (const entry of Array.from(this.live.values())) {
      if (entry.node.script.trim()) {
        this.runScript(entry.node.id, entry.node.name || entry.node.id, entry.node.script, entry);
      }
    }
  }

  private runScript(owner: string, label: string, source: string, entry?: LiveNode): void {
    const handlers = new Map<string, ScriptHandler[]>();
    this.scriptHandlers.set(owner, handlers);

    const on = (event: string, handler: ScriptHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    };

    /**
     * Animating from a script, through the same path the tween action takes.
     *
     * Not scene.tweens.add: that works in screen pixels, while everything an
     * author writes is in design space, and a node laid out against an anchor
     * is not where its x says it is. This converts, and writes the destination
     * back to the node when it lands, so a later resize keeps the new position
     * rather than snapping back to the authored one.
     */
    const tweenTo = (nameOrId: string | Phaser.GameObjects.GameObject, to: Record<string, unknown> = {}) => {
      const entry =
        typeof nameOrId === 'string'
          ? this.findLive(nameOrId)
          : Array.from(this.live.values()).find((live) => live.object === nameOrId);

      if (!entry) {
        throw new Error(`There is nothing to animate called "${String(nameOrId)}". ${this.nameList()}`);
      }

      const { duration, easing, curve, repeat, yoyo, ...destination } = to as {
        duration?: number;
        easing?: Easing;
        curve?: [number, number, number, number];
        repeat?: number;
        yoyo?: boolean;
      };

      this.runTween(entry, {
        do: 'tween',
        to: destination as Partial<Transform>,
        duration: duration ?? 300,
        easing: easing ?? (curve ? 'custom' : 'quadOut'),
        curve,
        repeat: repeat ?? 0,
        yoyo: yoyo ?? false
      } as Extract<GameAction, { do: 'tween' }>);
    };

    // A sound node draws nothing, so its container is no use to a script. What
    // a script wants from find('music') is the sound itself.
    const objectFor = (nameOrId: string) => {
      const found = this.findLive(nameOrId);
      /**
       * Says what is missing, rather than handing back undefined for a script
       * to trip over one line later. "Cannot read properties of undefined
       * (reading 'setText')" tells an author nothing about which name was
       * wrong; this names it, and lists what there is to choose from.
       */
      if (!found) throw new Error(`There is no node called "${nameOrId}". ${this.nameList()}`);

      // Only a sound node IS its sound — it draws nothing, so there is no
      // other object to want. Anything else is a thing on screen that may also
      // play a sound: a tile with a place-sound is still a tile, and handing
      // back its sound made find() return something with no x, no filledWith
      // and no shake().
      if (found.node.kind === 'sound' && found.sound) return found.sound;

      this.describeFill(found);
      this.attachNodeActions(found);
      this.attachSoundHandle(found);
      return found.object;
    };

    try {
      // Named parameters rather than a context object: a script reads as
      // ordinary code, and there is no `this` to get wrong. Keep this list and
      // the help text in the editor's script panel in step.
      const factory = new Function(
        'node',
        'scene',
        'on',
        'get',
        'set',
        'add',
        'find',
        'tween',
        'goTo',
        'setState',
        'win',
        'lose',
        `"use strict";\n${source}`
      );

      factory(
        entry?.object,
        this,
        on,
        (key: string) => this.counters.get(key) ?? 0,
        (key: string, value: number) => this.writeCounter(key, value),
        (key: string, amount: number) => this.writeCounter(key, (this.counters.get(key) ?? 0) + amount),
        objectFor,
        tweenTo,
        (nameOrId: string) => {
          const scene =
            this.doc.scenes.find((candidate) => candidate.id === nameOrId) ??
            this.doc.scenes.find((candidate) => candidate.name === nameOrId);
          if (scene) this.showScene(scene.id);
        },
        // The same thing the set-state action does. win() and lose() were
        // already this with the name filled in, so leaving it out was an
        // arbitrary hole — and the copilot reached through it twice.
        (name: string) => this.enterState(name, true),
        () => this.enterState(this.doc.win?.state ?? 'endcard', true),
        () => this.enterState(this.doc.lose?.state ?? 'lose', true)
      );

      // No 'start' call here: create() fires it once every script has been
      // compiled, and calling it here as well ran every start handler twice.
      if (entry && handlers.has('tap')) this.makeTappableForScript(entry);
    } catch (error) {
      this.reportScriptError(owner, label, error);
    }
  }

  /**
   * `on('tap')` in a script is the same declaration a tap behaviour makes, so
   * it earns the same hit area. Without this the handler is simply never
   * called, and nothing says why.
   */
  private makeTappableForScript(entry: LiveNode): void {
    if (entry.object.input) return;
    this.makeTappable(entry.node, entry.object, 0, 0);
  }

  /**
   * What is sitting in this drop zone, as the tag it matched on — the currency
   * a drop zone already deals in, since `accepts` is a list of tags. Reading it
   * is how a script asks what was spelled, which is the whole of a word puzzle
   * and cannot be expressed as a behaviour.
   *
   * A live getter rather than a value: the answer changes as the game is
   * played, and a script reads it long after this ran.
   */
  private describeFill(entry: LiveNode): void {
    const target = entry.object as Phaser.GameObjects.GameObject & {
      filledWith?: string;
    };
    if ('filledWith' in target) return;

    Object.defineProperty(target, 'filledWith', {
      configurable: true,
      get: () => {
        const zone = this.dropZones.find((candidate) => candidate.entry === entry);
        const filler = zone?.holding ? this.live.get(zone.holding) : undefined;
        if (!filler) return '';
        return filler.node.tags[0] ?? filler.node.name;
      }
    });
  }

  /**
   * The two actions a script keeps reaching for. Both already exist as
   * behaviour actions with a working implementation; there was simply no way to
   * run one from code, so a script that wanted to shake a tile had to be told
   * it could not — three separate answers from the copilot tried to call these
   * before they existed.
   */
  private attachNodeActions(entry: LiveNode): void {
    const target = entry.object as Phaser.GameObjects.GameObject & {
      shake?: (intensity?: number, duration?: number) => void;
      resetPosition?: () => void;
      playAnimation?: () => void;
      stopAnimation?: () => void;
      setDisplaySize?: (width: number, height: number) => unknown;
      setScale?: (x: number, y?: number) => unknown;
    };
    if (target.shake) return;

    target.shake = (intensity = 12, duration = 300) => {
      this.runAction({ do: 'shake', target: entry.node.id, intensity, duration } as GameAction, entry);
    };
    target.resetPosition = () => this.resetNode(entry);

    /**
     * Sizing that survives a rotation.
     *
     * Phaser's own setDisplaySize and setScale change the object; this scene's
     * layout re-applies the authored transform on every resize, so a script
     * that used them watched its work vanish the moment a device turned — the
     * node came back at the size the panel says it is. Measured: a sprite told
     * to be 200x200 was 269x67 again after one rotation.
     *
     * Writing the authored scale instead means the intent is re-applied rather
     * than overwritten, and a root node still gets the screen-fit factor that
     * anchoring depends on.
     */
    const sized = entry.object as unknown as { width?: number; height?: number };
    target.setDisplaySize = (width: number, height: number) => {
      const naturalWidth = sized.width || 0;
      const naturalHeight = sized.height || 0;
      // A container has no size of its own; there is nothing to scale against,
      // so this falls back to Phaser's behaviour rather than dividing by zero.
      if (naturalWidth <= 0 || naturalHeight <= 0) return entry.object;

      /**
       * Divided back out, so the number means what its name says.
       *
       * A root node's authored scale is multiplied by the screen-fit factor
       * when it is placed. Storing width/natural therefore asked for
       * width * factor pixels — and in an editor preview, where the frame is
       * smaller than the design canvas, that factor is well under one:
       * setDisplaySize(screenWidth, screenHeight) produced an image less than
       * half the screen. Which is how this was reported.
       */
      const fit = entry.isRoot
        ? layoutScale(
            entry.transform.fit,
            {
              width: this.doc.settings.designWidth,
              height: this.doc.settings.designHeight
            },
            this.viewport()
          )
        : { sx: 1, sy: 1 };

      entry.transform.scaleX = width / (naturalWidth * (fit.sx || 1));
      entry.transform.scaleY = height / (naturalHeight * (fit.sy || 1));
      this.applyTransform(entry);
      return entry.object;
    };

    /**
     * Phaser's own, kept before it is shadowed.
     *
     * applyTransform writes the authored scale through setScale, and the
     * override below calls applyTransform — so without keeping the original
     * the two called each other until the stack ran out. Which they did.
     */
    const native = entry.object as unknown as {
      setScale: (x: number, y?: number) => unknown;
      nativeSetScale?: (x: number, y?: number) => unknown;
    };
    native.nativeSetScale = native.setScale.bind(entry.object);

    target.setScale = (x: number, y = x) => {
      entry.transform.scaleX = x;
      entry.transform.scaleY = y;
      this.applyTransform(entry);
      return entry.object;
    };

    /**
     * Its own animation, by a name that says what it does.
     *
     * Not Phaser's `play(key)`: the key is generated from the node id, so
     * asking a script to know it would be asking it to know an implementation
     * detail. A sprite that has no animation gets the methods anyway and they
     * do nothing, which is a better answer than a script that throws because
     * an author has not cut the sheet yet.
     */
    const sprite = entry.object as Phaser.GameObjects.Sprite;
    target.playAnimation = () => {
      if (sprite.anims && this.anims.exists(`anim:${entry.node.id}`)) {
        sprite.play(`anim:${entry.node.id}`, true);
      }
    };
    target.stopAnimation = () => {
      if (sprite.anims) sprite.stop();
    };
  }

  /** Its sound, for a node that has one and is also something on screen. */
  private attachSoundHandle(entry: LiveNode): void {
    if (!entry.sound) return;
    const target = entry.object as Phaser.GameObjects.GameObject & {
      sound?: Phaser.Sound.BaseSound;
    };
    if (target.sound) return;
    target.sound = entry.sound;
  }

  /** The object a script would get from find(), for a node id. */
  private objectOf(nodeId: string): Phaser.GameObjects.GameObject | undefined {
    const entry = this.live.get(nodeId);
    if (!entry) return undefined;
    this.describeFill(entry);
    this.attachNodeActions(entry);
    return entry.object;
  }

  private dispatchToScripts(event: Behavior['event'], nodeId?: string, subjectId?: string): void {
    if (!this.scriptHandlers.size) return;

    // Whatever the event carries, in the handler's first argument: the other
    // node in a collision or a drop, and for a counter, what it changed to.
    // Every event that carries something hands it over the same way.
    const subject =
      event.on === 'counterChange'
        ? { key: event.key, value: this.counters.get(event.key) ?? 0 }
        // The new size, so a handler does not have to go and ask for it.
        : event.on === 'resize'
        ? this.viewport()
        : event.on === 'stateEnter'
        ? event.state
        : subjectId
        ? this.objectOf(subjectId)
        : // A tap names the node it landed on. Without it a scene script
        // hearing every tap cannot tell which of nine cells was pressed,
        // which is most of what a scene script is for.
        nodeId
        ? this.objectOf(nodeId)
        : undefined;

    for (const [owner, handlers] of Array.from(this.scriptHandlers.entries())) {
      // A node's script hears its own events; a scene's script hears the lot,
      // which is what makes it the place to put rules about the whole screen.
      const isScene = owner.startsWith('scene:');
      if (nodeId && !isScene && owner !== nodeId) continue;

      this.callHandlers(owner, handlers.get(event.on), subject, event);
    }
  }

  private callHandlers(owner: string, handlers: ScriptHandler[] | undefined, payload: unknown, event: unknown): void {
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(payload, event);
      } catch (error) {
        this.reportScriptError(owner, owner.replace(/^scene:/, ''), error);
      }
    }
  }

  private reportScriptError(owner: string, label: string, error: unknown): void {
    // Once per script. An update handler that throws does so every frame, and
    // sixty identical messages a second buries whatever else went wrong.
    if (this.scriptErrors.has(owner)) return;
    this.scriptErrors.add(owner);

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[script: ${label}] ${message}`);
    this.onEditorAction?.({
      type: 'game-editor:error',
      message: `Script on "${label}": ${message}`
    });
  }

  /** Counters written from a script take the same path as the action does. */
  private writeCounter(key: string, value: number): void {
    this.counters.set(key, value);
    this.refreshTexts();
    this.fire({ on: 'counterChange', key });
    this.checkOutcomes();
  }

  /** What a script could have meant, for an error worth reading. */
  private nameList(): string {
    const names = Array.from(this.live.values())
      .filter((entry) => entry.sceneId === this.visibleScene)
      .map((entry) => entry.node.name || entry.node.id);

    if (!names.length) return 'This scene has no nodes.';
    const shown = names.slice(0, 12).join(', ');
    return `This scene has: ${shown}${names.length > 12 ? `, and ${names.length - 12} more` : ''}.`;
  }

  private findLive(nameOrId: string): LiveNode | undefined {
    return this.live.get(nameOrId) ?? Array.from(this.live.values()).find((entry) => entry.node.name === nameOrId);
  }

  update(_time: number, delta: number): void {
    if (!this.scriptHandlers.size) return;
    for (const [owner, handlers] of Array.from(this.scriptHandlers.entries())) {
      this.callHandlers(owner, handlers.get('update'), delta / 1000, undefined);
    }
  }

  /**
   * An event fires a behaviour only when what it carries matches too. Without
   * this a node with two collision rules ran both on either collision, and a
   * "when the right piece lands" behaviour ran for wrong ones as well.
   */
  private eventMatches(declared: Behavior['event'], fired: Behavior['event']): boolean {
    if (declared.on !== fired.on) return false;

    if (declared.on === 'counterChange' && fired.on === 'counterChange') {
      return declared.key === fired.key;
    }
    if (declared.on === 'stateEnter' && fired.on === 'stateEnter') {
      return declared.state === fired.state;
    }
    if ((declared.on === 'collide' || declared.on === 'overlap') && (fired.on === 'collide' || fired.on === 'overlap')) {
      return declared.tag === fired.tag;
    }
    if (declared.on === 'drop' && fired.on === 'drop') {
      // Undefined means either outcome, which is what a fresh behaviour has
      // until the author narrows it.
      return declared.correct === undefined || declared.correct === fired.correct;
    }

    return true;
  }

  private conditionHolds(condition: Condition): boolean {
    if (condition.check === 'state') return this.state === condition.state;

    const left = this.counters.get(condition.key) ?? 0;
    // The right-hand side is a fixed number or another counter, so a rule like
    // "placed >= total" moves as the game does.
    const right = typeof condition.value === 'number' ? condition.value : this.counters.get(condition.value.counter) ?? 0;

    switch (condition.op) {
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '==':
        return left === right;
      case '>=':
        return left >= right;
      case '>':
        return left > right;
      default:
        return left !== right;
    }
  }

  /**
   * Sequential by default: each action starts after the ones before it, and a
   * `wait` pushes everything after it out. Parallel behaviours start together.
   */
  private runActions(behavior: Behavior, entry: LiveNode, subjectId?: string): void {
    let delay = 0;

    for (const action of behavior.actions) {
      if (action.do === 'wait') {
        if (!behavior.parallel) delay += action.seconds * 1000;
        continue;
      }

      if (delay <= 0) {
        this.runAction(action, entry, subjectId);
      } else {
        this.time.delayedCall(delay, () => this.runAction(action, entry, subjectId));
      }
    }
  }

  private runAction(action: GameAction, source: LiveNode, subjectId?: string): void {
    switch (action.do) {
      case 'openCta':
        sdk.install();
        return;

      case 'resetPosition': {
        const target = this.resolve(action.target, source, subjectId);
        if (target) this.resetNode(target);
        return;
      }

      case 'resetPositions':
        this.resetPositions();
        return;

      case 'goToScene':
        this.showScene(action.sceneId);
        return;

      case 'playSound':
        this.playSound(action.assetId);
        return;

      case 'setState':
        this.enterState(action.state);
        return;

      case 'addToCounter':
      case 'setCounter': {
        const next = action.do === 'setCounter' ? action.value : (this.counters.get(action.key) ?? 0) + action.amount;

        this.counters.set(action.key, next);
        this.refreshTexts();
        this.fire({ on: 'counterChange', key: action.key });
        this.checkOutcomes();
        return;
      }

      case 'show':
      case 'hide': {
        const target = this.resolve(action.target, source, subjectId);
        if (target) {
          target.transform.visible = action.do === 'show';
          this.applyTransform(target);
        }
        return;
      }

      case 'destroy': {
        const target = this.resolve(action.target, source, subjectId);
        if (target) {
          target.object.destroy();
          this.live.delete(target.node.id);
        }
        return;
      }

      case 'setProperty': {
        const target = this.resolve(action.target, source, subjectId);
        if (target && action.key in target.transform) {
          (target.transform as unknown as Record<string, unknown>)[action.key] = action.value;
          this.applyTransform(target);
        }
        return;
      }

      case 'playAnimation':
      case 'stopAnimation': {
        const target = this.resolve(action.target, source, subjectId);
        // Only a Sprite has animations; an Image is the plain-picture case and
        // has nothing to run, so this is a no-op rather than a crash.
        const sprite = target?.object as Phaser.GameObjects.Sprite | undefined;
        if (!sprite?.anims) return;
        if (action.do === 'playAnimation') sprite.play(`anim:${target!.node.id}`, true);
        else sprite.stop();
        return;
      }

      case 'shake': {
        const target = this.resolve(action.target, source, subjectId);
        if (!target) return;
        const object = target.object as unknown as { x?: number };
        const from = object.x ?? 0;
        this.tweens.add({
          targets: target.object,
          x: from + action.intensity,
          duration: Math.max(16, action.duration / 6),
          yoyo: true,
          repeat: 2,
          onComplete: () => this.applyTransform(target)
        });
        return;
      }

      case 'tween': {
        const target = this.resolve(action.target, source, subjectId);
        if (!target) return;
        this.runTween(target, action);
        return;
      }

      default:
        // 'spawn' needs the spawner component; warned about at build time.
        console.warn(`[GameScene] action "${action.do}" is not interpreted yet`);
    }
  }

  /**
   * Tween destinations are authored in design space, so they are converted
   * through the same placement maths as layout before Phaser sees them, and
   * written back to the node's transform on completion so a later resize keeps
   * the new position instead of snapping back to the authored one.
   */
  private runTween(target: LiveNode, action: Extract<GameAction, { do: 'tween' }>): void {
    const design = { width: this.doc.settings.designWidth, height: this.doc.settings.designHeight };
    const destination = { ...target.transform, ...action.to };
    const placement = target.isRoot
      ? rootPlacement(destination, design, this.viewport())
      : { x: destination.x, y: destination.y, scaleX: destination.scaleX, scaleY: destination.scaleY };

    this.tweens.add({
      targets: target.object,
      x: placement.x,
      y: placement.y,
      scaleX: placement.scaleX,
      scaleY: placement.scaleY,
      angle: destination.rotation,
      alpha: destination.alpha,
      duration: action.duration,
      // A drawn curve goes in as a function; a named one as Phaser's own name.
      ease:
        action.easing === 'custom'
          ? cubicBezier(...(action.curve ?? [0.25, 0.1, 0.25, 1]))
          : EASING[action.easing] || 'Quad.easeOut',
      repeat: action.repeat,
      yoyo: action.yoyo,
      onComplete: () => {
        if (action.repeat === -1 || action.yoyo) return;
        target.transform = destination;
      }
    });
  }

  /**
   * Back to the authored layout: every node returns to where it was placed, a
   * locked piece can be dragged again, and a slot that had claimed one is open.
   * Counters are left alone — putting the pieces back is not the same as
   * undoing the score, and a round that ended in a loss usually wants both
   * decided separately.
   */
  private resetPositions(): void {
    for (const entry of Array.from(this.live.values())) this.resetNode(entry);
    this.drawSelection();
  }

  /** One piece home, draggable again, and the slot it filled reopened. */
  private resetNode(entry: LiveNode): void {
    entry.transform = {
      ...resolveTransform(entry.node.transform, entry.node.overrides, this.orientation)
    };
    this.applyTransform(entry);

    if (entry.node.components.some((component) => component.type === 'draggable')) {
      this.input.setDraggable(entry.object as Phaser.GameObjects.GameObject, true);
    }

    for (const zone of this.dropZones) {
      if (zone.filledBy === entry.node.id) zone.filledBy = undefined;
      if (zone.holding === entry.node.id) zone.holding = undefined;
    }

    this.drawSelection();
  }

  private resolve(nodeId: string | undefined, fallback: LiveNode, subjectId?: string): LiveNode | undefined {
    if (!nodeId) return fallback;
    if (nodeId === OTHER_TARGET) {
      return subjectId ? this.live.get(subjectId) : undefined;
    }
    return this.live.get(nodeId);
  }

  // --- state ----------------------------------------------------------------

  private enterState(name: string, force = false): void {
    if (this.state === name && !force) return;
    this.state = name;

    const state = this.doc.states.find((candidate) => candidate.name === name);
    if (state) {
      for (const id of state.hide) this.setVisible(id, false);
      for (const id of state.show) this.setVisible(id, true);
    }

    const endcard = this.doc.scenes.find((scene) => scene.role === 'endcard');
    if (name === 'endcard' && endcard) this.showScene(endcard.id);

    this.fire({ on: 'stateEnter', state: name });

    if (!this.finished && (name === 'endcard' || name === this.doc.win?.state)) {
      this.finished = true;
      sdk.finish();
    }
  }

  /** Puts one scene on screen and takes the others off. */
  private showScene(sceneId: string): void {
    if (this.visibleScene === sceneId || !this.doc.scenes.some((s) => s.id === sceneId)) {
      return;
    }
    this.visibleScene = sceneId;
    for (const entry of Array.from(this.live.values())) this.applyTransform(entry);
    this.drawSelection();
    // After it is on screen, so a handler that measures something measures the
    // scene it is on rather than the one it replaced.
    this.fireSceneStart(sceneId);
  }

  private setVisible(nodeId: string, visible: boolean): void {
    const entry = this.live.get(nodeId);
    if (!entry) return;
    entry.transform.visible = visible;
    this.applyTransform(entry);
  }

  /**
   * Outcomes fire on a rising edge and re-arm when their conditions stop
   * holding. A lose state that resets whatever it watched can therefore be
   * reached again — without the latch the state simply stayed put and a second
   * loss was silent, which looks like the rule working exactly once.
   */
  private checkOutcomes(): void {
    for (const kind of ['win', 'lose'] as const) {
      const outcome = this.doc[kind];
      if (!outcome) continue;

      const holds = outcome.conditions.every((condition) => this.conditionHolds(condition));
      if (holds && !this.outcomeLatched[kind]) {
        this.outcomeLatched[kind] = true;
        // Forced, because a repeat of the same outcome is a fresh entry even
        // though the state has not changed.
        this.enterState(outcome.state, true);
      } else if (!holds) {
        this.outcomeLatched[kind] = false;
      }
    }
  }

  // --- audio ----------------------------------------------------------------

  /**
   * Phaser's audio loader reads its source with XHR and hands the result to
   * decodeAudioData, and a data URI comes back as text — "parameter 1 is not of
   * type 'ArrayBuffer'". Every exported playable embeds its assets as data
   * URIs, so this is the shipped case, not an edge one. A blob URL is the same
   * bytes at an address the loader can read.
   */
  private loadableMediaUrl(url: string): string {
    if (!url.startsWith('data:')) return url;

    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    if (!meta.includes('base64')) return url;

    try {
      const binary = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }

      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: meta.split(';')[0] }));
      this.blobUrls.push(blobUrl);
      return blobUrl;
    } catch {
      // Better a sound that does not play than a scene that does not start.
      return url;
    }
  }

  /**
   * The node's own sound, kept so a script can reach it by name and so the
   * component's settings are the sound's settings. Playing it is a run's doing:
   * music starting while an author arranges the scene — and restarting on every
   * keystroke, since each edit restarts the scene — is not something anyone
   * asked for.
   */
  private attachSound(
    entry: LiveNode,
    component: Extract<GameComponent, { type: 'audio' }>
  ): Phaser.Sound.BaseSound | undefined {
    if (!component.assetId || !this.cache.audio.exists(component.assetId)) {
      return undefined;
    }

    const sound = this.sound.add(component.assetId, {
      volume: component.volume,
      loop: component.loop
    });

    if (component.autoPlay && this.mode === 'play') sound.play();
    return sound;
  }

  /** A one-off: every call is its own playback, so two can overlap. */
  private playSound(assetId: string, volume = 1, loop = false): void {
    if (!assetId || !this.cache.audio.exists(assetId)) return;
    this.sound.play(assetId, { volume, loop });
  }

  /**
   * Phaser does not call a scene's shutdown method — it emits an event — so
   * this is wired in create() rather than left as a method that looks like
   * lifecycle and never runs. Everything it did was being skipped: the audio it
   * meant to stop is why restarts piled sounds on top of each other.
   */
  private teardown(): void {
    this.scale.off('resize', this.relayout, this);
    this.sound.stopAll();
    // A video keeps a media element playing after the scene that made it is
    // gone: the same leak the sounds had, and this one is audible and visible.
    for (const video of this.videos) video.stop();
    this.videos = [];
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
  }
}
