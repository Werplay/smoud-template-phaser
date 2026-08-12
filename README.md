# Playable Template with Phaser

A starter template for creating playable ads using Phaser with TypeScript support. This template combines:

- [Phaser](https://phaser.io/) - Fast, modern 2D game framework
- [@smoud/playable-sdk](https://github.com/smoudjs/playable-sdk#readme) - SDK for creating playable ads with standardized events and methods
- [@smoud/playable-scripts](https://github.com/smoudjs/playable-scripts#readme) - Build and development tools optimized for playable ads

## Demo

Try out this template:
- [View on CodePen](https://codepen.io/peter-hutsul/pen/jEOYKLJ)

## Features

- Phaser 3 integration for high-performance 2D game development
- TypeScript support for better development experience
- Hot module replacement during development
- Game structure with Phaser and SDK integration
- Event handling (resize, pause, resume, volume, etc.)
- Installation button implementation
- Interaction tracking
- Responsive canvas scaling

## Getting Started

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start development server:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   ```

## Project Structure

- `src/index.ts` - Main entry point with SDK, Phaser and Game initialization
- `src/Game.ts` - Game logic and Phaser scene setup
- `src/index.css` - Styles for your playable
- `src/index.html` - HTML template
- `assets/` - Directory for your game assets (sprites, textures, etc.)

## Universal build (one HTML, any network)

```bash
npm run build:universal   # -> dist/..._Universal.html
node check-universal.mjs  # asserts every network branch survived
```

Normally `AD_NETWORK` is a compile-time literal, so Terser strips all 21 other
networks and you need one build per network. `build.json`'s `defines` block
points `AD_NETWORK`/`AD_PROTOCOL` at `window.__NET__`/`window.__PROTO__` instead,
so nothing is stripped and a single HTML serves every network. The detector at
the top of `src/index.html` picks the network by probing for that network's host
global (`ExitApi` → google, `FbPlayableAd` → facebook, `mraid` → MRAID, ...).

Costs ~5 KB over a single-network build.

### For the editor tool

The detector script carries `apiVersion="2"`, which is how the playable editor
recognises a runtime-network build and routes it to `/api/export/v2` (pin the
network) instead of the v1 callback-injection pipeline. The build's HTML
minifier lowercases it to `apiversion="2"`, so match it case-insensitively.

Auto-detection needs no injection. To **pin** a network instead, set the global
before the detector runs — the detector leaves an existing value alone:

```html
<script>window.__NET__ = 'vungle'; window.__PROTO__ = 'none';</script>
```

Pin both: the detector defines the pair together, so it skips `__PROTO__` too
once `__NET__` exists.

Pinning is required for networks with no unique global: **vungle** and
**moloco**. It is optional for the 11 MRAID networks (ironsource, applovin,
unity, appreciate, chartboost, mytarget, liftoff, adcolony, adikteev, bigabid,
inmobi) and for **pangle** — they auto-detect to a sibling with identical CTA
behaviour, so only the reported name differs.

Still the editor's job, since they are not JavaScript:

- `<head>` script tags — `mraid.js`, `exitapi.js`, the Pangle CDN script
- google's `ad.size` / `ad.orientation` meta tags
- zip packaging, and `config.json` for tiktok / snapchat

## Looking for More?

Check out other available templates for different frameworks and use cases:
- [playable-template-base](https://github.com/smoudjs/playable-template-base) - Template base version
- [playable-template-base-js](https://github.com/smoudjs/playable-template-base-js) - Template base version (JavaScript)
- [playable-template-pixi](https://github.com/smoudjs/playable-template-pixi) - Template with PixiJS
- [playable-template-three](https://github.com/smoudjs/playable-template-three) - Template with Three.js
