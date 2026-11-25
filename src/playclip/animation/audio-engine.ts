// Audio engine (PlayClip audio mixer): plays what mix.ts says through
// WebAudio. Every clip is decoded once and played as a buffer source:
//   clip gain → track gain (+ pan) → track meter → master → speakers.
// WebAudio is the only way to set levels on iOS, where an <audio>/<video>
// element's `volume` can't be changed from script, and it lets any number of
// clips play at once. The video's own sound joins the 'video' track only when
// asked (routeVideo): an element in the graph is silent until the context
// runs, and a cross-origin one is silent for good.
// Shared by the editor, the HTML player and the Phaser scene.

import { VIDEO_TRACK, type MixFrame } from './mix';

type Ctx = AudioContext;

interface TrackNodes {
  gain: GainNode;
  pan: StereoPannerNode | null;
  meter: AnalyserNode;
}

interface Running {
  src: AudioBufferSourceNode;
  gain: GainNode;
  trackId: string;
  /** Context time it started at, and the source offset it started from. */
  at: number;
  from: number;
  speed: number;
  loop: boolean;
}

/** meter() id of the summed output. */
export const MASTER_METER = '__master__';

/** How far (s) a running clip may drift from the playhead before it restarts. */
const DRIFT = 0.15;
/** Smoothing for level changes (s): fast, but no clicks. */
const RAMP = 0.015;

function createContext(): Ctx | null {
  if (typeof window === 'undefined') return null;
  // iOS puts WebAudio in the "ambient" session, which the silent switch
  // mutes, while <audio>/<video> keep playing. Ask for "playback" so clips
  // behave like the media elements they replace (Safari 16.4+).
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
  } catch {
    /* not supported */
  }
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const C = w.AudioContext ?? w.webkitAudioContext;
  try {
    return C ? new C() : null;
  } catch {
    return null;
  }
}

/** A data URI's bytes (no fetch: some ad webviews block fetch on data:). */
function dataUriBytes(uri: string): ArrayBuffer | null {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  try {
    if (!/;base64$/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(body)).buffer as ArrayBuffer;
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  } catch {
    return null;
  }
}

