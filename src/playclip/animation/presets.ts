// Animation presets as data, after EffectCraft's preset files
// (engine/presets/*.json). Each preset is a set of keyframe tracks over
// normalised time 0..1; a value is a number or a reference to a parameter
// resolved from the asset's style (see resolveValue in sample.ts):
//   "$p"  "-$p"  "1.57*$p"  "-1.57*$p"  "1-$p"
// Channels: opacity (multiplier), x / y (design px, screen space),
// scale (multiplier), rotation (degrees), glow (0..1).
//
// A key may carry the easing of the segment that starts at it (third
// element); otherwise the preset's easing applies:
//   'hold'                      keep this value until the next key
//   'linear' | 'ease' | …       a CSS named timing function
//   { bezier: [x1,y1,x2,y2] }   a CSS cubic-bezier
//   { ae: { speedOut, influenceOut, speedIn, influenceIn } }
//                               After Effects temporal ease
//
// Values mirror the editor's original CSS keyframes, the visual reference.

import type { AeEase, CssEasing } from './ease';

export type Channel = 'opacity' | 'x' | 'y' | 'scale' | 'rotation' | 'glow';
export type KeyValue = number | string;
export type KeyEase =
  | 'hold'
  | CssEasing
  | { bezier: [number, number, number, number] }
  | { ae: AeEase };
export type Key =
  | [t: number, value: KeyValue]
  | [t: number, value: KeyValue, ease: KeyEase];
export type Track = Key[];

export interface AnimPreset {
  tracks: Partial<Record<Channel, Track>>;
}

export interface LoopPreset extends AnimPreset {
  /** Cycle length in ms when the style doesn't set one. */
  periodMs: number;
  /** Gestures take their cycle length from style.gestureSpeed. */
  gesture?: boolean;
  /** 'cycle' restarts each period; 'pingpong' plays forward then back (loopOut). */
  mode?: 'cycle' | 'pingpong';
  /** Parameter defaults for this preset (e.g. its own default distance). */
  defaults?: Record<string, number>;
  /** Procedural motion: seeded noise added to channels, frequency 1/period. */
  wiggle?: { channels: Channel[]; amp: KeyValue; octaves?: number };
}

export const ENTRY_PRESETS: Record<string, AnimPreset> = {
  fadeIn: {
    tracks: {
      opacity: [
        [0, '$opFrom'],
        [1, '$opTo'],
      ],
    },
  },
  slideInLeft: {
    tracks: {
      x: [
        [0, '-$slide'],
        [1, 0],
      ],
      opacity: [
        [0, 0.6],
        [1, 1],
      ],
    },
  },
  slideInRight: {
    tracks: {
      x: [
        [0, '$slide'],
        [1, 0],
      ],
      opacity: [
        [0, 0.6],
        [1, 1],
      ],
    },
  },
  slideInTop: {
    tracks: {
      y: [
        [0, '-$slide'],
        [1, 0],
      ],
      opacity: [
        [0, 0.6],
        [1, 1],
      ],
    },
  },
  slideInBottom: {
    tracks: {
      y: [
        [0, '$slide'],
        [1, 0],
      ],
      opacity: [
        [0, 0.6],
        [1, 1],
      ],
    },
  },
  scaleIn: {
    tracks: {
      scale: [
        [0, '$scFrom'],
        [1, '$scTo'],
      ],
      opacity: [
        [0, 0.5],
        [1, 1],
      ],
    },
  },
  bounceIn: {
    tracks: {
      scale: [
        [0, '$scFrom'],
        [0.6, 1.12],
        [0.8, 0.95],
        [1, '$scTo'],
      ],
      opacity: [
        [0, 0],
        [0.6, 1],
        [1, 1],
      ],
    },
  },
};

