#!/usr/bin/env node
// Preprocessor: extracts this project's game logic + config into a single
// `.p42` file — a base64-encoded text blob wrapping a JSON manifest of raw
// source. The exporter (in the main editor repo) decodes it back into a
// real project checkout instead of patching a pre-built HTML file.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const ASSETS_DIR = path.join(ROOT, 'assets');

// All of src/ is captured, bootstrap (index.ts/html/css) included — templates
// customize it (font loading, startup order, canvas CSS), so there is no
// shared bootstrap to substitute at build time. Config files are the ones
// that shape the build itself; any that exist are captured.
const CONFIG_FILES = [
  'build.json',
  'tsconfig.json',
  'globals.d.ts',
  'babel.config.json',
  'webpack.overrides.json'
];
// Optional, template-authored: which exported values are safe to edit from the
// prefab UI, and where they live. See p42.editable.json for the shape.
const EDITABLE_FILE = 'p42.editable.json';
// Matches the per-asset embed cap build-playable.ts already uses for real exports.
const MAX_ASSET_BYTES = 60 * 1024 * 1024;
const P42_VERSION = 1;

// OS clutter that must never ship inside a .p42.
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function walkFiles(dir, base, exclude = new Set()) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    if (IGNORED_FILES.has(entry.name)) continue;
    const relPath = path.join(base, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walkFiles(path.join(dir, entry.name), relPath, exclude));
    } else if (!exclude.has(relPath)) {
      files.push(relPath);
    }
  }
  return files;
}

function readAll(dir, relPaths) {
  const out = {};
  for (const relPath of relPaths) {
    out[relPath.split(path.sep).join('/')] = fs.readFileSync(path.join(dir, relPath), 'utf8');
  }
  return out;
}

function readAllBinary(dir, relPaths) {
  const out = {};
  for (const relPath of relPaths) {
    const key = relPath.split(path.sep).join('/');
    const full = path.join(dir, relPath);
    const size = fs.statSync(full).size;
    if (size > MAX_ASSET_BYTES) {
      throw new Error(
        `p42: asset "${key}" is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_ASSET_BYTES / 1024 / 1024}MB per-asset cap`
      );
    }
    out[key] = fs.readFileSync(full).toString('base64');
  }
  return out;
}

