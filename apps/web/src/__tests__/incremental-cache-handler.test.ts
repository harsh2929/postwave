// SPDX-License-Identifier: AGPL-3.0-only
//
// The release image is read-only (`chmod -R a-w` over the standalone tree and a
// read-only root filesystem at runtime); only .next/cache is writable. Next's
// default cache handler writes pages rendered at request time into
// .next/server/app, which staging logged once per docs page visited:
//   Failed to update prerender cache for /docs/api/… ENOENT: mkdir …
// These tests drive Next's own IncrementalCache over a read-only copy of that
// layout, first with Next's default handler (the failure) and then with the
// handler next.config.mjs configures.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { IncrementalCache } from "next/dist/server/lib/incremental-cache/index.js";
import { nodeFs } from "next/dist/server/lib/node-fs-methods.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReadOnlyImageCacheHandler from "../../incremental-cache-handler.mjs";

const PAGE_CTX = { isRoutePPREnabled: false, isFallback: false } as const;

let root = "";
let distDir = "";
let serverDistDir = "";

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => statSync(path.join(dir, entry)).isFile())
    .sort();
}

function setWritable(dir: string, writable: boolean): void {
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const target = path.join(dir, entry);
    chmodSync(target, statSync(target).isDirectory() ? (writable ? 0o755 : 0o555) : writable ? 0o644 : 0o444);
  }
  chmodSync(dir, writable ? 0o755 : 0o555);
}

function incrementalCache(
  CurCacheHandler?: typeof ReadOnlyImageCacheHandler,
): IncrementalCache {
  return new IncrementalCache({
    fs: nodeFs,
    dev: false,
    flushToDisk: true,
    minimalMode: false,
    serverDistDir,
    requestHeaders: {},
    // No in-memory tier: every read below has to come from disk, as it does
    // after a restart or an LRU eviction.
    maxMemoryCacheSize: 0,
    fetchCacheKeyPrefix: "",
    allowedRevalidateHeaderKeys: [],
    getPrerenderManifest: () => ({
      version: 4,
      routes: {},
      dynamicRoutes: {},
      notFoundRoutes: [],
      preview: {
        previewModeId: "test",
        previewModeSigningKey: "test",
        previewModeEncryptionKey: "test",
      },
    }),
    CurCacheHandler: CurCacheHandler as never,
  } as ConstructorParameters<typeof IncrementalCache>[0]);
}

function page(html: string) {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from(`0:${JSON.stringify(html)}\n`),
    headers: { "x-nextjs-stale-time": "300" },
    postponed: undefined,
    status: 200,
    segmentData: undefined,
  } as const;
}

async function readPage(cache: IncrementalCache, key: string) {
  const entry = await cache.get(key, { kind: "APP_PAGE", ...PAGE_CTX } as never);
  const value = entry?.value as
    | { kind: string; html: string; rscData: Buffer }
    | null
    | undefined;
  return value
    ? { kind: value.kind, html: value.html, rsc: value.rscData.toString() }
    : null;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pw-isr-"));
  distDir = path.join(root, ".next");
  serverDistDir = path.join(distDir, "server");
  // A page the build prerendered into the image.
  const seed = path.join(serverDistDir, "app", "docs");
  mkdirSync(seed, { recursive: true });
  writeFileSync(path.join(seed, "getting-started.html"), "<p>built</p>");
  writeFileSync(path.join(seed, "getting-started.rsc"), "0:\"built\"\n");
  writeFileSync(
    path.join(seed, "getting-started.meta"),
    JSON.stringify({ status: 200, headers: {} }),
  );
  // The image: read-only. The per-task volume: writable, empty.
  setWritable(serverDistDir, false);
  mkdirSync(path.join(distDir, "cache"), { mode: 0o700 });
});

afterEach(() => {
  vi.restoreAllMocks();
  setWritable(serverDistDir, true);
  rmSync(root, { recursive: true, force: true });
});

describe("incremental cache on a read-only release image", () => {
  it("is the handler next.config.mjs configures", async () => {
    // Without this the module below could be perfect and unused: Next only
    // reaches it through `cacheHandler`, and the default handler's writes go
    // back inside the image.
    const config = readFileSync(
      new URL("../../next.config.mjs", import.meta.url),
      "utf8",
    );
    const configured = /cacheHandler:\s*path\.join\(__dirname,\s*"([^"]+)"\)/u.exec(
      config,
    );
    expect(configured?.[1]).toBeDefined();
    const target = new URL(`../../${configured?.[1]}`, import.meta.url);
    expect(statSync(target).isFile()).toBe(true);
    const configuredModule = (await import(target.href)) as { default: unknown };
    expect(configuredModule.default).toBe(ReadOnlyImageCacheHandler);
  });

  it("reproduces the failure with Next's default handler", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = incrementalCache();

    await cache.set("/docs/api/get-health", page("<p>health</p>") as never, {
      cacheControl: { revalidate: 86_400, expire: undefined },
      ...PAGE_CTX,
    } as never);

    expect(warn).toHaveBeenCalledWith(
      "Failed to update prerender cache for",
      "/docs/api/get-health",
      expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM|EROFS|ENOENT)$/) }),
    );
    expect(await readPage(incrementalCache(), "/docs/api/get-health")).toBeNull();
  });

  it("caches pages rendered at request time on the writable volume, never in the image", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const imageBefore = listFiles(serverDistDir);
    const cache = incrementalCache(ReadOnlyImageCacheHandler);

    await cache.set("/docs/api/get-health", page("<p>health</p>") as never, {
      cacheControl: { revalidate: 86_400, expire: undefined },
      ...PAGE_CTX,
    } as never);
    // A revalidation of a page the build prerendered.
    await cache.set("/docs/getting-started", page("<p>revalidated</p>") as never, {
      cacheControl: { revalidate: 86_400, expire: undefined },
      ...PAGE_CTX,
    } as never);

    expect(warn).not.toHaveBeenCalled();
    expect(listFiles(serverDistDir)).toEqual(imageBefore);
    expect(
      readFileSync(path.join(serverDistDir, "app", "docs", "getting-started.html"), "utf8"),
    ).toBe("<p>built</p>");
    expect(listFiles(path.join(distDir, "cache"))).toEqual(
      expect.arrayContaining([
        path.join("isr", "server", "app", "docs", "api", "get-health.html"),
        path.join("isr", "server", "app", "docs", "api", "get-health.rsc"),
        path.join("isr", "server", "app", "docs", "api", "get-health.meta"),
      ]),
    );

    // A fresh server (restart, or the entry evicted from memory) reads both
    // back from the volume, the revalidated copy ahead of the built one.
    const restarted = incrementalCache(ReadOnlyImageCacheHandler);
    expect(await readPage(restarted, "/docs/api/get-health")).toEqual({
      kind: "APP_PAGE",
      html: "<p>health</p>",
      rsc: '0:"<p>health</p>"\n',
    });
    expect((await readPage(restarted, "/docs/getting-started"))?.html).toBe(
      "<p>revalidated</p>",
    );
  });

  it("still serves the pages the build prerendered into the image", async () => {
    const cache = incrementalCache(ReadOnlyImageCacheHandler);
    expect(await readPage(cache, "/docs/getting-started")).toEqual({
      kind: "APP_PAGE",
      html: "<p>built</p>",
      rsc: '0:"built"\n',
    });
    expect(await readPage(cache, "/docs/api/never-rendered")).toBeNull();
  });
});