async function bytesOf(url: string): Promise<ArrayBuffer | null> {
  if (url.startsWith('data:')) return dataUriBytes(url);
  try {
    const res = await fetch(url);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** decodeAudioData, callback form too (older Safari has no promise form). */
function decode(ctx: Ctx, bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  return new Promise((resolve) => {
    try {
      const p = ctx.decodeAudioData(bytes, (b) => resolve(b), () => resolve(null));
      if (p && typeof p.then === 'function') p.then(resolve, () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** Whether a media element can join the graph without going silent (same origin). */
export function canRouteMedia(el: HTMLMediaElement): boolean {
  const src = el.currentSrc || el.src;
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  try {
    return new URL(src, location.href).origin === location.origin || el.crossOrigin != null;
  } catch {
    return false;
  }
}

export class AudioMixEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private masterMeter: AnalyserNode | null = null;
  private tracks = new Map<string, TrackNodes>();
  private buffers = new Map<string, AudioBuffer>();
  private urls = new Map<string, string>();
  private running = new Map<string, Running>();
  private video: { el: HTMLMediaElement; node: MediaElementAudioSourceNode } | null = null;
  private disposed = false;

  /** The context, created on first use (null where WebAudio is missing). */
  context(): Ctx | null {
    if (!this.ctx && !this.disposed) {
      this.ctx = createContext();
      if (this.ctx) {
        this.master = this.ctx.createGain();
        this.masterMeter = this.ctx.createAnalyser();
        this.masterMeter.fftSize = 512;
        this.master.connect(this.masterMeter).connect(this.ctx.destination);
      }
    }
    return this.ctx;
  }

  /** A context exists already (nothing has been created by asking). */
  get hasContext(): boolean {
    return this.ctx != null;
  }

  get available(): boolean {
    return this.context() != null;
  }

  /** Running: sound comes out (iOS and autoplay rules need a tap first). */
  get isRunning(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Resume after a user gesture. Call from inside the tap handler. */
  resume(): Promise<void> {
    const ctx = this.context();
    if (!ctx || ctx.state === 'running') return Promise.resolve();
    return ctx.resume().catch(() => undefined);
  }

  /** Decode a clip's audio (again only when its url changes). */
  async load(id: string, url: string | undefined | null): Promise<boolean> {
    if (!url) {
      this.forget(id);
      return false;
    }
    if (this.urls.get(id) === url) return this.buffers.has(id);
    this.urls.set(id, url);
    const ctx = this.context();
    if (!ctx) return false;
    const bytes = await bytesOf(url);
    const buffer = bytes ? await decode(ctx, bytes) : null;
    // A newer load for this id won the race.
    if (this.urls.get(id) !== url || this.disposed) return false;
    if (buffer) {
      this.buffers.set(id, buffer);
      this.stop(id); // restart from the new audio
    } else {
      this.buffers.delete(id);
      console.warn(`PlayClip audio: couldn't ${bytes ? 'decode' : 'load'} the audio of "${id}"; it won't play.`);
    }
    return !!buffer;
  }

  /** A decoded clip's buffer (waveforms). */
  buffer(id: string): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  /** Drop a deleted clip. */
  forget(id: string): void {
    this.stop(id);
    this.buffers.delete(id);
    this.urls.delete(id);
  }

  /** Drop every clip not in `ids`. */
  keepOnly(ids: ReadonlySet<string>): void {
    Array.from(this.urls.keys()).forEach((id) => {
      if (!ids.has(id)) this.forget(id);
    });
  }

  private track(id: string): TrackNodes | null {
    const ctx = this.context();
    if (!ctx || !this.master) return null;
    let t = this.tracks.get(id);
    if (!t) {
      const gain = ctx.createGain();
      const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      if (pan) gain.connect(pan).connect(meter);
      else gain.connect(meter);
      meter.connect(this.master);
      t = { gain, pan, meter };
      this.tracks.set(id, t);
    }
    return t;
  }

  private ramp(param: AudioParam, value: number): void {
    const ctx = this.ctx!;
    if (Math.abs(param.value - value) < 1e-4) return;
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, RAMP);
  }

  private stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    try {
      r.src.onended = null;
      r.src.stop();
    } catch {
      /* already stopped */
    }
    r.src.disconnect();
    r.gain.disconnect();
  }

  /** Stop every clip (pause, seek away, leave the editor). */
  stopAll(): void {
    Array.from(this.running.keys()).forEach((id) => this.stop(id));
  }

  /**
   * Put the video's sound on the video track. Only once, and only while the
   * context runs (a suspended graph would silence it). False if it can't.
   */
  routeVideo(el: HTMLMediaElement): boolean {
    if (this.video?.el === el) return true;
    const ctx = this.context();
    const track = this.track(VIDEO_TRACK);
    if (!ctx || !track || ctx.state !== 'running' || this.video || !canRouteMedia(el)) return false;
    try {
      const node = ctx.createMediaElementSource(el);
      node.connect(track.gain);
      this.video = { el, node };
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the video's sound goes through the video track. */
  videoRouted(el?: HTMLMediaElement): boolean {
    return !!this.video && (!el || this.video.el === el);
  }

  /**
   * Make the speakers match `frame`: levels follow it, clips start, stop or
   * resync. `playing` false stops every clip but keeps the levels. `hold`:
   * the playhead stands still while sound goes on (a freeze, a button
   * waiting for its tap), so running clips aren't pulled back to it.
   */
  sync(frame: MixFrame, { playing, hold = false }: { playing: boolean; hold?: boolean }): void {
    const ctx = this.context();
    if (!ctx || !this.master) return;
    this.ramp(this.master.gain, frame.master);
    frame.tracks.forEach((g, id) => {
      const t = this.track(id);
      if (!t) return;
      this.ramp(t.gain.gain, g);
      if (t.pan) this.ramp(t.pan.pan, frame.pans.get(id) ?? 0);
    });
    // A suspended context's clock stands still: starting clips there would
    // only pile up restarts. They start once it runs.
    if (!playing || ctx.state !== 'running') {
      this.stopAll();
      return;
    }
    const wanted = new Set<string>();
    for (const v of frame.voices) {
      const buffer = this.buffers.get(v.id);
      const track = this.track(v.trackId);
      if (!buffer || !track) continue;
      const dur = buffer.duration;
      // Played out (or all but a sliver: restarting that would just click).
      if (!v.loop && v.offset >= dur - 0.05) continue;
      wanted.add(v.id);
      const pos = v.loop ? v.offset % dur : v.offset;
      const r = this.running.get(v.id);
      if (r && r.trackId === v.trackId && r.speed === v.speed && r.loop === v.loop) {
        if (hold) {
          this.ramp(r.gain.gain, v.gain);
          continue;
        }
        let at = r.from + (ctx.currentTime - r.at) * r.speed;
        if (r.loop) at %= dur;
        const drift = Math.abs(at - pos);
        if (Math.min(drift, r.loop ? dur - drift : drift) < DRIFT) {
          this.ramp(r.gain.gain, v.gain);
          continue;
        }
      }
      this.stop(v.id);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = v.loop;
      src.playbackRate.value = v.speed;
      const gain = ctx.createGain();
      gain.gain.value = v.gain;
      src.connect(gain).connect(track.gain);
      src.onended = () => {
        if (this.running.get(v.id)?.src === src) this.running.delete(v.id);
      };
      src.start(0, pos);
      this.running.set(v.id, { src, gain, trackId: v.trackId, at: ctx.currentTime, from: pos, speed: v.speed, loop: v.loop });
    }
    Array.from(this.running.keys()).forEach((id) => {
      if (!wanted.has(id)) this.stop(id);
    });
  }

  /** A track's (or MASTER_METER's) peak level now (0…1+), or null with no audio graph. */
  meter(trackId: string): number | null {
    const node = trackId === MASTER_METER ? this.masterMeter : this.tracks.get(trackId)?.meter;
    if (!node || this.ctx?.state !== 'running') return null;
    const samples = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(samples);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak;
  }

  dispose(): void {
    this.stopAll();
    this.disposed = true;
    this.video?.node.disconnect();
    this.video = null;
    this.buffers.clear();
    this.urls.clear();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

/** Peaks for a waveform: `bins` values 0…1 (max |sample| per bin, all channels). */
export function waveformPeaks(buffer: AudioBuffer, bins: number): number[] {
  const n = Math.max(1, Math.floor(bins));
  const len = buffer.length;
  const out = new Array<number>(n).fill(0);
  const per = len / n;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < n; b++) {
      const from = Math.floor(b * per);
      const to = Math.min(len, Math.floor((b + 1) * per));
      // Every sample is exact but slow on long clips; stride keeps it ~2k reads a bin.
      const step = Math.max(1, Math.floor((to - from) / 2048));
      let peak = out[b];
      for (let i = from; i < to; i += step) {
        const s = Math.abs(data[i]);
        if (s > peak) peak = s;
      }
      out[b] = peak;
    }
  }
  return out;
}
