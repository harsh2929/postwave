/**
 * Metro config for the Moosewave mobile app inside a pnpm workspace.
 *
 *  1. watchFolders includes the workspace root so changes to @postwave/sdk
 *     hot-reload here without an extra publish step.
 *
 *  2. nodeModulesPaths adds the workspace's hoisted node_modules so Metro
 *     can resolve linked deps that pnpm puts in the root rather than under
 *     this app's local node_modules.
 *
 *  3. Expo SDK 55's default workspace discovery and symlink handling remain
 *     authoritative. Custom watch folders extend, rather than replace, those
 *     defaults so Expo Doctor can detect future Metro contract drift.
 *
 *  4. unstable_enablePackageExports=true — required so that packages
 *     shipping `exports` maps (which all of the modern @expo/* packages do)
 *     are resolved against the right entry point under symlinked structures.
 *
 *  5. Sentry's Expo Metro helper injects debug IDs into bundles and source
 *     maps before asset serialization so production events can symbolicate.
 *
 *  6. NativeWind's metro plugin transpiles className → StyleSheet at bundle
 *     time so Tailwind shows up as zero-runtime native styles.
 */

const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getSentryExpoConfig(projectRoot);

/**
 * Keep Expo's complete workspace defaults, then make the mobile app's direct
 * live-linked dependencies explicit. The block list below excludes noisy
 * sibling build outputs without replacing Expo's workspace contract.
 */
config.watchFolders = Array.from(
  new Set([
    ...(config.watchFolders ?? []),
    path.resolve(workspaceRoot, "packages/sdk-ts"),
    // Shared substrate packages. A package consumed as live-linked TS SOURCE
    // (main/exports → src/index.ts) MUST be watched or Metro cannot read it
    // outside this app dir → "Unable to resolve …", which is a red screen at
    // boot rather than a lazy failure. A package that ships a prebuilt dist/
    // resolves either way, so for those this is live reload plus insurance
    // against the day dist/ goes away.
    path.resolve(workspaceRoot, "packages/design-tokens"),
    path.resolve(workspaceRoot, "packages/route-map"),
    path.resolve(workspaceRoot, "packages/telemetry"),
    path.resolve(workspaceRoot, "packages/nav"),
    path.resolve(workspaceRoot, "packages/notifications"),
    // onboarding-schema ships live-linked TS source (exports → src/index.ts) and
    // is imported by campaigns/subscribers/EmptyState/onboarding/tour — it MUST
    // be watched or Metro can't read it outside this app dir ("Unable to resolve
    // @postwave/onboarding-schema"), which broke the iOS bundle.
    path.resolve(workspaceRoot, "packages/onboarding-schema"),
    // step-up is the client half of the server's step-up gate and is imported
    // by src/lib/stepUp.ts, which the SDK transport wrapper pulls in — i.e. it
    // is on EVERY authenticated request's import path. Unwatched, Metro cannot
    // read it from outside this app dir and the bundle fails to resolve at
    // boot, not on the first challenge.
    path.resolve(workspaceRoot, "packages/step-up"),
    // errors is the denial/error-envelope vocabulary shared with web + desktop
    // and is imported by src/lib/denialEnvelope.ts, which api/request.ts pulls
    // in — i.e. it is on EVERY request's failure path. It ships a prebuilt
    // dist/ like sdk-ts, so this entry is for live reload rather than initial
    // resolution, but an unwatched package that later drops dist/ fails at boot
    // rather than on the first denial.
    path.resolve(workspaceRoot, "packages/errors"),
    // The remaining three the app imports. All ship a prebuilt dist/, so they
    // resolve today without being watched — which is exactly why they were
    // forgotten. They are here for live reload, and so that the day one of them
    // stops shipping dist/ the bundle does not start failing at BOOT with an
    // "Unable to resolve" that points at Metro rather than at the package.
    // `metroWatchFolders.test.ts` now derives this requirement from the source
    // instead of trusting anyone to remember it.
    path.resolve(workspaceRoot, "packages/ai-disclosure"),
    path.resolve(workspaceRoot, "packages/offline-outbox"),
    path.resolve(workspaceRoot, "packages/query-contract"),
    path.resolve(workspaceRoot, "node_modules"),
  ]),
);
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

