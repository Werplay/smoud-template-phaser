import * as Phaser from 'phaser';
import { sdk } from '@smoud/playable-sdk';
import { getDoc } from './doc-source';
import { orientationOf, resolveTransform, rootOffsetFromScreen, rootPlacement, type Size } from './layout';
import type { Behavior, Condition, Easing, GameAction, GameDoc, GameNode, Orientation, Outcome, Transform } from './types';

// ponytail: this pass interprets rendering, layout, tap and the non-physics
// actions — enough to author, preview and export a static, tappable playable.
// Physics bodies, spawners, timers, drag and drop zones are parsed and ignored
// until the physics pass; they are listed in SKIPPED_COMPONENTS so an author is
// warned rather than left wondering why nothing happened.
const SKIPPED_COMPONENTS = ['body', 'spawner', 'timer', 'draggable', 'dropZone'];

/**
 * Edit mode makes every node draggable and selectable and holds behaviours
 * back, so tapping a CTA to move it does not also fire it. Play mode is the
 * playable exactly as it ships. An exported build only ever runs 'play'.
 */
export type RuntimeMode = 'edit' | 'play';

const SELECTION_COLOR = 0xb8ff3c;
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

interface LiveNode {
  node: GameNode;
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
  private mode: RuntimeMode = 'play';
  private selectedId: string | null = null;
  private selectionBox?: Phaser.GameObjects.Graphics;
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
  init(data?: { mode?: RuntimeMode }): void {
    this.doc = getDoc();
    if (data?.mode) this.mode = data.mode;
    this.live = new Map();
    this.counters = new Map();
    this.audio = new Map();
    this.state = '';
    this.finished = false;
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

    for (const scene of this.doc.scenes) {
      for (const node of scene.nodes) {
        this.buildNode(node, undefined);
      }
      // The endcard is a scene like any other; it just starts out of sight.
      if (scene.role === 'endcard') {
        for (const node of scene.nodes) this.setVisible(node.id, false);
      }
    }

    this.relayout();
    this.scale.on('resize', this.relayout, this);

    if (this.mode === 'edit') {
      this.selectionBox = this.add.graphics().setDepth(10_000);
      this.createHandles();
      this.enableEditing();
      this.drawSelection();
    } else {
      this.fire({ on: 'start' });
    }

    sdk.start();
  }

  // --- editing --------------------------------------------------------------

  /** Called by the bridge when the editor switches mode or changes selection. */
  setEditorHooks(report: (message: Record<string, unknown>) => void): void {
    this.onEditorAction = report;
  }

  setSelected(nodeId: string | null): void {
    this.selectedId = nodeId;
    this.drawSelection();
  }

