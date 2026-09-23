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

// Fixed SDK bootstrap — same across every template, not "game content".
const BOOTSTRAP_FILES = new Set(['index.ts', 'index.html', 'index.css']);
const CONFIG_FILES = ['build.json'];
// Matches the per-asset embed cap build-playable.ts already uses for real exports.
const MAX_ASSET_BYTES = 60 * 1024 * 1024;
const P42_VERSION = 1;

function walkFiles(dir, base, exclude = new Set()) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
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

function extract() {
  const scenePaths = walkFiles(SRC_DIR, '', BOOTSTRAP_FILES);
  const scenes = readAll(SRC_DIR, scenePaths);
  const config = readAll(ROOT, CONFIG_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))));
  const assets = fs.existsSync(ASSETS_DIR) ? readAllBinary(ASSETS_DIR, walkFiles(ASSETS_DIR, '')) : {};

  const manifest = {
    p42Version: P42_VERSION,
    engine: 'phaser',
    generatedAt: new Date().toISOString(),
    // ponytail: editable fields aren't auto-derived yet, ships empty.
    // Add static-analysis extraction here once the exporter needs per-field editing.
    editable: [],
    values: {},
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
  console.log(`Wrote ${outPath} (${sceneCount} scene file(s), ${configCount} config file(s), ${assetCount} asset(s)) — round-trip OK`);
}

if (require.main === module) {
  main();
}

module.exports = { extract, encode, decode };