/**
 * Block dirs that Metro shouldn't crawl. The big offenders:
 *   - apps/web's next.js + its dev-overlay tmp dirs
 *   - typescript-eslint's tmp build dirs
 *   - playwright + sharp's binary caches
 *   - other workspace apps' build outputs
 *
 * Each pattern is a regex tested against the absolute file path. The
 * `next_tmp_*` pattern matches the ENOENT-y tmp dirs that crashed
 * Metro's file watcher when next dev shells them.
 */
config.resolver.blockList = [
  /\/apps\/web\/.*/,
  /\/apps\/desktop\/.*/,
  /\/docs-site\/.*/,
  /\/node_modules\/.*\/next_tmp_[0-9]+(\/.*)?/,
  /\/node_modules\/.*\/eslint-plugin_tmp_[0-9]+(\/.*)?/,
  /\/node_modules\/\.cache\/.*/,
  /\/\.next\/.*/,
  // blockList only filters what the resolver crawls; it does NOT
  // suppress source-map emit. `expo export --platform <ios|android>`
  // still writes `.map` files alongside the bundle, which is what
  // scripts/upload-sourcemaps.sh ships to Sentry.
  /\/dist\/.*\.map$/,
];

/**
 * Hierarchical lookup and SDK 55's symlink defaults must stay enabled. pnpm
 * stores peer-specific package versions inside its virtual store, and Metro's
 * supported defaults resolve them without private compatibility flags.
 */
config.resolver.unstable_enablePackageExports = true;

/**
 * Stub Node.js builtins on native platforms.
 *
 * @postwave/sdk has a runtime fallback `await import('crypto')` for older
 * Node versions. React Native exposes `globalThis.crypto.subtle` natively,
 * so the fallback branch is never executed — but Metro still needs to
 * statically resolve the import. Returning an empty module makes the
 * branch a no-op at runtime while keeping the bundle building.
 *
 * Add module names here as needed when other Node-builtin polyfills appear.
 */
const NATIVE_NODE_BUILTIN_STUBS = new Set([
  "crypto",
  "fs",
  "path",
  "os",
  "stream",
  "buffer",
  "util",
  "child_process",
  "net",
  "tls",
  "http",
  "https",
  "zlib",
]);

const previousResolveRequest = config.resolver.resolveRequest;
/**
 * Sentry SESSION REPLAY is a browser feature, and on iOS/Android it is dead
 * weight that still ships.
 *
 * `@sentry/react-native` depends on `@sentry/browser`, which pulls
 * `@sentry-internal/replay`, `replay-canvas` and `browser-utils` into the
 * native bundle. Measured from the export source map they are ~450 KB of the
 * ~2 MB the Sentry family occupies. Nothing on a native build can use them:
 * replay records a DOM.
 *
 * Stubbed only for NON-WEB platforms, so an Expo web build keeps them.
 *
 * VERIFIED ON A SIMULATOR, not merely bundled — the failure mode of getting
 * this wrong is silent (no crash report during an incident), so "it still
 * builds" would not have been evidence. The app boots and still reaches its
 * Sentry init path, which logs `[postwave-sentry] …` on startup.
 */
const SENTRY_WEB_ONLY_STUBS = new Set([
  "@sentry-internal/replay",
  "@sentry-internal/replay-canvas",
]);

// react-native-qrcode-svg's LogoSVG statically imports `react-native-svg/css`
// for LocalSvg, which drags in the whole css-tree CSS parser -- 111 modules in
// the iOS bundle -- to render a logo in the middle of a QR code.
//
// LogoSVG only renders when a QRCode is given a `logo` prop. This app never
// passes one (both call sites are plain value/size/colour), so the parser is
// dead weight. `qrcode-logo-prop-unused.test.ts` fails if any call site starts
// passing `logo`, because THEN this stub would break it -- the guard is the
// reason it is safe to keep.
const CSS_PARSER_STUBS = new Set(["react-native-svg/css"]);