export const EXIT_PRESETS: Record<string, AnimPreset> = {
  fadeOut: {
    tracks: {
      opacity: [
        [0, '$opFrom'],
        [1, '$opTo'],
      ],
    },
  },
  slideOutLeft: {
    tracks: {
      x: [
        [0, 0],
        [1, '-$slide'],
      ],
      opacity: [
        [0, 1],
        [1, 0.6],
      ],
    },
  },
  slideOutRight: {
    tracks: {
      x: [
        [0, 0],
        [1, '$slide'],
      ],
      opacity: [
        [0, 1],
        [1, 0.6],
      ],
    },
  },
  slideOutTop: {
    tracks: {
      y: [
        [0, 0],
        [1, '-$slide'],
      ],
      opacity: [
        [0, 1],
        [1, 0.6],
      ],
    },
  },
  slideOutBottom: {
    tracks: {
      y: [
        [0, 0],
        [1, '$slide'],
      ],
      opacity: [
        [0, 1],
        [1, 0.6],
      ],
    },
  },
  scaleOut: {
    tracks: {
      scale: [
        [0, '$scFrom'],
        [1, '$scTo'],
      ],
      opacity: [
        [0, 1],
        [1, 0.5],
      ],
    },
  },
};

export const LOOP_PRESETS: Record<string, LoopPreset> = {
  // CSS: 2s ease-in-out infinite alternate.
  glow: {
    periodMs: 2000,
    mode: 'pingpong',
    tracks: {
      glow: [
        [0, 0],
        [1, 1],
      ],
    },
  },
  // Organic jitter (seeded noise, identical in every renderer); speed sets how
  // often it changes direction, distance sets how far it strays.
  wiggle: {
    periodMs: 250,
    gesture: true,
    defaults: { dist: 6 },
    tracks: {},
    wiggle: { channels: ['x', 'y'], amp: '$dist', octaves: 2 },
  },
  // Hold keys: snap between bright and dim instead of fading.
  blink: {
    periodMs: 1000,
    tracks: {
      opacity: [
        [0, 1, 'hold'],
        [0.5, 0.25, 'hold'],
        [1, 1],
      ],
    },
  },
  // Two quick beats, then rest; custom curves for a sharp attack.
  heartbeat: {
    periodMs: 1200,
    tracks: {
      scale: [
        [0, 1, { bezier: [0.2, 0, 0.2, 1] }],
        [0.12, 1.15, 'ease-in'],
        [0.24, 1, { bezier: [0.2, 0, 0.2, 1] }],
        [0.36, 1.1, 'ease-in'],
        [0.48, 1],
        [1, 1],
      ],
    },
  },
  pulse: {
    periodMs: 1500,
    tracks: {
      scale: [
        [0, 1],
        [0.5, 1.05],
        [1, 1],
      ],
    },
  },
  bounce: {
    periodMs: 1000,
    tracks: {
      y: [
        [0, 0],
        [0.5, -10],
        [1, 0],
      ],
    },
  },
  shake: {
    periodMs: 500,
    tracks: {
      x: [
        [0, 0],
        [0.25, -5],
        [0.75, 5],
        [1, 0],
      ],
    },
  },
  float: {
    periodMs: 3000,
    tracks: {
      y: [
        [0, 0],
        [0.5, -10],
        [1, 0],
      ],
    },
  },
  tap: {
    periodMs: 1200,
    gesture: true,
    tracks: {
      scale: [
        [0, 1],
        [0.4, '1-$tapDepth'],
        [0.65, 1.04],
        [1, 1],
      ],
    },
  },
  swipeLeft: {
    periodMs: 1400,
    gesture: true,
    tracks: {
      x: [
        [0, 0],
        [0.6, '-$dist'],
        [1, 0],
      ],
    },
  },
  swipeRight: {
    periodMs: 1400,
    gesture: true,
    tracks: {
      x: [
        [0, 0],
        [0.6, '$dist'],
        [1, 0],
      ],
    },
  },
  swipeUp: {
    periodMs: 1400,
    gesture: true,
    tracks: {
      y: [
        [0, 0],
        [0.6, '-$dist'],
        [1, 0],
      ],
    },
  },
  swipeDown: {
    periodMs: 1400,
    gesture: true,
    tracks: {
      y: [
        [0, 0],
        [0.6, '$dist'],
        [1, 0],
      ],
    },
  },
  circle: {
    periodMs: 2000,
    gesture: true,
    tracks: {
      x: [
        [0, 0],
        [0.25, '$radius'],
        [0.5, 0],
        [0.75, '-$radius'],
        [1, 0],
      ],
      y: [
        [0, 0],
        [0.25, '-$radius'],
        [0.5, '-1.57*$radius'],
        [0.75, '-$radius'],
        [1, 0],
      ],
    },
  },
};
