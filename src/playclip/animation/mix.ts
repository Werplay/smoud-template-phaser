// Audio mix (PlayClip audio mixer): audio assets sit on tracks, each track
// has a level, pan, mute and solo, and a master level sums them all. The
// video's own sound is the reserved 'video' track. Pure: the editor, the
// HTML player and the Phaser scene all ask this module what plays at time t
// and how loud, then hand that to the audio engine (audio-engine.ts).
//
// Levels are in dB like Premiere's mixer: MIN_DB and below is silence (−∞),
// MAX_DB the top of the fader.

export const VIDEO_TRACK = 'video';
export const MIN_DB = -60;
export const MAX_DB = 6;

export interface AudioTrack {
  id: string;
  name: string;
  /** Fader level, MIN_DB (silent) … MAX_DB. */
  gainDb: number;
  /** −1 (left) … 1 (right). */
  pan?: number;
  mute?: boolean;
  solo?: boolean;
}

export interface AudioMix {
  /** Display order. Always holds the VIDEO_TRACK. */
  tracks: AudioTrack[];
  masterDb: number;
}

/** An audio clip as the mix sees it (an audio asset). */
export interface MixVoice {
  id: string;
  trackId?: string;
  /** Timeline window, seconds. */
  start: number;
  end: number;
  /** Clip gain, linear 0…1 (Premiere's clip volume). Default 0.5. */
  volume?: number;
  /** Playback rate. Default 1. */
  speed?: number;
  loop?: boolean;
  /** Seconds of fade at each end of the window. */
  fadeIn?: number;
  fadeOut?: number;
  /** Seconds into the file where the clip starts (its in-point). */
  sourceOffset?: number;
  /** false = the clip is switched off. */
  isActive?: boolean;
  playDuringFreeze?: boolean;
}

/** A clip sounding at time t. */
export interface ActiveVoice {
  id: string;
  trackId: string;
  /** Clip gain × fade envelope (track and master gains apply on top). */
  gain: number;
  /** Seconds into the source audio (speed applied; not wrapped for loops). */
  offset: number;
  speed: number;
  loop: boolean;
}

export const DEFAULT_CLIP_VOLUME = 0.5;
const FIRST_AUDIO_TRACK = 'audio-1';

export const dbToGain = (db: number): number =>
  db <= MIN_DB ? 0 : Math.pow(10, db / 20);

export const gainToDb = (gain: number): number =>
  gain <= 0 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(gain)));

const clampDb = (db: unknown): number =>
  typeof db === 'number' && Number.isFinite(db) ? Math.max(MIN_DB, Math.min(MAX_DB, db)) : 0;

/** A number that may be 0 (`||` would turn a muted clip into the default). */
export const numOr = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

export const newTrack = (id: string, name: string): AudioTrack => ({ id, name, gainDb: 0 });

/**
 * The mix of a project saved before tracks: the video plus one audio track.
 * Every clip plays, overlapping ones together (before the mixer only the
 * first of overlapping clips sounded).
 */
export const legacyMix = (): AudioMix => ({
  tracks: [newTrack(VIDEO_TRACK, 'Video'), newTrack(FIRST_AUDIO_TRACK, 'Audio 1')],
  masterDb: 0,
});

/**
 * A usable mix from whatever was saved (absent = legacyMix): levels clamped,
 * the video track present and first, ids unique, at least one audio track.
 */