// expo-symbols ships an Android fallback that draws a Material Symbols glyph in
// a <Text>. The font reaches the bundle by TWO INDEPENDENT EDGES, and covering
// only one of them is why 955,300 bytes shipped for months:
//
//   (a) the package ROOT eagerly requires all seven weights by RELATIVE path
//       (`require('./400Regular/MaterialSymbols_400Regular.ttf')`), so a
//       package-name pattern can never match them; and
//   (b) expo-symbols imports the weight module DIRECTLY --
// build/android/weights/regular/index.js does
// `import { MaterialSymbols_400Regular } from '@expo-google-fonts/material-symbols/400Regular'`
//       -- a package subpath, which the root never mentions.
//
// Stubbing the package and every subpath closes both: the root index never
// executes, so its relative requires never happen. Measured on Android, fonts
// drop from 2,473,300 bytes (7 faces) to 1,518,000 (6 app faces).
//
// This deliberately needs no require.resolve(). The redirect it replaced
// resolved @expo-google-fonts/material-symbols at CONFIG LOAD TIME, and nothing
// declares that package -- it is present only because expo-router pulls in
// expo-symbols. An expo-router upgrade that dropped expo-symbols would have
// thrown while loading this file and broken every bundle, dev and CI alike.
//
// Nothing in this app can reach it. expo-symbols is pulled in only by
// expo-router's native-tabs, and this app renders the classic <Tabs> navigator
// (app/(tabs)/_layout.tsx); `SymbolView` and `NativeTabs` appear nowhere in
// src/ or app/. `materialSymbolsUnused.test.ts` fails the build if that ever
// stops being true, because THEN this stub would silently blank the icons --
// the guard is the reason the stub is safe to keep.
// Sentry's DOM user-feedback widget. See metro-stubs/sentry-feedback-noop.js
// for why this resolves to a real module rather than `{ type: "empty" }`:
// @sentry/browser calls buildFeedbackIntegration() at MODULE SCOPE in two
// bundled files, so an empty module is a startup TypeError that a successful
// export cannot detect.
// posthog-react-native's barrel eagerly require()s surveys, PostHogProvider,
// PostHogErrorBoundary, PostHogMaskView and five hooks. This app uses ONE
// symbol from it -- the PostHog class -- through a five-method interface in
// src/lib/telemetry.ts (capture / identify / reset / optIn / optOut), and the
// `await import()` there cannot defer any of it: native has no code splitting,
// so a dynamic import is a static edge with extra steps.
//
// `dist/posthog-rn.js` exports PostHog and pulls in none of that tree. The
// package's `exports` map does not publish it as a subpath, so this resolves
// the package normally and rewrites the resulting filename rather than
// requesting a deep path Metro would refuse. That also avoids a
// require.resolve() at config-load time, which is how the Material Symbols
// redirect turned a transitive change into a broken bundle.
const POSTHOG_PACKAGE = "posthog-react-native";

const SENTRY_DOM_FEEDBACK = "@sentry-internal/feedback";
const sentryFeedbackStub = path.resolve(
  projectRoot,
  "metro-stubs/sentry-feedback-noop.js",
);

const MATERIAL_SYMBOLS_ANY =
  /^@expo-google-fonts\/material-symbols(\/.*)?$/;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform !== "web" && NATIVE_NODE_BUILTIN_STUBS.has(moduleName)) {
    return { type: "empty" };
  }
  if (platform !== "web" && SENTRY_WEB_ONLY_STUBS.has(moduleName)) {
    return { type: "empty" };
  }
  if (platform !== "web" && CSS_PARSER_STUBS.has(moduleName)) {
    return { type: "empty" };
  }
  if (platform !== "web" && MATERIAL_SYMBOLS_ANY.test(moduleName)) {
    return { type: "empty" };
  }
  if (platform !== "web" && moduleName === SENTRY_DOM_FEEDBACK) {
    return { type: "sourceFile", filePath: sentryFeedbackStub };
  }
  if (platform !== "web" && moduleName === POSTHOG_PACKAGE) {
    const entry = context.resolveRequest(context, moduleName, platform);
    if (entry.type === "sourceFile" && entry.filePath.endsWith("index.js")) {
      return {
        type: "sourceFile",
        filePath: entry.filePath.replace(/index\.js$/u, "posthog-rn.js"),
      };
    }
    return entry;
  }
  if (previousResolveRequest) {
    return previousResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

const nativeWindConfig = withNativeWind(config, { input: "./global.css" });

module.exports = nativeWindConfig;
