// SPDX-License-Identifier: AGPL-3.0-only
import { loadOpsRuntimeConfig } from "../../../lib/opsConfig";
import { readJSONResponseBounded } from "../../../lib/opsSecurity";
import { hasOnlyKeys, isRecord } from "../../../lib/viewSchema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const READY_TIMEOUT_MS = 2_000;
const READY_RESPONSE_BYTES = 4 * 1024;

/**
 * Non-sensitive readiness probe. It validates the fail-closed runtime
 * contract and proves the sole upstream dependency is itself ready, without
 * forwarding operator cookies or exposing internal hosts/errors.
 */
export async function GET(): Promise<Response> {
  try {
    const config = loadOpsRuntimeConfig();
    const response = await fetch(new URL("/api/ready", config.apiOrigin), {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(READY_TIMEOUT_MS),
    });
    if (!response.ok) return unavailable();
    const body = await readJSONResponseBounded(response, READY_RESPONSE_BYTES);
    if (
      !isRecord(body) ||
      !hasOnlyKeys(body, ["status"]) ||
      body.status !== "ready"
    ) return unavailable();
    return Response.json(
      { status: "ready" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return unavailable();
  }
}

function unavailable(): Response {
  return Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
