// Interactions: Trigger → Actions (PlayClip Phase 1). One model for what the
// viewer does and what the ad does in response, shared by the editor,
// Preview and the Phaser export.
//
// Buttons are the first to move onto it: an asset's old `buttonAction` (play /
// seek / CTA) is a tap interaction with one action. Gestures (tap count, hold,
// swipe, drag onto a drop zone) are recognised by gestures.ts. An idle
// trigger turns the asset into a hint (gestures.ts IdleHints). Variables,
// clips and effects add trigger and action kinds as they land;
// Loop, Jump and Freeze keep their own engine for now.

import type { Direction } from './gestures';
import type { VarChange } from './vars';

export type Trigger =
  | { kind: 'tap' }
  /** `count` quick taps in a row (see TAP_COUNT_GAP). */
  | { kind: 'tapCount'; count: number }
  /** Pressed and held still for `ms`. */
  | { kind: 'hold'; ms: number }
  | { kind: 'swipe'; dir: Direction | 'any' }
  /** The asset is dragged and dropped onto the asset `dropZoneId`. */
  | { kind: 'drag'; dropZoneId: string }
  /**
   * No touch anywhere for `ms` while the asset is in its window: the asset
   * (hidden until then) shows and its actions run. It may have no actions.
   */
  | { kind: 'idle'; ms: number }
  /**
   * The counter `name` goes from below `value` to `value` or more (e.g. a
   * progress bar filling up). Fires for assets in their time window.
   */
  | { kind: 'varReaches'; name: string; value: number };

export type TriggerKind = Trigger['kind'];

/** What a renderer recognised on an asset (gestures.ts). */
export type GestureEvent =
  | { kind: 'tap'; count: number }
  | { kind: 'hold'; ms: number }
  | { kind: 'swipe'; dir: Direction }
  | { kind: 'drop'; zoneId: string }
  | { kind: 'idle' }
  /** A counter changed (vars.ts). */
  | ({ kind: 'var' } & VarChange);

export type Action =
  /** Resume playback, breaking out of a freeze, loop or jump. */
  | { kind: 'play' }
  /** Jump the video to `t` seconds (breaking out of what it leaves). */
  | { kind: 'seek'; t: number }
  /** Switch to clip `clipId` (clips.ts), at `t` seconds into it (default 0). */
  | { kind: 'goTo'; clipId: string; t?: number }
  /** Open the store. Links are per platform; the build bakes one pair in. */
  | {
      kind: 'cta';
      playStoreLink?: string | null;
      appStoreLink?: string | null;
    }
  /** Add `value` (may be negative) to the counter `name` (vars.ts). */
  | { kind: 'addVar'; name: string; value: number }
  /** Set the counter `name` to `value`. */
  | { kind: 'setVar'; name: string; value: number };

export type VarAction = Extract<Action, { kind: 'addVar' | 'setVar' }>;

export type ActionKind = Action['kind'];

export interface Interaction {
  id: string;
  trigger: Trigger;
  actions: Action[];
}

/** The pre-interactions button action (still read from old saves). */
export interface LegacyButtonAction {
  type: 'play' | 'seek' | 'cta';
  seekTime?: number;
  playStoreLink?: string | null;
  appStoreLink?: string | null;
}

interface Interactive {
  interactions?: Interaction[];
  buttonAction?: LegacyButtonAction | null;
}

const TAP_ID = 'tap';

export function actionFromLegacy(
  b: LegacyButtonAction | null | undefined,
): Action | null {
  if (!b) return null;
  switch (b.type) {
    case 'play':
      return { kind: 'play' };
    case 'seek':
      return { kind: 'seek', t: b.seekTime ?? 0 };
    case 'cta':
      return {
        kind: 'cta',
        playStoreLink: b.playStoreLink ?? null,
        appStoreLink: b.appStoreLink ?? null,
      };
    default:
      return null;
  }
}

export function legacyFromAction(
  a: Action | null | undefined,
): LegacyButtonAction | undefined {
  if (!a) return undefined;
  switch (a.kind) {
    case 'play':
      return { type: 'play' };
    case 'seek':
      return { type: 'seek', seekTime: a.t };
    case 'cta':
      return {
        type: 'cta',
        playStoreLink: a.playStoreLink ?? null,
        appStoreLink: a.appStoreLink ?? null,
      };
    default:
      // Counter actions have no old shape (the panel edits them directly).
      return undefined;
  }
}

