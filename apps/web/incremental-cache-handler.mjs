// SPDX-License-Identifier: AGPL-3.0-only
//
// Next's incremental (ISR) cache for a read-only release image.
//
// The runtime image is immutable: the standalone tree is `chmod -R a-w` and the
// container runs with a read-only root filesystem (ECS ReadonlyRootFilesystem;
// `docker run --read-only` in scripts/release/verify-web-image.sh). The only
// writable application path is the per-task .next/cache volume. Next's default
// handler writes every page it renders at request time into .next/server/app —
// inside the image — so each first visit to an on-demand docs page
// (/docs/api/*, /docs/skills/*: generateStaticParams returns []) and every
// revalidation of a prerendered ISR page logged
//   Failed to update prerender cache for /docs/api/… ENOENT: mkdir
//   '/app/apps/web/.next/server/app/docs/api'
// and the page survived only in the in-memory LRU.
//
// This is Next's own FileSystemCache with its writes moved to the volume:
//   get: memory, then what this server rendered (.next/cache/isr), then what
//        the build prerendered into the image (.next/server/app);
//   set: memory and .next/cache/isr only. The image is never written.
// The build itself writes its prerendered pages directly, not through a cache
// handler, so the image's contents are unchanged by this module.

import path from "node:path";

import FileSystemCacheModule from "next/dist/server/lib/incremental-cache/file-system-cache.js";

/** @type {any} */
const FileSystemCache = FileSystemCacheModule.default ?? FileSystemCacheModule;

/**
 * Where rendered entries go, relative to the Next dist dir: under .next/cache,
 * the one writable volume. FileSystemCache stores pages under
 * `<serverDistDir>/app` and fetch data under `<serverDistDir>/../cache`.
 */
export const RENDERED_CACHE_SERVER_DIR = path.join("cache", "isr", "server");

export default class ReadOnlyImageCacheHandler {
  /** @param {{ serverDistDir?: string, flushToDisk?: boolean } & Record<string, unknown>} ctx */
  constructor(ctx) {
    if (!ctx.serverDistDir) {
      throw new Error("incremental cache handler: serverDistDir is required");
    }
    const distDir = path.dirname(ctx.serverDistDir);
    this.rendered = new FileSystemCache({
      ...ctx,
      serverDistDir: path.join(distDir, RENDERED_CACHE_SERVER_DIR),
    });
    this.prerendered = new FileSystemCache({ ...ctx, flushToDisk: false });
  }

  /**
   * @param {string} key
   * @param {unknown} ctx
   */
  async get(key, ctx) {
    return (
      (await this.rendered.get(key, ctx)) ?? this.prerendered.get(key, ctx)
    );
  }

  /**
   * @param {string} key
   * @param {unknown} data
   * @param {unknown} ctx
   */
  set(key, data, ctx) {
    return this.rendered.set(key, data, ctx);
  }

  /** @param {...unknown} args */
  revalidateTag(...args) {
    return this.rendered.revalidateTag(...args);
  }

  resetRequestCache() {}
}
