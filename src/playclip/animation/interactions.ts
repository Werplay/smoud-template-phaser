// Interactions: Trigger → Actions (PlayClip Phase 1). One model for what the
// viewer does and what the ad does in response, shared by the editor,
// Preview and the Phaser export.
//
// Buttons are the first to move onto it: an asset's old `buttonAction` (play /
// seek / CTA) is a tap interaction with one action. Gestures, idle, variables,
// clips and effects add trigger and action kinds as they land; Loop, Jump and
// Freeze keep their own engine for now.

export type Trigger = { kind: 'tap' };

export type Action =
  /** Resume playback, breaking out of a freeze, loop or jump. */
  | { kind: 'play' }
  /** Jump the video to `t` seconds (breaking out of what it leaves). */
  | { kind: 'seek'; t: number }
  /** Open the store. Links are per platform; the build bakes one pair in. */
  | {
      kind: 'cta';
      playStoreLink?: string | null;
      appStoreLink?: string | null;
    };

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
  }
}

/** An asset's interactions (an old `buttonAction` reads as a tap). */
export function interactionsOf(x: Interactive): Interaction[] {
  if (x.interactions) return x.interactions;
  const a = actionFromLegacy(x.buttonAction);
  return a ? [{ id: TAP_ID, trigger: { kind: 'tap' }, actions: [a] }] : [];
}

/** Everything a tap on the asset does, in order. */
export const tapActions = (x: Interactive): Action[] =>
  interactionsOf(x)
    .filter((i) => i.trigger.kind === 'tap')
    .reduce<Action[]>((all, i) => all.concat(i.actions), []);

/** The tap's first action (what the button panel edits). */
export const primaryAction = (x: Interactive): Action | null =>
  tapActions(x)[0] ?? null;

/** The tap's first action as the old shape, for the existing button UI. */
export const buttonActionOf = (x: Interactive) =>
  legacyFromAction(primaryAction(x));

/**
 * `x` with its tap's first action set (or removed, with null). The data moves
 * onto `interactions`; any old `buttonAction` is dropped.
 */
export function withPrimaryAction<T extends Interactive>(
  x: T,
  action: Action | null,
): T {
  const all = interactionsOf(x);
  const i = all.findIndex((n) => n.trigger.kind === 'tap');
  const tap = i >= 0 ? all[i] : null;
  const rest = tap ? tap.actions.slice(1) : [];
  const actions = action ? [action, ...rest] : rest;
  const next = all.slice();
  const updated: Interaction = {
    id: tap?.id ?? TAP_ID,
    trigger: { kind: 'tap' },
    actions,
  };
  if (i >= 0) {
    if (actions.length) next[i] = updated;
    else next.splice(i, 1);
  } else if (actions.length) next.push(updated);
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
  const a = tapActions(x).find((n) => n.kind === 'cta');
  return a && a.kind === 'cta'
    ? {
        playStoreLink: a.playStoreLink ?? null,
        appStoreLink: a.appStoreLink ?? null,
      }
    : null;
}

export const hasTapActions = (x: Interactive) => tapActions(x).length > 0;

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
    }
  }
}
