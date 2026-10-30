#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const exportRoot = resolve(
  process.argv[2] ?? join(appRoot, ".expo", "verification-export"),
);
const requestedPlatformArgument = process.argv.find((argument) =>
  argument.startsWith("--platform="),
);
const requestedPlatform = requestedPlatformArgument?.slice(
  "--platform=".length,
);
const budgets = JSON.parse(
  readFileSync(join(scriptDir, "export-budgets.json"), "utf8"),
);
const errors = [];
const measurements = {};

function safeArtifactPath(root, artifactPath) {
  const absolute = resolve(root, artifactPath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`artifact path escapes export root: ${artifactPath}`);
  }
  return absolute;
}

function inspectPlatform(platform) {
  const root = requestedPlatform ? exportRoot : join(exportRoot, platform);
  const metadataPath = join(root, "metadata.json");
  if (!existsSync(metadataPath)) {
    errors.push(`${platform}: missing metadata.json`);
    return;
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const platformMetadata = metadata.fileMetadata?.[platform];
  if (!platformMetadata || typeof platformMetadata.bundle !== "string") {
    errors.push(`${platform}: metadata has no platform bundle`);
    return;
  }
  const unexpected = Object.keys(metadata.fileMetadata ?? {}).filter(
    (key) => key !== platform,
  );
  if (unexpected.length > 0) {
    errors.push(
      `${platform}: isolated export unexpectedly contains ${unexpected.join(", ")}`,
    );
  }

  const bundlePath = safeArtifactPath(root, platformMetadata.bundle);
  const sourceMapPath = `${bundlePath}.map`;
  if (!existsSync(bundlePath)) errors.push(`${platform}: bundle is missing`);
  if (!existsSync(sourceMapPath)) {
    errors.push(`${platform}: external source map is missing`);
  }

  const assetRows = Array.isArray(platformMetadata.assets)
    ? platformMetadata.assets
    : [];
  const uniqueAssets = new Set();
  let assetBytes = 0;
  let fontAssetCount = 0;
  for (const asset of assetRows) {
    if (!asset || typeof asset.path !== "string") {
      errors.push(`${platform}: metadata contains an invalid asset row`);
      continue;
    }
    if (uniqueAssets.has(asset.path)) {
      errors.push(`${platform}: duplicate asset path ${asset.path}`);
      continue;
    }
    uniqueAssets.add(asset.path);
    const assetPath = safeArtifactPath(root, asset.path);
    if (!existsSync(assetPath)) {
      errors.push(`${platform}: asset is missing: ${asset.path}`);
      continue;
    }
    assetBytes += statSync(assetPath).size;
    if (asset.ext === "ttf" || asset.ext === "otf") fontAssetCount += 1;
  }

  const bundleBytes = existsSync(bundlePath) ? statSync(bundlePath).size : 0;
  const measured = {
    bundleBytes,
    assetBytes,
    totalBytes: bundleBytes + assetBytes,
    assetCount: uniqueAssets.size,
    fontAssetCount,
    bundle: relative(appRoot, bundlePath).split(sep).join("/"),
  };
  measurements[platform] = measured;
  const limit = budgets.platforms?.[platform];
  if (!limit) {
    errors.push(`${platform}: no checked-in budget exists`);
    return;
  }
  for (const metric of [
    "bundleBytes",
    "assetBytes",
    "totalBytes",
    "assetCount",
    "fontAssetCount",
  ]) {
    if (measured[metric] > limit[metric]) {
      errors.push(
        `${platform}: ${metric} ${measured[metric]} exceeds budget ${limit[metric]}`,
      );
    }
  }
}

const platforms = requestedPlatform
  ? [requestedPlatform]
  : Object.keys(budgets.platforms);
for (const platform of platforms) {
  if (!budgets.platforms[platform]) {
    errors.push(`unsupported budget platform: ${platform}`);
    continue;
  }
  inspectPlatform(platform);
}

// Root imports from these generated packages eagerly require every face. Keep
// the selective source-level import invariant alongside artifact measurements
// so a future Metro/export format change cannot hide font bloat.
const fontsSource = readFileSync(
  join(appRoot, "src", "lib", "fonts.ts"),
  "utf8",
);
if (
  /from\s+["']@expo-google-fonts\/(?:inter|fraunces)["']/u.test(fontsSource)
) {
  errors.push(
    "fonts.ts imports a generated font package root; import per-face subpaths",
  );
}
const metroSource = readFileSync(join(appRoot, "metro.config.js"), "utf8");
const redirectsAllMaterialSymbolsImports =
  metroSource.includes(
    'moduleName === "@expo-google-fonts/material-symbols"',
  ) ||
  (metroSource.includes("const MATERIAL_SYMBOLS_ANY") &&
    /MATERIAL_SYMBOLS_ANY\.test\(moduleName\)/u.test(metroSource));
if (!redirectsAllMaterialSymbolsImports) {
  errors.push(
    "Metro must keep the expo-symbols root helper alias that prevents seven Android font weights",
  );
}

const report = {
  schemaVersion: 1,
  budgets: budgets.platforms,
  measurements,
  passed: errors.length === 0,
  errors,
};
mkdirSync(join(appRoot, ".expo"), { recursive: true });
writeFileSync(
  join(appRoot, ".expo", "mobile-export-budget.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

if (errors.length > 0) {
  console.error("[postwave-mobile] export budget failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

for (const [platform, measured] of Object.entries(measurements)) {
  console.log(
    `[postwave-mobile] ${platform}: bundle=${measured.bundleBytes} assets=${measured.assetBytes} total=${measured.totalBytes} fonts=${measured.fontAssetCount}`,
  );
}
console.log("[postwave-mobile] native export budgets pass.");