/** An asset's interactions (an old `buttonAction` reads as a tap). */
export function interactionsOf(x: Interactive): Interaction[] {
  if (x.interactions) return x.interactions;
  const a = actionFromLegacy(x.buttonAction);
  return a ? [{ id: TAP_ID, trigger: { kind: 'tap' }, actions: [a] }] : [];
}

export function triggerMatches(t: Trigger, e: GestureEvent): boolean {
  switch (t.kind) {
    case 'tap':
      return e.kind === 'tap';
    case 'tapCount':
      return e.kind === 'tap' && e.count === t.count;
    case 'hold':
      return e.kind === 'hold' && e.ms === t.ms;
    case 'swipe':
      return e.kind === 'swipe' && (t.dir === 'any' || t.dir === e.dir);
    case 'drag':
      return e.kind === 'drop' && e.zoneId === t.dropZoneId;
    case 'idle':
      return e.kind === 'idle';
    case 'varReaches':
      return (
        e.kind === 'var' &&
        e.name === t.name &&
        e.from < t.value &&
        e.to >= t.value
      );
    default:
      return false;
  }
}

/**
 * Everything the gesture makes the asset do, in order. Idle never opens the
 * store: ad networks reject a store redirect the viewer didn't tap for.
 */
export const actionsFor = (x: Interactive, e: GestureEvent): Action[] =>
  interactionsOf(x)
    .filter((i) => triggerMatches(i.trigger, e))
    .reduce<Action[]>((all, i) => all.concat(i.actions), [])
    .filter((a) => e.kind !== 'idle' || a.kind !== 'cta');

/** Every action the asset has, whatever triggers it. */
const allActions = (x: Interactive): Action[] =>
  interactionsOf(x).reduce<Action[]>((all, i) => all.concat(i.actions), []);

/** What a plain tap on the asset does. */
export const tapActions = (x: Interactive): Action[] =>
  actionsFor(x, { kind: 'tap', count: 1 });

/**
 * True when the asset needs the whole press (hold, swipe or drag), so a tap
 * is only known on release. Assets without these keep firing on press.
 */
export const needsPress = (x: Interactive): boolean =>
  interactionsOf(x).some(
    (i) =>
      i.trigger.kind === 'hold' ||
      i.trigger.kind === 'swipe' ||
      i.trigger.kind === 'drag',
  );

/** Hold durations (ms) the asset listens for. */
export const holdTimes = (x: Interactive): number[] =>
  Array.from(
    new Set(
      interactionsOf(x).flatMap((i) =>
        i.trigger.kind === 'hold' ? [i.trigger.ms] : [],
      ),
    ),
  );

/** How long (ms) without a touch before the asset shows, if it is an idle hint. */
export const idleMsOf = (x: Interactive): number | null => {
  for (const i of interactionsOf(x))
    if (i.trigger.kind === 'idle') return i.trigger.ms;
  return null;
};

/** The drop zone a drag trigger targets (the asset is then draggable). */
export const dropZoneOf = (x: Interactive): string | null => {
  for (const i of interactionsOf(x))
    if (i.trigger.kind === 'drag') return i.trigger.dropZoneId;
  return null;
};

/** The first interaction's trigger (what the panel edits; a tap by default). */
export const primaryTrigger = (x: Interactive): Trigger =>
  interactionsOf(x)[0]?.trigger ?? { kind: 'tap' };

/** The first interaction's first action (what the panel edits). */
export const primaryAction = (x: Interactive): Action | null =>
  interactionsOf(x)[0]?.actions[0] ?? null;

/** The first action as the old shape, for the existing button UI. */
export const buttonActionOf = (x: Interactive) =>
  legacyFromAction(primaryAction(x));

/**
 * `x` with its first interaction's first action set (or removed, with null).
 * The data moves onto `interactions`; any old `buttonAction` is dropped.
 */
export function withPrimaryAction<T extends Interactive>(
  x: T,
  action: Action | null,
): T {
  const all = interactionsOf(x);
  const first = all[0];
  const rest = first ? first.actions.slice(1) : [];
  const actions = action ? [action, ...rest] : rest;
  const next = all.slice();
  const updated: Interaction = {
    id: first?.id ?? TAP_ID,
    trigger: first?.trigger ?? { kind: 'tap' },
    actions,
  };
  if (first) {
    // An idle hint needs no action (it just shows), so it stays.
    if (actions.length || first.trigger.kind === 'idle') next[0] = updated;
    else next.splice(0, 1);
  } else if (actions.length) next.push(updated);
  const out = { ...x, interactions: next } as T;
  delete (out as Interactive).buttonAction;
  return out;
}

