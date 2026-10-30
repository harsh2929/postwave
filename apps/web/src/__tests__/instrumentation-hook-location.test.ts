// SPDX-License-Identifier: AGPL-3.0-only
//
// Server-side Sentry never initialised in production: instrumentation.ts sat
// in apps/web/, but Next 15 looks for the hook in join(appDir, "..") — and the
// app directory is src/app — so `next build` never compiled it and register()
// never ran. These tests ask Next's own resolution where it looks, rather than
// restating the path, and then run the hook the way Next does.
import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => sentry);

const projectDir = process.cwd();

async function instrumentationRootDir(): Promise<string> {
  // The same two calls next/dist/build/index.js makes to find the hook.
  const { findPagesDir } = await import("next/dist/lib/find-pages-dir.js");
  const { pagesDir, appDir } = findPagesDir(projectDir);
  const dir = pagesDir || appDir;
  if (!dir) throw new Error("Next found neither an app nor a pages directory");
  return path.join(dir, "..");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  sentry.init.mockReset();
});

describe("Next instrumentation hooks", () => {
  it("puts the server hook where next build looks for it", async () => {
    const { getFilesInDir } = await import("next/dist/lib/get-files-in-dir.js");
    const rootDir = await instrumentationRootDir();
    const files = Array.from(await getFilesInDir(rootDir));

    expect(files.filter((file) => /^instrumentation\.(ts|js|tsx|jsx)$/.test(file))).toEqual([
      "instrumentation.ts",
    ]);
    // A copy anywhere else is dead code that reads as if it worked.
    if (rootDir !== projectDir) {
      for (const ext of ["ts", "js", "mjs"]) {
        expect(existsSync(path.join(projectDir, `instrumentation.${ext}`))).toBe(false);
      }
    }
  });

  it("puts the browser hook where the client bundle resolves it", () => {
    // create-compiler-aliases.js: private-next-instrumentation-client tries
    // <dir>/src/instrumentation-client, then <dir>/instrumentation-client.
    const candidates = [
      path.join(projectDir, "src", "instrumentation-client.ts"),
      path.join(projectDir, "instrumentation-client.ts"),
    ].filter(existsSync);

    expect(candidates).toEqual([path.join(projectDir, "src", "instrumentation-client.ts")]);
  });

  it("initialises server Sentry when Next registers the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("SENTRY_DSN_WEB", "https://public@o0.ingest.example/1");
    const { register } = await import("@/instrumentation");

    await register();

    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init.mock.calls[0]?.[0]).toMatchObject({
      dsn: "https://public@o0.ingest.example/1",
      sendDefaultPii: false,
    });
  });

  it("initialises edge Sentry when Next registers the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("SENTRY_DSN_WEB", "https://public@o0.ingest.example/1");
    const { register } = await import("@/instrumentation");

    await register();

    expect(sentry.init).toHaveBeenCalledTimes(1);
  });
});