function readEditable() {
  const p = path.join(ROOT, EDITABLE_FILE);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Finds the '}' matching the '{' at openIndex.
function findBalanced(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function narrowToSegment(source, segment, isFirst) {
  const declPattern = isFirst
    ? new RegExp(`export\\s+const\\s+${segment}\\b[^=]*=\\s*\\{`)
    : new RegExp(`\\b${segment}\\s*:\\s*\\{`);
  const m = declPattern.exec(source);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = findBalanced(source, openIdx);
  return closeIdx === -1 ? null : source.slice(openIdx + 1, closeIdx);
}

// Resolves a dotted `symbol` path (e.g. "BEATS.win.badge") to its string-literal
// value inside `source`. Only handles literal string leaves reached through plain
// object nesting — good enough to verify the text fields authors hand-copy into
// p42.editable.json's `default`. Returns undefined if the shape isn't recognized;
// callers should warn rather than fail in that case, since this is a regex
// narrower, not a real parser.
function extractLiteral(source, symbol) {
  const segments = symbol.split('.');
  let scope = source;
  for (let i = 0; i < segments.length - 1; i++) {
    scope = narrowToSegment(scope, segments[i], i === 0);
    if (scope === null) return undefined;
  }
  const leaf = segments[segments.length - 1];
  const leafPattern = new RegExp(
    `\\b${leaf}\\s*:\\s*(?:(['"\`])((?:\\\\.|(?!\\1).)*)\\1|(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?))`
  );
  const match = leafPattern.exec(scope);
  if (!match) return undefined;
  // Number literals (text style sizes etc.) come back normalized, as strings.
  return match[2] !== undefined ? match[2] : String(Number(match[3]));
}

// Every literal p42.editable.json points at: each field's value plus each of
// a text field's style bindings. Keys match what the editor stores in `values`.
function editableUnits(editable) {
  const units = [];
  for (const field of editable) {
    if (field.type === 'spine') {
      // Its files are swapped like images (checked for existence, not value);
      // skin and scale are literals, verified like any other.
      const s = field.spine || {};
      for (const sub of ['json', 'atlas', 'texture']) {
        if (s[sub]) units.push({ key: `${field.key}.${sub}`, field, symbol: s[sub].symbol, default: String(s[sub].default), verify: false, asset: true });
      }
      for (const sub of ['skin', 'scale']) {
        const b = s[sub];
        if (!b) continue;
        const def = typeof b.default === 'number' ? String(Number(b.default)) : String(b.default);
        units.push({ key: `${field.key}.${sub}`, field, symbol: b.symbol, default: def, verify: true });
      }
      continue;
    }
    units.push({ key: field.key, field, symbol: field.symbol, default: field.default, verify: field.type === 'text' });
    for (const [prop, binding] of Object.entries(field.style || {})) {
      const numeric = typeof binding.default === 'number';
      units.push({
        key: `${field.key}.${prop}`,
        field,
        symbol: binding.symbol,
        default: numeric ? String(Number(binding.default)) : String(binding.default),
        verify: true
      });
    }
  }
  return units;
}

// ponytail: only verifies simple string-literal fields (type: 'text'). Asset
// fields (e.g. IMAGES.endcard, a shorthand property resolving through an
// `import ... from '...'` line) need real import resolution to verify, not
// regex — those go unverified until this grows a real TS parser.
function verifyEditableDefaults(editable, scenes, assets) {
  for (const unit of editableUnits(editable)) {
    if (unit.asset && !(unit.default.replace(/^assets\//, '') in assets)) {
      throw new Error(`p42.editable.json: "${unit.key}" points at ${unit.default}, which isn't in assets/`);
    }
    if (!unit.verify) continue;
    const { field } = unit;
    const source = scenes[field.file];
    if (source === undefined) {
      console.warn(`p42: editable field "${unit.key}" references unknown file "${field.file}"`);
      continue;
    }
    const actual = extractLiteral(source, unit.symbol);
    if (actual === undefined) {
      console.warn(`p42: could not verify editable field "${unit.key}" (${field.file}:${unit.symbol}) — source shape not recognized`);
      continue;
    }
    if (actual !== unit.default) {
      throw new Error(
        `p42.editable.json is stale: "${unit.key}" (${field.file}:${unit.symbol}) is ${JSON.stringify(actual)} in source but ${JSON.stringify(unit.default)} in p42.editable.json`
      );
    }
  }
}

function extract() {
  const scenePaths = walkFiles(SRC_DIR, '');
  const scenes = readAll(SRC_DIR, scenePaths);
  const config = readAll(ROOT, CONFIG_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))));
  const assets = fs.existsSync(ASSETS_DIR) ? readAllBinary(ASSETS_DIR, walkFiles(ASSETS_DIR, '')) : {};
  const editable = readEditable();

  verifyEditableDefaults(editable, scenes, assets);

  const manifest = {
    p42Version: P42_VERSION,
    engine: 'phaser',
    generatedAt: new Date().toISOString(),
    editable,
    // Current field values, shown by the prefab UI and updated on edit. Seeded
    // from each field's source default on a fresh extraction.
    values: Object.fromEntries(editableUnits(editable).map((u) => [u.key, u.default])),
    scenes,
    config,
    // Binary files imported by scenes (assets/*), base64-encoded so the .p42
    // stays a self-contained, buildable checkout.
    assets
  };

  return manifest;
}

function encode(manifest) {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
}

function decode(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function templateName() {
  try {
    const buildJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8'));
    return String(buildJson.name || 'template').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  } catch {
    return 'template';
  }
}

function main() {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => !a.startsWith('--'));
  const outPath = outArg || path.join(ROOT, `${templateName()}.p42`);

  const manifest = extract();
  const encoded = encode(manifest);
  fs.writeFileSync(outPath, encoded, 'utf8');

  // Self-check: decode what was just written and confirm it round-trips.
  const roundTripped = decode(fs.readFileSync(outPath, 'utf8'));
  const original = JSON.stringify(manifest);
  const written = JSON.stringify(roundTripped);
  if (original !== written) {
    throw new Error('p42 round-trip verification failed: decoded manifest does not match source');
  }

  const sceneCount = Object.keys(manifest.scenes).length;
  const configCount = Object.keys(manifest.config).length;
  const assetCount = Object.keys(manifest.assets).length;
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(
    `Wrote ${outPath} (${sceneCount} scene file(s), ${configCount} config file(s), ${assetCount} asset(s), ${manifest.editable.length} editable field(s), ${sizeKb}KB) — round-trip OK`
  );
}

if (require.main === module) {
  main();
}

module.exports = { extract, encode, decode };
