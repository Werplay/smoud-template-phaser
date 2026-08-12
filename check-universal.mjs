// Checks the universal (runtime-network) build. Run: node check-universal.mjs
//
// 1. The detector in src/index.html resolves the right network per host global,
//    in the right precedence order.
// 2. The built HTML still contains every network's CTA branch. If AD_NETWORK is
//    a compile-time literal again, Terser strips all but one and this fails.
//
// The markers below live *inside* AD_NETWORK-gated branches. Do not swap them
// for the detection globals (ExitApi, FbPlayableAd, mraid...) - those sit in
// ungated helpers and survive either way, so they prove nothing.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert';

let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok       ${label}`);
  } catch (e) {
    console.log(`  FAIL     ${label} - ${e.message}`);
    failed++;
  }
};

// --- 1. detector ------------------------------------------------------------
const html = readFileSync('src/index.html', 'utf8');
// Anchored on the attribute: the comment above the script mentions "<script defer>",
// which a looser regex matches first.
const detector = html.match(/<script[^>]*apiversion[^>]*>([\s\S]*?)<\/script>/i)[1];

// Run the detector against a fake window and read back what it resolves to.
const resolve = (globals) => {
  const w = { ...globals };
  new Function('window', detector)(w);
  return [w.__NET__, w.__PROTO__];
};

console.log('detector:');
check('bare page -> preview/none', () => assert.deepEqual(resolve({}), ['preview', 'none']));
check('ExitApi -> google', () => assert.equal(resolve({ ExitApi: {} })[0], 'google'));
check('FbPlayableAd -> facebook', () => assert.equal(resolve({ FbPlayableAd: {} })[0], 'facebook'));
check('ScPlayableAd -> snapchat', () => assert.equal(resolve({ ScPlayableAd: {} })[0], 'snapchat'));
check('TJ_API -> tapjoy', () => assert.equal(resolve({ TJ_API: {} })[0], 'tapjoy'));
check('smxTracking -> smadex', () => assert.equal(resolve({ smxTracking: {} })[0], 'smadex'));
check('openAppStore -> tiktok', () => assert.equal(resolve({ openAppStore: {} })[0], 'tiktok'));
check('gameReady -> mintegral', () => assert.equal(resolve({ gameReady: {} })[0], 'mintegral'));
check('mraid -> unity/mraid', () => assert.deepEqual(resolve({ mraid: {} }), ['unity', 'mraid']));
check('dapi -> moloco/dapi', () => assert.deepEqual(resolve({ dapi: {} }), ['moloco', 'dapi']));

// Precedence: MRAID is present alongside a more specific global on several
// networks, so the specific check must win. This is the part that silently rots.
check('ExitApi beats mraid', () => assert.equal(resolve({ ExitApi: {}, mraid: {} })[0], 'google'));
check('TJ_API beats mraid', () => assert.equal(resolve({ TJ_API: {}, mraid: {} })[0], 'tapjoy'));
check('protocol still mraid when network is specific', () =>
  assert.equal(resolve({ ExitApi: {}, mraid: {} })[1], 'mraid'));

// Editor override: pinning a network must survive the detector.
check('pinned __NET__ is not overwritten', () => assert.equal(resolve({ __NET__: 'vungle' })[0], 'vungle'));

// Late-loading mraid.js: getters re-probe, a snapshotted value would not.
check('detects mraid attached after load', () => {
  const w = {};
  new Function('window', detector)(w);
  assert.equal(w.__NET__, 'preview');
  w.mraid = {};
  assert.deepEqual([w.__NET__, w.__PROTO__], ['unity', 'mraid']);
});

// --- 2. build ---------------------------------------------------------------
const built = readdirSync('dist')
  .filter((f) => f.includes('Universal') && f.endsWith('.html'))
  .sort()
  .pop();

console.log('build:');
if (!built) {
  console.log('  FAIL     no dist/*Universal*.html - run npm run build:universal');
  failed++;
} else {
  const bundle = readFileSync(`dist/${built}`, 'utf8');
  const markers = {
    google: 'ExitApi.exit',
    facebook: 'onCTAClick',
    tapjoy: 'playableFinished',
    mintegral: 'gameEnd',
    vungle: '"download"',
    smadex: 'redirect()',
    dapi: 'openStoreUrl'
  };
  for (const [network, marker] of Object.entries(markers)) {
    check(`${network} branch kept (${marker})`, () =>
      assert.ok(bundle.includes(marker), 'stripped - build.json "defines" did not take effect'));
  }
  check('AD_NETWORK compiled to a runtime read', () =>
    assert.ok(bundle.includes('window.__NET__'), 'no window.__NET__ in bundle'));
  // The minifier lowercases attributes, so the editor must match case-insensitively.
  check('apiVersion="2" marker present', () =>
    assert.ok(/<script[^>]+apiversion\s*=\s*["']?2/i.test(bundle), 'no apiVersion=2 on the detector script'));
  console.log(`  (${built}, ${bundle.length} bytes)`);
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nOK');
process.exit(failed ? 1 : 0);
