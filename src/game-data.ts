import type { GameDoc } from './game/types';

// Replaced at export time with the project's document, then restored — the same
// arrangement playclip-data.ts uses. What is here is the placeholder the
// template runs with on its own (`npm run dev`).
export const GAME_DATA = {
  schemaVersion: 3,
  name: 'Untitled',
  defaultLocale: 'en',
  locales: ['en'],
  settings: {
    designWidth: 720,
    designHeight: 1280,
    orientations: ['portrait'],
    backgroundColor: '#101018',
    gravityY: 0,
    physicsDebug: false,
    storeUrls: {}
  },
  assets: [],
  scenes: [
    {
      id: 'main',
      script: '',
      role: 'game',
      nodes: [
        {
          id: 'title',
          name: 'Title',
          kind: 'text',
          tags: [],
          transform: {
            x: 0,
            y: -120,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            originX: 0.5,
            originY: 0.5,
            alpha: 1,
            depth: 1,
            visible: true,
            anchor: 'center',
            fit: 'fit'
          },
          props: {
            text: { en: 'Empty project' },
            fontFamily: 'sans-serif',
            fontSize: 48,
            color: '#f2f4ff',
            align: 'center'
          },
          components: [],
          behaviors: [],
          children: [],
          locked: false,
          script: ''
        },
        {
          id: 'cta',
          name: 'Install button',
          kind: 'shape',
          tags: ['cta'],
          transform: {
            x: 0,
            y: 40,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            originX: 0.5,
            originY: 0.5,
            alpha: 1,
            depth: 1,
            visible: true,
            anchor: 'center',
            fit: 'fit'
          },
          props: { shape: 'rect', width: 320, height: 96, fill: '#b8ff3c', fillAlpha: 1 },
          components: [{ type: 'tappable', paddingX: 0, paddingY: 0, enabled: true }],
          behaviors: [
            {
              id: 'cta-tap',
              event: { on: 'tap' },
              conditions: [],
              actions: [{ do: 'openCta' }],
              parallel: false
            }
          ],
          children: [],
          locked: false,
          script: ''
        }
      ]
    }
  ],
  states: []
} as unknown as GameDoc;
