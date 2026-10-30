// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";

import { loadOpsRuntimeConfig } from "./opsConfig";
import {
  forwardedClientHeaders,
  knownOpsStatusMessage,
  OPS_VIEW_TIMEOUT_MS,
  readJSONResponseBounded,
  sessionCookieOnly,
} from "./opsSecurity";
import { MAX_VIEW_RESPONSE_BYTES } from "./viewSchema";

export type OpsViewFetchResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status?: number; kind: "configuration" | "network" | "invalid" };

export async function fetchOpsViewJSON(path: string): Promise<OpsViewFetchResult> {
  if (!path.startsWith("/api/internal/ops/") || path.includes("..")) {
    return { ok: false, kind: "configuration" };
  }

  let config;
  try {
    config = loadOpsRuntimeConfig();
  } catch {
    return { ok: false, kind: "configuration" };
  }

  try {
    const incoming = await headers();
    const cookie = sessionCookieOnly(incoming.get("cookie"));
    const response = await fetch(new URL(path, config.apiOrigin), {
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...forwardedClientHeaders(incoming),
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(OPS_VIEW_TIMEOUT_MS),
    });
    try {
      const body = await readJSONResponseBounded(
        response,
        MAX_VIEW_RESPONSE_BYTES,
      );
      return { ok: true, status: response.status, body };
    } catch {
      return { ok: false, status: response.status, kind: "invalid" };
    }
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function viewStatusMessage(status: number | undefined, surface: string): string {
  return (
    knownOpsStatusMessage(status) ??
    (status !== undefined && status >= 400 && status < 500
      ? `${surface} request was rejected`
      : `${surface} is unavailable`)
  );
}
