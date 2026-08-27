import { SpinePlugin } from '@esotericsoftware/spine-phaser';

/**
 * The Spine runtime, when a project needs one.
 *
 * Behind a module of its own so the export can leave it out. The plugin is
 * 210KB in a budget that starts about 1.2MB down, and most playables have no
 * skeleton in them — the build swaps this file for one that exports nothing,
 * and webpack then never reaches the package at all.
 *
 * The preview always has it: that bundle is built once for every project and
 * never shipped, so there is nothing to save there and a per-project rebuild
 * would cost the thing the preview is for.
 */
export const SPINE_PLUGIN: unknown = SpinePlugin;