/**
 * `x` with its first interaction's trigger set. A gesture with no action yet
 * gets one that plays the video (buttons always do something); an idle hint
 * starts with none.
 */
export function withPrimaryTrigger<T extends Interactive>(
  x: T,
  trigger: Trigger,
): T {
  const all = interactionsOf(x);
  const actions = all[0]?.actions.length
    ? all[0].actions
    : trigger.kind === 'idle'
      ? []
      : [{ kind: 'play' } as Action];
  const next = [
    { id: all[0]?.id ?? TAP_ID, trigger, actions },
    ...all.slice(1),
  ];
  const out = { ...x, interactions: next } as T;
  delete (out as Interactive).buttonAction;
  return out;
}

/** Move an old `buttonAction` onto `interactions` (same object if nothing to do). */
export function migrateInteractions<T extends Interactive>(x: T): T {
  if (!('buttonAction' in x)) return x;
  if (x.interactions) {
    const out = { ...x };
    delete (out as Interactive).buttonAction;
    return out;
  }
  return withPrimaryAction(x, actionFromLegacy(x.buttonAction));
}

/** The store links of the asset's CTA action, if it has one. */
export function ctaLinksOf(
  x: Interactive,
): { playStoreLink: string | null; appStoreLink: string | null } | null {
  const a = allActions(x).find((n) => n.kind === 'cta');
  return a && a.kind === 'cta'
    ? {
        playStoreLink: a.playStoreLink ?? null,
        appStoreLink: a.appStoreLink ?? null,
      }
    : null;
}

/** Triggers the viewer fires by touching the asset (idle and counters aren't). */
const isGesture = (t: Trigger) => t.kind !== 'idle' && t.kind !== 'varReaches';

/** True when some gesture on the asset does something. */
export const hasActions = (x: Interactive) =>
  interactionsOf(x).some((i) => isGesture(i.trigger) && i.actions.length);

/**
 * True when the actions move playback (play, seek, another clip, store). Only these break a
 * freeze and use up a button; a counter tap leaves both in place, so it can
 * be tapped again and again.
 */
export const movesPlayback = (actions: readonly Action[]): boolean =>
  actions.some(
    (a) =>
      a.kind === 'play' ||
      a.kind === 'seek' ||
      a.kind === 'goTo' ||
      a.kind === 'cta',
  );

/** `x` with its CTA actions' store links set (a CTA tap is added if it has none). */
export function withCtaLinks<T extends Interactive>(
  x: T,
  links: { playStoreLink: string | null; appStoreLink: string | null },
): T {
  if (!ctaLinksOf(x)) return withPrimaryAction(x, { kind: 'cta', ...links });
  const out = {
    ...x,
    interactions: interactionsOf(x).map((i) => ({
      ...i,
      actions: i.actions.map((a) =>
        a.kind === 'cta' ? { ...a, ...links } : a,
      ),
    })),
  } as T;
  delete (out as Interactive).buttonAction;
  return out;
}

/** What a renderer does for each action (its own playback rules apply). */
export interface ActionHost {
  play(): void;
  seek(t: number): void;
  cta(links: {
    playStoreLink: string | null;
    appStoreLink: string | null;
  }): void;
  /** Change a counter (the renderer then fires what it reaches). */
  setVar(a: VarAction): void;
  /** Switch to another clip and play it from `t`. */
  goTo(clipId: string, t: number): void;
}

/** Run actions in order on a renderer. */
export function runActions(actions: readonly Action[], host: ActionHost): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'play':
        host.play();
        break;
      case 'seek':
        host.seek(a.t);
        break;
      case 'cta':
        host.cta({
          playStoreLink: a.playStoreLink ?? null,
          appStoreLink: a.appStoreLink ?? null,
        });
        break;
      case 'addVar':
      case 'setVar':
        host.setVar(a);
        break;
      case 'goTo':
        host.goTo(a.clipId, a.t ?? 0);
        break;
    }
  }
}
