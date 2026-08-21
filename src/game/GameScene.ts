import * as Phaser from 'phaser';
import { sdk } from '@smoud/playable-sdk';
import { GAME_DATA } from '../game-data';
import { orientationOf, resolveTransform, rootPlacement, type Size } from './layout';
import type { Behavior, Condition, Easing, GameAction, GameDoc, GameNode, Orientation, Outcome, Transform } from './types';

// ponytail: this pass interprets rendering, layout, tap and the non-physics
// actions — enough to author, preview and export a static, tappable playable.
// Physics bodies, spawners, timers, drag and drop zones are parsed and ignored
// until the physics pass; they are listed in SKIPPED_COMPONENTS so an author is
// warned rather than left wondering why nothing happened.
const SKIPPED_COMPONENTS = ['body', 'spawner', 'timer', 'draggable', 'dropZone'];

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
  private doc: GameDoc = GAME_DATA;
  private live = new Map<string, LiveNode>();
  private counters = new Map<string, number>();
  private audio = new Map<string, HTMLAudioElement>();
  private orientation: Orientation = 'portrait';
  private state = '';
  private finished = false;

  constructor() {
    super({ key: 'GameScene' });
  }

  // --- lifecycle ------------------------------------------------------------

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

    this.fire({ on: 'start' });
    sdk.start();
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

    for (const component of node.components) {
      if (component.type === 'counter') {
        this.counters.set(component.key, component.initial);
      } else if (component.type === 'tappable' && component.enabled) {
        this.makeTappable(node, object, component.paddingX, component.paddingY);
      } else if (component.type === 'audio' && component.autoPlay) {
        this.playSound(component.assetId, component.volume, component.loop);
      } else if (SKIPPED_COMPONENTS.indexOf(component.type) !== -1) {
        console.warn(`[GameScene] "${component.type}" on ${node.id} is not interpreted yet`);
      }
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

    object.on('pointerdown', () => this.fire({ on: 'tap' }, node.id));
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
