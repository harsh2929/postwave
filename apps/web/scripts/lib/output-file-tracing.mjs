// SPDX-License-Identifier: AGPL-3.0-only

/**
 * next.config's outputFileTracingExcludes: what the release image must not
 * carry (scripts/release/verify-web-image.sh forbids it) and the runtime never
 * reads.
 *
 * Two different matchers read these lists, and neither anchors a glob. Next
 * (build/collect-build-traces) compiles every pattern with picomatch
 * `contains: true`, so a pattern matches ANY substring of a path:
 *
 * - A key that matches the string "next-server" feeds the server trace and,
 *   through Next's shared ignores, every route's own dependency walk. Those
 *   paths are relative to the monorepo root (outputFileTracingRoot).
 * - A key that matches a route (e.g. "/docs/api/[endpoint]/page") excludes from
 *   that route's trace. Each pattern is resolved as path.join(apps/web,
 *   pattern) and compared with absolute paths, so the absolute prefix anchors
 *   it. "/**" matches every route and not "next-server".
 *
 * These lists once sat under a single "*" key, which feeds both. Unanchored,
 * "**\/*.map" dropped node_modules/lodash.map/index.js and core-js's
 * es.map.js, "./scripts/**" every node_modules/<pkg>/scripts/, and "./*.ts"
 * anything with ".ts" in its name — files the server loads at runtime. So each
 * pattern below starts with a literal naming a repository directory or a
 * node_modules/ package, and the dependency tree has no directory of that
 * shape (output-file-tracing.test.ts replays Next's matcher over real paths).
 *
 * Source maps are not listed: a map is only a name ending, which no substring
 * glob can pin, and the Dockerfile's sanitize step deletes every *.map before
 * the image layer is written.
 */
export const outputFileTracingExcludes = {
  "next-server": [
    // Build-time tooling the trace drags in although the runtime never loads
    // it: next-intl's message extractor imports @swc/core (the glibc and the
    // musl binary), webpack, esbuild and the React Compiler Babel plugin
    // arrive through build helpers, and the Alpine image never loads the
    // glibc builds of sharp's native libraries (the musl ones stay). Together
    // about 100 MB of the 444 MB image, which the 400 MiB budget in
    // verify-web-image.sh refuses.
    "node_modules/@swc/core*/**",
    "node_modules/.pnpm/@swc+core*/**",
    "node_modules/@esbuild/**",
    "node_modules/.pnpm/@esbuild+*/**",
    "node_modules/.pnpm/esbuild@*/**",
    "node_modules/.pnpm/webpack@*/**",
    "node_modules/.pnpm/babel-plugin-react-compiler@*/**",
    "node_modules/.pnpm/@img+sharp-libvips-linux-*/**",
    "node_modules/.pnpm/@img+sharp-linux-*/**",
    "node_modules/{eslint,prettier,turbo,typescript,vitest}/**",
    "node_modules/.pnpm/{eslint,prettier,turbo,typescript,vitest}@*/**",
    // Build scripts (next.config and the bundled middleware import a few
    // helpers from them), the app's TypeScript sources (compiled into the
    // server bundles), workspace package sources, and the MCP server (the
    // docs use the generated catalog).
    "apps/web/scripts/**",
    "apps/web/src/**",
    "apps/web/*.ts",
    "apps/web/.next/types/**",
    "packages/*/src/**",
    "packages/*/*.ts",
    // Package tests and examples: a package copied into the build for its
    // changelog or manifest carries them, and nothing at runtime loads them.
    "packages/*/tests/**",
    "packages/*/examples/**",
    "packages/mcp-server/**",
  ],
  "/**": [
    "./scripts/**",
    "./src/**",
    "./*.ts",
    "./.next/types/**",
    "../../packages/*/src/**",
    "../../packages/*/tests/**",
    "../../packages/*/examples/**",
    "../../packages/*/*.ts",
    "../../packages/*/dist/**/*.d.ts",
    "../../packages/mcp-server/**",
  ],
};
