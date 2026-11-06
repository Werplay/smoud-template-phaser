// Animation presets as data, after EffectCraft's preset files
// (engine/presets/*.json). Each preset is a set of keyframe tracks over
// normalised time 0..1; a value is a number or a reference to a parameter
// resolved from the asset's style (see resolveValue in sample.ts):
//   "$p"  "-$p"  "1.57*$p"  "-1.57*$p"  "1-$p"
// Channels: opacity (multiplier), x / y (design px, screen space),
// scale (multiplier), rotation (degrees), glow (0..1).
//
// Values mirror the editor's CSS keyframes, which are the visual reference.

export type Channel = 'opacity' | 'x' | 'y' | 'scale' | 'rotation' | 'glow';
export type KeyValue = number | string;
export type Track = Array<[t: number, value: KeyValue]>;

export interface AnimPreset {
  tracks: Partial<Record<Channel, Track>>;
}

export interface LoopPreset extends AnimPreset {
  /** Cycle length in ms when the style doesn't set one. */
  periodMs: number;
  /** Gestures take their cycle length from style.gestureSpeed. */
  gesture?: boolean;
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
  // CSS: 2s ease-in-out infinite alternate → one full 0→1→0 cycle is 4s.
  glow: {
    periodMs: 4000,
    tracks: {
      glow: [
        [0, 0],
        [0.5, 1],
        [1, 0],
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
