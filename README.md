# Playable Template (Phaser) — p42

The reference template for playables published to the prefab editor as
`.p42` files. It's a standard smoud project — [Phaser](https://phaser.io/),
[@smoud/playable-sdk](https://github.com/smoudjs/playable-sdk#readme) and
[@smoud/playable-scripts](https://github.com/smoudjs/playable-scripts#readme) —
plus one script, `scripts/p42-extract.js`, that packs the project for upload.

A `.p42` is the whole project in one file. The editor unpacks it and runs a
real `playable-scripts build` for each ad network you export to, so the output
is the same as building the project yourself. It does not patch a pre-built
HTML file.

- [Developing](#developing)
- [Publishing as .p42](#publishing-as-p42)
- [Adding the extractor to another smoud playable](#adding-the-extractor-to-another-smoud-playable)
- [Editable fields](#editable-fields-p42editablejson)
- [Text style properties](#text-style-properties)
- [Custom webpack settings](#custom-webpack-settings)
- [Live preview](#live-preview)
- [Troubleshooting](#troubleshooting)

## Developing

```bash
npm install
npm run dev              # dev server with hot reload
npm run build <network>  # e.g. applovin, mintegral, facebook
```

| Path | What it is |
| --- | --- |
| `src/index.ts` | Entry point: SDK init, game creation, SDK event wiring |
| `src/Game.ts` | Game logic and the Phaser scene |
| `src/index.html`, `src/index.css` | Page template and styles |
| `assets/` | Images, audio, fonts. Import them as `assets/<file>` |
| `build.json` | App name, version and store links |
| `scripts/p42-extract.js` | Packs the project into a `.p42` |

## Publishing as .p42

```bash
npm run extract:p42
```

This writes the `.p42` next to `package.json`, named after the `name` in
`build.json`: lowercased, with spaces and other characters turned into
hyphens. This template's `"Template"` gives `template.p42`, and a name like
`"Rogue Arcade"` gives `rogue-arcade.p42`. Without a `build.json` name it's
`template.p42`. To pick the path yourself:

```bash
npm run extract:p42 -- dist/my-playable.p42
```

Upload the file from the templates page in the editor. Re-run and re-upload
after every change: the editor only sees what's in the file.

**What goes in the file:**

- everything under `src/`, including `index.ts`, `index.html` and `index.css`,
  so a custom bootstrap (loading a font, startup order, canvas CSS) works;
- everything under `assets/`, up to 60MB per file;
- the build config, whichever of these exist: `build.json`, `tsconfig.json`,
  `globals.d.ts`, `babel.config.json`, `webpack.overrides.json`;
- `p42.editable.json`, if present (see below).

OS clutter (`.DS_Store`, `Thumbs.db`) is skipped. Nothing else is included, in
particular not `node_modules` or `package.json`.

**Dependencies must match this template.** The editor builds every `.p42`
against this repo's installed packages, not the uploaded project's:
`phaser` ^3.88.2, `@smoud/playable-sdk` ^1.0.24 and `@smoud/playable-scripts`
^1.1.4. A game that imports any other npm package will fail to build.

## Adding the extractor to another smoud playable

The script has no dependencies.

1. Copy it over:

   ```bash
   mkdir -p scripts
   cp <this repo>/scripts/p42-extract.js scripts/
   ```

2. Add the script to `package.json`, and ignore the output:

   ```json
   "scripts": {
     "extract:p42": "node scripts/p42-extract.js"
   }
   ```

   ```bash
   echo "*.p42" >> .gitignore
   ```

3. Check the project fits: smoud's standard layout (`src/index.ts` entry,
   `assets/`, `build.json` at the root), the same dependency versions as
   above, and webpack overrides in `webpack.overrides.json` rather than only in
   a `build.js` (see [Custom webpack settings](#custom-webpack-settings)).

4. Optionally add a `p42.editable.json`, then `npm run extract:p42` and upload.

Without `p42.editable.json` the template still uploads and exports; the editor
just has nothing to edit.

## Editable fields: `p42.editable.json`

Lists what the editor can change. Each field points at a **plain literal** in
one source file by dotted path. Computed values (expressions, function calls,
values built from other constants) can't be edited.

```ts
// src/data.ts
import endcard from 'assets/endcard.jpg';

export const BEATS = {
  intro: { overlay: 'Survive, Upgrade, Evolve!' },
};
export const IMAGES = { endcard };
```

```json
[
  {
    "key": "introOverlayText",
    "type": "text",
    "label": "Intro headline",
    "file": "data.ts",
    "symbol": "BEATS.intro.overlay",
    "default": "Survive, Upgrade, Evolve!"
  },
  {
    "key": "endcardImage",
    "type": "asset",
    "assetKind": "image",
    "label": "End card image",
    "file": "data.ts",
    "symbol": "IMAGES.endcard",
    "default": "assets/endcard.jpg"
  }
]
```

| Property | Meaning |
| --- | --- |
| `key` | Unique id, used to store the edited value |
| `type` | `text` or `asset` |
| `label` | Name shown in the editor |
| `file` | Source file, relative to `src/` |
| `symbol` | Dotted path to the value, starting at an `export const` |
| `default` | The value as written in source |
| `style` | Text fields only, see [Text style properties](#text-style-properties) |

- The extractor checks every text `default` against the source and stops if
  they differ, so the editor never starts from a stale value.
- An asset field's `default` is its path under `assets/`. A replacement image
  is written over that file, so the `import` doesn't change. Asset defaults
  aren't checked against the source.

## Text style properties

The editor shows the same text panel as the HTML editor: font size, text
colour, origin X/Y, alignment, stroke thickness and stroke colour. A property
is editable only if the template declares it. The rest are greyed out, with
setup steps built from your template's own code.

**1. Put the style next to the text, as literals:**

```ts
export const BEATS = {
  intro: {
    overlay: 'Survive, Upgrade, Evolve!',
    overlayStyle: { fontSize: 30, color: '#ffd34d', stroke: '#16283d', strokeThickness: 4.8 },
  },
};
```

**2. Read it where the text is created:**

```ts
const s = BEATS.intro.overlayStyle;
this.add
  .text(x, y, BEATS.intro.overlay, {
    fontSize: `${s.fontSize}px`,
    color: s.color,
    stroke: s.stroke,
    strokeThickness: s.strokeThickness,
  })
  .setOrigin(0.5);
```

**3. Bind what you read under the field's `style`:**

```json
{
  "key": "introOverlayText",
  "type": "text",
  "file": "data.ts",
  "symbol": "BEATS.intro.overlay",
  "default": "Survive, Upgrade, Evolve!",
  "style": {
    "FontSize": { "symbol": "BEATS.intro.overlayStyle.fontSize", "default": 30 },
    "TextColor": { "symbol": "BEATS.intro.overlayStyle.color", "default": "#ffd34d" },
    "StrokeColor": { "symbol": "BEATS.intro.overlayStyle.stroke", "default": "#16283d" },
    "StrokeThickness": { "symbol": "BEATS.intro.overlayStyle.strokeThickness", "default": 4.8 }
  }
}
```

| Property | Value in source | Typical use |
| --- | --- | --- |
| `FontSize` | number (px) | `` fontSize: `${s.fontSize}px` `` |
| `TextColor` | `'#rrggbb'` | `color: s.color` |
| `OriginX`, `OriginY` | number, 0–1 | `.setOrigin(s.originX, s.originY)` |
| `Align` | `'left'`, `'center'` or `'right'` | `align: s.align`; only shows on wrapped text |
| `StrokeThickness` | number (px) | `strokeThickness: s.strokeThickness` |
| `StrokeColor` | `'#rrggbb'` | `stroke: s.stroke` |

Style literals must be in the same file as the text. Declare only what your
code applies: a declared property the code ignores looks editable but changes
nothing. If your layout rescales text (by screen size, or shrinking to fit),
the edited value is the size you scale from, not the final pixel size.

## Custom webpack settings

The editor never runs your `build.js`. Put webpack overrides in
`webpack.overrides.json` — plain JSON, merged into playable-scripts' config —
and have `build.js` read the same file, so both builds match:

```json
{
  "target": ["web", "es5"],
  "module": { "parser": { "javascript": { "exportsPresence": "error" } } }
}
```

```js
// build.js
const { runBuild } = require('@smoud/playable-scripts');
const overrides = require('./webpack.overrides.json');
runBuild(undefined, undefined, undefined, overrides).catch(() => process.exit(1));
```

`babel.config.json` is picked up the same way; a `babel.config.js` is not.

## Live preview

The editor builds a preview once when it opens. In that build every editable
literal reads its value from the page first, so edits show up by reloading
the preview instead of rebuilding it. That works when the value sits directly
in an object as `key: 'text'`, `key: 30`, `key: identifier` or a shorthand
`key,` — which is also what `p42.editable.json` needs. Anything else still
exports correctly, but changing it rebuilds the preview (a few seconds).

## Troubleshooting

**`p42.editable.json is stale: "<key>" (<file>:<symbol>) is "…" in source but "…" in p42.editable.json`**
You changed the value in code. Update that field's `default` to match, then
re-extract.

**`could not verify editable field … source shape not recognized`**
The `symbol` doesn't lead to a plain literal: a typo in the path, a computed
value, or an object that isn't `export const`. The field may not apply.

**The export fails with a module-not-found error**
The game imports a package this template doesn't have. See
[Publishing as .p42](#publishing-as-p42).

**A custom font or startup code doesn't run in the editor**
The `.p42` predates bootstrap files being included. Re-extract and re-upload.
