import * as Phaser from 'phaser';
import { sdk } from '@smoud/playable-sdk';
import { getDoc } from './doc-source';
import { orientationOf, resolveTransform, rootOffsetFromScreen, rootPlacement, type Size } from './layout';
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
  Transform
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
/** A node can be shrunk but not inverted or vanished by a corner drag. */
const MIN_SCALE = 0.05;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const EASING: Record<Easing, string> = {
  linear: 'Linear',
  quadIn: 'Quad.easeIn',
  quadOut: 'Quad.easeOut',
  quadInOut: 'Quad.easeInOut',
  backOut: 'Back.easeOut',
  bounceOut: 'Bounce.easeOut',
  elasticOut: 'Elastic.easeOut'
};

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
  private audio = new Map<string, HTMLAudioElement>();
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
    this.audio = new Map();
    this.state = '';
    this.finished = false;
    this.outcomeLatched = { win: false, lose: false };
    this.bodiesByTag = new Map();
    this.timers = [];
    this.dropZones = [];
    this.prototypes = new Set();
    this.aliveBySpawner = new Map();
  }

  preload(): void {
    // Images arrive as data URIs (embedded at export) or URLs (editor preview);
    // either way the loader has the texture ready before create() places it.
    for (const asset of this.doc.assets) {
      if (asset.kind === 'image') this.load.image(asset.id, asset.url);
    }
  }

  create(): void {
    this.orientation = orientationOf(this.viewport());
    this.cameras.main.setBackgroundColor(this.doc.settings.backgroundColor);

    for (const asset of this.doc.assets) {
      if (asset.kind !== 'audio') continue;
      const element = new Audio(asset.url);
      element.preload = 'auto';
      this.audio.set(asset.id, element);
    }

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
      if (entry.node.locked || entry.sceneId !== this.visibleScene) continue;

      const object = entry.object as Phaser.GameObjects.GameObject & {
        setInteractive: (config?: object) => unknown;
        input?: unknown;
      };

      // Containers have no size of their own until something is inside them,
      // so Phaser cannot derive a hit area; skip rather than throw.
      try {
        object.setInteractive({ draggable: true, useHandCursor: true });
      } catch {
        continue;
      }
      this.input.setDraggable(object as Phaser.GameObjects.GameObject, true);

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
      displayWidth?: number;
      displayHeight?: number;
      angle?: number;
      getBounds?: () => Phaser.Geom.Rectangle;
    };

    const width = object.displayWidth ?? 0;
    const height = object.displayHeight ?? 0;

    if (width > 0 && height > 0) {
      return {
        center: { x: object.x ?? 0, y: object.y ?? 0 },
        halfW: width / 2,
        halfH: height / 2,
        angle: Phaser.Math.DegToRad(object.angle ?? 0)
      };
    }

    // Containers have no display size of their own; their bounds come from
    // what is inside them, and those are never rotated as a unit here.
    const bounds = object.getBounds?.();
    if (!bounds || !bounds.width || !bounds.height) return undefined;

    return {
      center: { x: bounds.centerX, y: bounds.centerY },
      halfW: bounds.width / 2,
      halfH: bounds.height / 2,
      angle: 0
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
      } else if (component.type === 'audio' && component.autoPlay) {
        this.playSound(component.assetId, component.volume, component.loop);
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
          filledBy: undefined
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
      return this.add.image(0, 0, key);
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

  private makeTappable(node: GameNode, object: Phaser.GameObjects.GameObject, padX: number, padY: number): void {
    const shaped = object as Phaser.GameObjects.GameObject & { width?: number; height?: number };
    const width = (shaped.width || 0) + padX * 2;
    const height = (shaped.height || 0) + padY * 2;

    if (width > 0 && height > 0) {
      const hit = new Phaser.Geom.Rectangle(-padX, -padY, width, height);
      object.setInteractive(hit, Phaser.Geom.Rectangle.Contains);
    } else {
      object.setInteractive({ useHandCursor: true });
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
      setInteractive: (config?: object) => unknown;
      x?: number;
      y?: number;
    };

    try {
      object.setInteractive({ draggable: true, useHandCursor: true });
    } catch {
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

  private relayout = (): void => {
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
      setAngle?: (deg: number) => void;
      setAlpha?: (a: number) => void;
      setDepth?: (d: number) => void;
      setVisible?: (v: boolean) => void;
      setOrigin?: (x: number, y: number) => void;
    };

    if (!simulating) setters.setPosition?.(placement.x, placement.y);
    setters.setScale?.(placement.scaleX, placement.scaleY);
    setters.setAngle?.(transform.rotation);
    setters.setAlpha?.(transform.alpha);
    setters.setDepth?.(transform.depth);
    setters.setVisible?.(
      transform.visible &&
        entry.sceneId === this.visibleScene &&
        !(this.mode === 'play' && this.prototypes.has(entry.node.id))
    );
    // Containers have no origin; everything else is centred by default.
    setters.setOrigin?.(transform.originX, transform.originY);
    void target;
  }

  // --- behaviours -----------------------------------------------------------

  /** Run every behaviour whose event matches, optionally limited to one node. */
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

    const objectFor = (nameOrId: string) => this.findLive(nameOrId)?.object;

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
        'goTo',
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
        (nameOrId: string) => {
          const scene =
            this.doc.scenes.find((candidate) => candidate.id === nameOrId) ??
            this.doc.scenes.find((candidate) => candidate.name === nameOrId);
          if (scene) this.showScene(scene.id);
        },
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
    const object = entry.object as Phaser.GameObjects.GameObject & { input?: unknown };
    if (object.input) return;
    this.makeTappable(entry.node, entry.object, 0, 0);
  }

  private dispatchToScripts(event: Behavior['event'], nodeId?: string, subjectId?: string): void {
    if (!this.scriptHandlers.size) return;
    const subject = subjectId ? this.live.get(subjectId)?.object : undefined;

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
      ease: EASING[action.easing] || 'Quad.easeOut',
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

  private playSound(assetId: string, volume = 1, loop = false): void {
    const element = this.audio.get(assetId);
    if (!element) return;

    element.volume = volume;
    element.loop = loop;
    element.currentTime = 0;
    // Autoplay policy rejects sound before the first interaction; that is
    // expected on launch, not an error worth surfacing to the player.
    void element.play().catch(() => undefined);
  }

  shutdown(): void {
    this.scale.off('resize', this.relayout, this);
    for (const element of Array.from(this.audio.values())) element.pause();
  }
}
