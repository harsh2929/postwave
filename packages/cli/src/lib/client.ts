// SPDX-License-Identifier: MIT

import { PostwaveClient } from "@postwave/sdk";
import { resolveApiKey, resolveBaseUrl, resolveTenantId } from "./config.js";

export interface ClientOpts {
  apiKey?: string;
  baseUrl?: string;
  tenantId?: string;
}

export function createClient(opts: ClientOpts = {}): PostwaveClient {
  const apiKey = resolveApiKey(opts.apiKey);
  if (!apiKey) {
    throw new Error(
      "Not authenticated. Run `postwave login`, set POSTWAVE_API_KEY, or pass --api-key.",
    );
  }
  return new PostwaveClient({
    apiKey,
    baseUrl: resolveBaseUrl(opts.baseUrl),
    tenantId: resolveTenantId(opts.tenantId),
  });
}
