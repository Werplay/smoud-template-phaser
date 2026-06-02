// Playclip scene data.
//
// This file holds a placeholder by default. The export pipeline OVERWRITES it
// at build time with the real playclip payload — video sources + assets, with
// media inlined as base64 data URIs so the build is self-contained — and then
// restores this placeholder afterwards. Editing it here only affects local dev.

import type { PlayclipData } from './playclip/types';

export const PLAYCLIP_DATA: PlayclipData = {
  version: 1,
  templateId: null,
  name: null,
  orientation: null,
  videoDuration: null,
  video: {
    videoSrc: null,
    portraitSrc: null,
    landscapeSrc: null,
  },
  assets: [],
};
