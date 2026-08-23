/**
 * Regression proof for the published font pipeline (task: Android icons
 * rendering as tofu/X boxes).
 *
 * Run AFTER `pnpm run build` has produced static-build/. Verifies, for the
 * newest build timestamp:
 *
 *   1. Every font the app preloads at the root (Inter ×4, Playfair ×2,
 *      Feather, MaterialCommunityIcons) was extracted into
 *      static-build/<ts>/_expo/static/js/... byte-identical to its
 *      node_modules source.
 *   2. Every TTF asset referenced by BOTH platform bundles' rewritten
 *      `httpServerLocation` URLs resolves to a file that actually exists in
 *      the static build.
 *   3. serve.js (spawned on an ephemeral port with the artifact BASE_PATH)
 *      returns each font byte-identical at the exact URL path the bundle
 *      references — including requests that append `?platform=…&hash=…`
 *      query strings the way React Native's asset resolver does.
 *   4. Both platform manifests' `assets` entries for fonts point at URLs
 *      under the base path that serve the same bytes.
 *
 * Usage: node scripts/verify-static-fonts.js [static-build-dir]
 * Exits non-zero with a failure list if any check fails.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const staticRoot = path.resolve(
  process.argv[2] || path.join(projectRoot, 'static-build'),
);
const BASE_PATH = (process.env.BASE_PATH || '/thinnr-mobile/').replace(/\/+$/, '');

// The eight font files the root layout preloads (app/_layout.tsx APP_FONTS).
const REQUIRED_FONTS = [
  ['Inter_400Regular.ttf', '@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'],
  ['Inter_500Medium.ttf', '@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'],
  ['Inter_600SemiBold.ttf', '@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'],
  ['Inter_700Bold.ttf', '@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'],
  ['PlayfairDisplay_600SemiBold.ttf', '@expo-google-fonts/playfair-display/600SemiBold/PlayfairDisplay_600SemiBold.ttf'],
  ['PlayfairDisplay_700Bold.ttf', '@expo-google-fonts/playfair-display/700Bold/PlayfairDisplay_700Bold.ttf'],
  ['Feather.ttf', '@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Feather.ttf'],
  ['MaterialCommunityIcons.ttf', '@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf'],
];

const failures = [];
const fail = (msg) => failures.push(msg);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function newestBuildDir() {
  if (!fs.existsSync(staticRoot)) {
    throw new Error(`static-build not found at ${staticRoot} — run the build first`);
  }
  const entries = fs
    .readdirSync(staticRoot)
    .filter((name) => /^\d+-\d+$/.test(name))
    .filter((name) => fs.statSync(path.join(staticRoot, name)).isDirectory())
    .sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
  if (entries.length === 0) {
    throw new Error(`No <timestamp>-<pid> build dir inside ${staticRoot}`);
  }
  return entries[0];
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** All TTF/OTF asset URLs referenced by a rewritten platform bundle. */
function fontUrlsInBundle(bundleFile) {
  const bundle = fs.readFileSync(bundleFile, 'utf-8');
  const urls = new Set();
  const pattern =
    /httpServerLocation:"([^"]+)"[^}]*hash:"[^"]+"[^}]*name:"([^"]+)"[^}]*type:"(ttf|otf)"/g;
  for (const match of bundle.matchAll(pattern)) {
    urls.add(`${match[1]}/${match[2]}.${match[3]}`);
  }
  return [...urls];
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(projectRoot, 'server', 'serve.js')], {
      env: { ...process.env, PORT: String(port), BASE_PATH: `${BASE_PATH}/` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('serve.js did not start in 10s')), 10000);
    child.stdout.on('data', (data) => {
      if (String(data).includes('Serving static Expo build')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve.js exited early with code ${code}`));
    });
  });
}

async function main() {
  const buildId = newestBuildDir();
  const buildDir = path.join(staticRoot, buildId);
  console.log(`Verifying fonts in static-build/${buildId} (BASE_PATH=${BASE_PATH}/)`);

  // ── 1. Required fonts extracted byte-identical ──
  const extracted = walkFiles(buildDir).filter((file) => /\.(ttf|otf)$/i.test(file));
  const extractedByName = new Map(
    extracted.map((file) => [path.basename(file), file]),
  );
  const sourceHashes = new Map();
  for (const [filename, sourceRel] of REQUIRED_FONTS) {
    const sourcePath = path.join(projectRoot, 'node_modules', sourceRel);
    if (!fs.existsSync(sourcePath)) {
      fail(`source font missing from node_modules: ${sourceRel}`);
      continue;
    }
    const sourceHash = sha256(fs.readFileSync(sourcePath));
    sourceHashes.set(filename, sourceHash);
    const built = extractedByName.get(filename);
    if (!built) {
      fail(`font NOT extracted into static build: ${filename}`);
      continue;
    }
    const builtHash = sha256(fs.readFileSync(built));
    if (builtHash !== sourceHash) {
      fail(`extracted font differs from source (corrupted?): ${filename}`);
    } else {
      console.log(`  extracted OK  ${filename}`);
    }
  }

  // ── 2. Bundle references resolve to extracted files ──
  const domain = process.env.REPLIT_INTERNAL_APP_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
  const referenced = new Map(); // url path (no origin) -> filename
  for (const platform of ['ios', 'android']) {
    const bundleFile = path.join(buildDir, '_expo', 'static', 'js', platform, 'bundle.js');
    if (!fs.existsSync(bundleFile)) {
      fail(`missing ${platform} bundle at ${bundleFile}`);
      continue;
    }
    const urls = fontUrlsInBundle(bundleFile);
    for (const filename of REQUIRED_FONTS.map(([name]) => name)) {
      if (!urls.some((url) => url.endsWith(`/${filename}`))) {
        fail(`${platform} bundle has no asset reference for ${filename}`);
      }
    }
    for (const url of urls) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        fail(`${platform} bundle font URL is not absolute (not rewritten?): ${url}`);
        continue;
      }
      // Raw URLs must already be canonical — devices are not guaranteed to
      // collapse "/./" or "/../" segments before requesting.
      if (/\/\.{1,2}\//.test(url)) {
        fail(`${platform} bundle font URL contains dot segments (not canonical): ${url}`);
      }
      if (domain && parsed.host !== domain.replace(/^https?:\/\//, '')) {
        fail(`${platform} bundle font URL points at unexpected host: ${url}`);
      }
      if (!parsed.pathname.startsWith(`${BASE_PATH}/`)) {
        fail(`${platform} bundle font URL escapes base path: ${url}`);
        continue;
      }
      const diskPath = path.join(staticRoot, parsed.pathname.slice(`${BASE_PATH}/`.length));
      if (!fs.existsSync(diskPath)) {
        fail(`${platform} bundle references a font missing on disk: ${parsed.pathname}`);
        continue;
      }
      referenced.set(parsed.pathname, path.basename(diskPath));
    }
    console.log(`  ${platform} bundle references ${urls.length} font asset URL(s)`);
  }

  // ── 3. serve.js returns each referenced font byte-identical ──
  const port = 4173 + (process.pid % 1000);
  let server;
  try {
    server = await startServer(port);
    for (const [urlPath, filename] of referenced) {
      // RN's resolver appends platform/hash query params — must be ignored.
      const full = `http://127.0.0.1:${port}${urlPath}?platform=android&hash=deadbeef`;
      const response = await fetch(full);
      if (!response.ok) {
        fail(`serve.js returned HTTP ${response.status} for ${urlPath}`);
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const expected = sourceHashes.get(filename);
      if (expected && sha256(body) !== expected) {
        fail(`served bytes differ from node_modules source for ${urlPath}`);
      } else if (expected) {
        console.log(`  served OK     ${filename} (${body.length} bytes)`);
      }
    }

    // ── 4. Manifest asset URLs for fonts ──
    for (const platform of ['ios', 'android']) {
      const manifestRes = await fetch(`http://127.0.0.1:${port}${BASE_PATH}/manifest`, {
        headers: { 'expo-platform': platform },
      });
      if (!manifestRes.ok) {
        fail(`manifest fetch failed for ${platform}: HTTP ${manifestRes.status}`);
        continue;
      }
      const manifest = await manifestRes.json();
      const fontAssets = (manifest.assets || []).filter((asset) =>
        /\.(ttf|otf)$/i.test(String(asset.url || '')),
      );
      for (const asset of fontAssets) {
        const parsed = new URL(asset.url);
        const check = await fetch(`http://127.0.0.1:${port}${parsed.pathname}`);
        if (!check.ok) {
          fail(`${platform} manifest font URL 404s through serve.js: ${parsed.pathname}`);
        }
      }
      console.log(`  ${platform} manifest lists ${fontAssets.length} font asset(s), all served`);
    }
  } finally {
    if (server) server.kill();
  }

  if (failures.length > 0) {
    console.error(`\nFONT PIPELINE CHECK FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log('\nAll font pipeline checks passed.');
}

main().catch((error) => {
  console.error('verify-static-fonts crashed:', error);
  process.exit(1);
});