export function normalizeMix(saved: Partial<AudioMix> | null | undefined): AudioMix {
  if (!saved || !Array.isArray(saved.tracks)) return legacyMix();
  const seen = new Set<string>();
  const tracks: AudioTrack[] = [];
  for (const t of saved.tracks) {
    if (!t || typeof t.id !== 'string' || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    const track: AudioTrack = {
      id: t.id,
      name: typeof t.name === 'string' && t.name.trim() ? t.name : t.id,
      gainDb: clampDb(t.gainDb),
    };
    const pan = numOr(t.pan, 0);
    if (pan) track.pan = Math.max(-1, Math.min(1, pan));
    if (t.mute) track.mute = true;
    if (t.solo) track.solo = true;
    tracks.push(track);
  }
  const videoAt = tracks.findIndex((t) => t.id === VIDEO_TRACK);
  const video = videoAt >= 0 ? tracks.splice(videoAt, 1)[0] : newTrack(VIDEO_TRACK, 'Video');
  if (!tracks.length) tracks.push(newTrack(FIRST_AUDIO_TRACK, 'Audio 1'));
  return { tracks: [video, ...tracks], masterDb: clampDb(saved.masterDb) };
}

/** The audio tracks (every track but the video's). */
export const audioTracks = (mix: AudioMix): AudioTrack[] =>
  mix.tracks.filter((t) => t.id !== VIDEO_TRACK);

/** The track a clip plays on: its own if it exists, else the first audio track. */
export function trackIdOf(voice: Pick<MixVoice, 'trackId'>, mix: AudioMix): string {
  const own = voice.trackId;
  if (own && own !== VIDEO_TRACK && mix.tracks.some((t) => t.id === own)) return own;
  return audioTracks(mix)[0]?.id ?? FIRST_AUDIO_TRACK;
}

/** A free track id ('audio-2', 'audio-3', …). */
export function nextTrackId(mix: AudioMix): string {
  let n = 1;
  while (mix.tracks.some((t) => t.id === `audio-${n}`)) n++;
  return `audio-${n}`;
}

/**
 * Each track's linear gain after mute and solo: when any track is soloed,
 * only soloed tracks sound (the video's track included). Master not applied.
 */
export function trackGains(mix: AudioMix): Map<string, number> {
  const anySolo = mix.tracks.some((t) => t.solo);
  const out = new Map<string, number>();
  for (const t of mix.tracks)
    out.set(t.id, t.mute || (anySolo && !t.solo) ? 0 : dbToGain(t.gainDb));
  return out;
}

export const masterGain = (mix: AudioMix): number => dbToGain(mix.masterDb);

/** The fade envelope of a clip at t (0…1). */
export function fadeAt(voice: Pick<MixVoice, 'start' | 'end' | 'fadeIn' | 'fadeOut'>, t: number): number {
  const len = Math.max(0, voice.end - voice.start);
  // Fades longer than the clip share it.
  let fin = Math.max(0, numOr(voice.fadeIn, 0));
  let fout = Math.max(0, numOr(voice.fadeOut, 0));
  if (fin + fout > len && fin + fout > 0) {
    const k = len / (fin + fout);
    fin *= k;
    fout *= k;
  }
  let g = 1;
  if (fin > 0) g = Math.min(g, (t - voice.start) / fin);
  if (fout > 0) g = Math.min(g, (voice.end - t) / fout);
  return Math.max(0, Math.min(1, g));
}

export interface MixState {
  /** A freeze holds the video: only clips that play during freezes sound. */
  frozen?: boolean;
}

/** The clips sounding at t, in the order given (assets order). */
export function voicesAt(
  voices: readonly MixVoice[],
  mix: AudioMix,
  t: number,
  state: MixState = {},
): ActiveVoice[] {
  const out: ActiveVoice[] = [];
  for (const v of voices) {
    if (v.isActive === false || t < v.start || t > v.end) continue;
    const trackId = trackIdOf(v, mix);
    if (state.frozen && v.playDuringFreeze !== true) continue;
    const speed = numOr(v.speed, 1) || 1;
    out.push({
      id: v.id,
      trackId,
      gain: Math.max(0, Math.min(1, numOr(v.volume, DEFAULT_CLIP_VOLUME))) * fadeAt(v, t),
      offset: Math.max(0, numOr(v.sourceOffset, 0) + (t - v.start) * speed),
      speed,
      loop: !!v.loop,
    });
  }
  return out;
}

/** Everything the engine needs at t: the clips, every track's gain, master. */
export interface MixFrame {
  voices: ActiveVoice[];
  /** Track id → linear gain. */
  tracks: Map<string, number>;
  /** Track id → pan. */
  pans: Map<string, number>;
  master: number;
}

export function mixAt(
  voices: readonly MixVoice[],
  mix: AudioMix,
  t: number,
  state: MixState = {},
): MixFrame {
  // Everything plays together: the video's sound is only ever set by its own track.
  const tracks = trackGains(mix);
  const pans = new Map(mix.tracks.map((x) => [x.id, x.pan ?? 0]));
  return { voices: voicesAt(voices, mix, t, state), tracks, pans, master: masterGain(mix) };
}