  /**
   * Every node becomes draggable. The object moves locally for the duration of
   * the gesture — the editor is only told on release, so a drag is one document
   * change and one undo step rather than one per pointer move.
   */
  private enableEditing(): void {
    for (const entry of Array.from(this.live.values())) {
      if (entry.node.locked) continue;

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
        this.setSelected(entry.node.id);
        this.onEditorAction?.({ type: 'game-editor:selected', nodeId: entry.node.id });
      });
    }

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

        const moved = object as unknown as { x: number; y: number };
        moved.x = dragX;
        moved.y = dragY;
        this.drawSelection();
      }
    );

    this.input.on('dragend', (_pointer: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject) => {
      if (object.getData?.('role')) {
        this.endGesture();
        this.drawSelection();
        return;
      }

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

  private drawSelection(): void {
    const box = this.selectionBox;
    if (!box) return;

    box.clear();
    const entry = this.selectedId ? this.live.get(this.selectedId) : undefined;
    const geometry = entry ? this.selectionGeometry(entry) : undefined;

    if (!geometry) {
      for (const handle of this.handles) handle.setVisible(false);
      return;
    }

    const corners = this.cornerPoints(geometry);
    box.lineStyle(2, SELECTION_COLOR, 0.9);
    box.strokePoints(corners, true);

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
    const entry = this.selectedId ? this.live.get(this.selectedId) : undefined;
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

  private buildNode(node: GameNode, parent: Phaser.GameObjects.Container | undefined): void {
    const transform = resolveTransform(node.transform, node.overrides, this.orientation);
    const object = this.createObject(node);
    if (!object) return;

    const entry: LiveNode = { node, object, transform: { ...transform }, isRoot: !parent };
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
      this.buildNode(child, container);
    }
  }

  private createObject(node: GameNode): Phaser.GameObjects.GameObject | undefined {
    const props = node.props || {};

    if (node.kind === 'container') return this.add.container(0, 0);

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
      const dictionary = props.text || {};
      const copy = dictionary[this.doc.defaultLocale] ?? Object.values(dictionary)[0] ?? '';
      return this.add.text(0, 0, copy, {
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

    this.drawSelection();
  };

  private applyTransform(entry: LiveNode): void {
    const { object, transform } = entry;
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

    setters.setPosition?.(placement.x, placement.y);
    setters.setScale?.(placement.scaleX, placement.scaleY);
    setters.setAngle?.(transform.rotation);
    setters.setAlpha?.(transform.alpha);
    setters.setDepth?.(transform.depth);
    setters.setVisible?.(transform.visible);
    // Containers have no origin; everything else is centred by default.
    setters.setOrigin?.(transform.originX, transform.originY);
    void target;
  }

  // --- behaviours -----------------------------------------------------------

  /** Run every behaviour whose event matches, optionally limited to one node. */
  private fire(event: Behavior['event'], nodeId?: string): void {
    for (const entry of Array.from(this.live.values())) {
      if (nodeId && entry.node.id !== nodeId) continue;

      for (const behavior of entry.node.behaviors) {
        if (!this.eventMatches(behavior.event, event)) continue;
        if (!behavior.conditions.every((condition) => this.conditionHolds(condition))) continue;
        this.runActions(behavior, entry);
      }
    }
  }

  private eventMatches(declared: Behavior['event'], fired: Behavior['event']): boolean {
    if (declared.on !== fired.on) return false;
    if (declared.on === 'counterChange' && fired.on === 'counterChange') return declared.key === fired.key;
    if (declared.on === 'stateEnter' && fired.on === 'stateEnter') return declared.state === fired.state;
    return true;
  }

  private conditionHolds(condition: Condition): boolean {
    if (condition.check === 'state') return this.state === condition.state;

    const value = this.counters.get(condition.key) ?? 0;
    switch (condition.op) {
      case '<':
        return value < condition.value;
      case '<=':
        return value <= condition.value;
      case '==':
        return value === condition.value;
      case '>=':
        return value >= condition.value;
      case '>':
        return value > condition.value;
      default:
        return value !== condition.value;
    }
  }

  /**
   * Sequential by default: each action starts after the ones before it, and a
   * `wait` pushes everything after it out. Parallel behaviours start together.
   */
  private runActions(behavior: Behavior, entry: LiveNode): void {
    let delay = 0;

    for (const action of behavior.actions) {
      if (action.do === 'wait') {
        if (!behavior.parallel) delay += action.seconds * 1000;
        continue;
      }

      if (delay <= 0) {
        this.runAction(action, entry);
      } else {
        this.time.delayedCall(delay, () => this.runAction(action, entry));
      }
    }
  }

  private runAction(action: GameAction, source: LiveNode): void {
    switch (action.do) {
      case 'openCta':
        sdk.install();
        return;

      case 'playSound':
        this.playSound(action.assetId);
        return;

      case 'setState':
        this.enterState(action.state);
        return;

      case 'addToCounter': {
        const next = (this.counters.get(action.key) ?? 0) + action.amount;
        this.counters.set(action.key, next);
        this.fire({ on: 'counterChange', key: action.key });
        this.checkOutcomes();
        return;
      }

      case 'show':
      case 'hide': {
        const target = this.resolve(action.target, source);
        if (target) {
          target.transform.visible = action.do === 'show';
          this.applyTransform(target);
        }
        return;
      }

      case 'destroy': {
        const target = this.resolve(action.target, source);
        if (target) {
          target.object.destroy();
          this.live.delete(target.node.id);
        }
        return;
      }

      case 'setProperty': {
        const target = this.resolve(action.target, source);
        if (target && action.key in target.transform) {
          (target.transform as unknown as Record<string, unknown>)[action.key] = action.value;
          this.applyTransform(target);
        }
        return;
      }

      case 'shake': {
        const target = this.resolve(action.target, source);
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
        const target = this.resolve(action.target, source);
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

  private resolve(nodeId: string | undefined, fallback: LiveNode): LiveNode | undefined {
    if (!nodeId) return fallback;
    return this.live.get(nodeId);
  }

  // --- state ----------------------------------------------------------------

  private enterState(name: string): void {
    if (this.state === name) return;
    this.state = name;

    const state = this.doc.states.find((candidate) => candidate.name === name);
    if (state) {
      for (const id of state.hide) this.setVisible(id, false);
      for (const id of state.show) this.setVisible(id, true);
    }

    // The endcard scene is shown by entering the state it is named for.
    const endcard = this.doc.scenes.find((scene) => scene.role === 'endcard');
    if (endcard && name === 'endcard') {
      for (const node of endcard.nodes) this.setVisible(node.id, true);
    }

    this.fire({ on: 'stateEnter', state: name });

    if (!this.finished && (name === 'endcard' || name === this.doc.win?.state)) {
      this.finished = true;
      sdk.finish();
    }
  }

  private setVisible(nodeId: string, visible: boolean): void {
    const entry = this.live.get(nodeId);
    if (!entry) return;
    entry.transform.visible = visible;
    this.applyTransform(entry);
  }

  private checkOutcomes(): void {
    const reached = (outcome: Outcome | undefined) =>
      !!outcome && outcome.conditions.every((condition) => this.conditionHolds(condition));

    if (reached(this.doc.win)) this.enterState(this.doc.win!.state);
    else if (reached(this.doc.lose)) this.enterState(this.doc.lose!.state);
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
