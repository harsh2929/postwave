// SPDX-License-Identifier: AGPL-3.0-only

export declare const RENDERED_CACHE_SERVER_DIR: string;

export default class ReadOnlyImageCacheHandler {
  constructor(ctx: {
    serverDistDir?: string;
    flushToDisk?: boolean;
    [key: string]: unknown;
  });
  get(key: string, ctx: unknown): Promise<unknown>;
  set(key: string, data: unknown, ctx: unknown): Promise<void>;
  revalidateTag(...args: unknown[]): Promise<void>;
  resetRequestCache(): void;
}
