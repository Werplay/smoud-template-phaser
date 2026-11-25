// Whether this device can play a video source before it is queued in the
// loader. Phaser's VideoFile reads the type of the format it picked and
// throws in preload when none fits, so an export in a codec the device lacks
// (PlayClip's VP9/WebM, HEVC or AV1 in MP4) would stop the playable from
// starting. Skipped instead, the playable runs without that video (overlays,
// end card and CTA still work).

/** The loader's url for `src`, or null when this device can't play it. */
export type VideoUrl = string | { url: string; type: string };

// Sample entries that name the codec in an MP4's moov box (fast start puts
// it at the front), with the canPlayType string for each.
const MP4_CODECS: Array<[RegExp, string]> = [
  [/hvc1|hev1/, 'video/mp4; codecs="hvc1"'],
  [/av01/, 'video/mp4; codecs="av01.0.05M.08"'],
];
const SNIFF_BASE64 = 65536; // the first 48 KB of the file

/** The codec string an MP4 data URI's header names, if not H.264. */
export function mp4CodecQuery(src: string): string | null {
  const comma = src.indexOf(',');
  let head = '';
  try {
    head = atob(src.slice(comma + 1, comma + 1 + SNIFF_BASE64));
  } catch {
    return null;
  }
  return MP4_CODECS.find(([re]) => re.test(head))?.[1] ?? null;
}

export function playableVideoUrl(
  src: string,
  device: { vp9: boolean; canPlayType: (type: string) => string },
): VideoUrl | null {
  if (src.startsWith('data:video/webm')) {
    // Phaser maps 'webm' to VP8 + Vorbis support; PlayClip's WebM is VP9.
    return device.vp9 ? { url: src, type: 'vp9' } : null;
  }
  if (src.startsWith('data:video/mp4')) {
    const query = mp4CodecQuery(src);
    if (query && !device.canPlayType(query).replace(/^no$/, '')) return null;
  }
  return src;
}

/** The device's support, for playableVideoUrl (no video element: nothing plays). */
export function videoSupport(vp9: boolean): { vp9: boolean; canPlayType: (type: string) => string } {
  const el = typeof document !== 'undefined' ? document.createElement('video') : null;
  return { vp9, canPlayType: (type) => (el?.canPlayType ? el.canPlayType(type) : '') };
}
