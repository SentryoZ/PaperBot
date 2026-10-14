#!/usr/bin/env node
/**
 * apply-compat.js — enable Minecraft 26.2 support for mineflayer on top of the
 * released npm packages, which only ship protocol data up to 26.1.
 *
 * Runs as `postinstall` (and as `npm run compat`). Idempotent: safe to re-run.
 *
 * Data source, in order of preference:
 *   1. `vendor/minecraft-data-26.2/` — the 26.2 slice bundled in this repo
 *      (`dataPaths.json` + `pc/26.2/**`). Offline, no network required.
 *   2. Fallback: download the PrismarineJS/minecraft-data `pc_26_2` tarball.
 *
 * Then it applies the four verified patches:
 *   - copy the 26.2 data into node_modules/minecraft-data/minecraft-data/data
 *   - regenerate node_modules/minecraft-data/data.js
 *   - add '26.2' to mineflayer's testedVersions
 *   - map 26.2 -> pc/1.18/chunk in prismarine-chunk
 *   - add "26.2" to every prismarine-physics feature range that lists "26.1"
 *
 * Remove this layer once 26.2 ships in the released npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const MC_VERSION = process.env.MC_VERSION || '26.2';
const BRANCH = process.env.MCDATA_BRANCH || 'pc_26_2';
const TARBALL_URL = `https://codeload.github.com/PrismarineJS/minecraft-data/tar.gz/refs/heads/${BRANCH}`;

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');
const vendor = path.join(root, 'vendor', 'minecraft-data-26.2');
const cacheDir = process.env.MCDATA_CACHE_DIR || path.join(root, '.compat-cache');
const tarball = path.join(cacheDir, `minecraft-data-${BRANCH}.tgz`);

function log(msg) {
  console.log(`[compat] ${msg}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function patchFile(file, isPatched, transform) {
  if (!fs.existsSync(file)) {
    log(`skip (missing): ${path.relative(root, file)}`);
    return false;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (isPatched(src)) {
    log(`already patched: ${path.relative(root, file)}`);
    return false;
  }
  fs.writeFileSync(file, transform(src));
  log(`patched: ${path.relative(root, file)}`);
  return true;
}

function resolveDataDir() {
  const candidates = [
    path.join(nm, 'minecraft-data', 'minecraft-data', 'data'),
    path.join(nm, 'minecraft-data', 'data'),
  ];
  return candidates.find((p) => fs.existsSync(path.dirname(p))) || null;
}

function hasVendoredData() {
  return (
    fs.existsSync(path.join(vendor, 'dataPaths.json')) &&
    fs.existsSync(path.join(vendor, 'pc', MC_VERSION, 'version.json'))
  );
}

async function stageDataFromVendor(dataDir) {
  log(`using vendored data at ${path.relative(root, vendor)} (offline)`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(path.join(vendor, 'dataPaths.json'), path.join(dataDir, 'dataPaths.json'));
  // Copy every vendored pc/<version> subtree. The vendored dataPaths.json is
  // upstream's and references a few files outside pc/26.2 (pc/26.1/proto.yml,
  // pc/1.20.3/windows.json) that the released package does not ship, so stage
  // them alongside 26.2 or generate_data.js cannot resolve the index.
  const vendorPc = path.join(vendor, 'pc');
  for (const version of fs.readdirSync(vendorPc)) {
    copyDir(path.join(vendorPc, version), path.join(dataDir, 'pc', version));
  }
  log(`staged vendored pc data into ${path.relative(root, dataDir)}`);
}

async function stageDataFromTarball(dataDir) {
  log(`vendor data not found; downloading ${TARBALL_URL}`);
  if (!fs.existsSync(tarball)) await download(TARBALL_URL, tarball);
  else log(`using cached ${path.relative(root, tarball)}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-compat-'));
  try {
    execFileSync('tar', ['xzf', tarball, '-C', tmp]);
    const extracted = fs
      .readdirSync(tmp)
      .map((n) => path.join(tmp, n))
      .find((p) => fs.statSync(p).isDirectory());
    const srcData = path.join(extracted, 'data');
    if (!fs.existsSync(srcData)) throw new Error('extracted tarball has no data/ dir');
    fs.rmSync(dataDir, { recursive: true, force: true });
    copyDir(srcData, dataDir);
    log(`staged ${MC_VERSION} data from tarball into ${path.relative(root, dataDir)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const mcData = path.join(nm, 'minecraft-data');
  if (!fs.existsSync(mcData)) {
    log('minecraft-data not installed yet; skipping (run again after install)');
    return;
  }
  const dataDir = resolveDataDir();
  if (!dataDir) throw new Error('could not locate minecraft-data data dir under node_modules');

  if (hasVendoredData()) await stageDataFromVendor(dataDir);
  else await stageDataFromTarball(dataDir);

  // Patch 1 (cont.): regenerate the generated data index.
  const gen = path.join(mcData, 'bin', 'generate_data.js');
  if (fs.existsSync(gen)) {
    execFileSync(process.execPath, [gen], { stdio: 'inherit' });
    log('regenerated data.js');
  } else {
    log('skip (missing): bin/generate_data.js');
  }

  // Patch 2: mineflayer tested versions.
  patchFile(
    path.join(nm, 'mineflayer', 'lib', 'version.js'),
    (s) => new RegExp(`['"]${MC_VERSION.replace(/\./g, '\\.')}['"]`).test(s),
    (s) => s.replace(/(['"]26\.1['"])(\s*\])/, `$1, '${MC_VERSION}'$2`)
  );

  // Patch 3: prismarine-chunk protocol map.
  patchFile(
    path.join(nm, 'prismarine-chunk', 'src', 'index.js'),
    (s) => /26\.2\s*:\s*require/.test(s),
    (s) =>
      s.replace(/(\n\s*26\.1:\s*require\('\.\/pc\/1\.18\/chunk'\))/, `$1,\n    ${MC_VERSION}: require('./pc/1.18/chunk')`)
  );

  // Patch 4: prismarine-physics feature ranges.
  patchFile(
    path.join(nm, 'prismarine-physics', 'lib', 'features.json'),
    (s) => s.includes(`"${MC_VERSION}"`),
    (s) => {
      const features = JSON.parse(s);
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          if (Array.isArray(node.versions) && node.versions.includes('26.1') && !node.versions.includes(MC_VERSION)) {
            node.versions.splice(node.versions.indexOf('26.1') + 1, 0, MC_VERSION);
          }
          for (const k of Object.keys(node)) walk(node[k]);
        }
      };
      walk(features);
      return JSON.stringify(features, null, 2) + '\n';
    }
  );

  // Patch 5: mineflayer's resource-pack replies. minecraft-protocol's UUID
  // writer expects a string, but mineflayer hands it a uuid-1345 object, so the
  // reply is serialised wrong and the server never finishes configuration. Also
  // drop the extra uuid-less DECLINED write, which 26.2 rejects outright.
  patchFile(
    path.join(nm, 'mineflayer', 'lib', 'plugins', 'resource_pack.js'),
    (s) => s.includes('latestUUID ? latestUUID.toString()'),
    (s) =>
      s
        .split('uuid: latestUUID,')
        .join('uuid: latestUUID ? latestUUID.toString() : undefined,')
        .replace(
          /\n\s*bot\._client\.write\('resource_pack_receive', \{\n\s*result: TEXTURE_PACK_RESULTS\.DECLINED\n\s*\}\)/,
          ''
        )
  );

  // Sanity check.
  const mcdata = require(path.join(mcData, 'index.js'));
  const resolved = mcdata(MC_VERSION);
  if (!resolved || !resolved.version) throw new Error(`compat failed: minecraft-data cannot resolve ${MC_VERSION}`);
  log(`OK — minecraft-data ${MC_VERSION} protocol ${resolved.version.version}`);
}

main().catch((err) => {
  console.error(`[compat] FAILED: ${err.message}`);
  process.exit(1);
});
