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

// Fixed SDK bootstrap — same across every template, not "game content".
const BOOTSTRAP_FILES = new Set(['index.ts', 'index.html', 'index.css']);
const CONFIG_FILES = ['build.json'];
const P42_VERSION = 1;

function listSceneFiles(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const relPath = path.join(base, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(listSceneFiles(path.join(dir, entry.name), relPath));
    } else if (!BOOTSTRAP_FILES.has(relPath)) {
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

function extract() {
  const scenePaths = listSceneFiles(SRC_DIR);
  const scenes = readAll(SRC_DIR, scenePaths);
  const config = readAll(ROOT, CONFIG_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))));

  const manifest = {
    p42Version: P42_VERSION,
    engine: 'phaser',
    generatedAt: new Date().toISOString(),
    // ponytail: editable fields aren't auto-derived yet, ships empty.
    // Add static-analysis extraction here once the exporter needs per-field editing.
    editable: [],
    scenes,
    config
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
  console.log(`Wrote ${outPath} (${sceneCount} scene file(s), ${configCount} config file(s)) — round-trip OK`);
}

if (require.main === module) {
  main();
}

module.exports = { extract, encode, decode };
