/**
 * api/ingestSecrets.ts — transport for the signed-ingest key register.
 *
 * Lived in `src/lib/` until 2026-09-04, which made
 * `src/lib/stoppingHalfPolicy.test.ts` report that mobile "no longer reaches
 * conversions/ingest-secrets" — that guard scans `src/api` and `src/hooks`,
 * because those are where this app puts transport. The capability was reachable
 * the whole time; the file had drifted out of the directory the convention
 * names, and the guard was right to call it.
 */
import { rawRequest } from "@/api/request";
import { parseIngestSecrets, type IngestSecretPage } from "@/lib/ingestSecrets";

const BASE = "/api/v1/conversions/ingest-secrets";
const PAGE_SIZE = 100;

/** Admin-only metadata register. A secret-bearing row fails closed in parser. */
export async function listIngestSecrets(
  cursor?: string,
): Promise<IngestSecretPage> {
  if (
    cursor !== undefined &&
    (!cursor ||
      cursor !== cursor.trim() ||
      /[\u0000-\u001f\u007f]/u.test(cursor) ||
      new TextEncoder().encode(cursor).byteLength > 512)
  ) {
    throw new Error("Signed-ingest register cursor is invalid.");
  }
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const res = await rawRequest<unknown>("GET", `${BASE}?${params.toString()}`);
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  return parseIngestSecrets(res.data);
}

/** Admin-only emergency revocation; the client requires positive confirmation. */
export async function revokeIngestSecret(keyId: string): Promise<void> {
  const id = keyId.trim();
  if (!/^[0-9a-f]{32}$/u.test(id)) {
    throw new Error("Signed-ingest key ID is invalid.");
  }
  const res = await rawRequest<unknown>(
    "POST",
    `${BASE}/${encodeURIComponent(id)}/revoke`,
    {},
  );
  if (res.error) throw Object.assign(new Error(res.error.message), res.error);
  if (
    !res.data ||
    typeof res.data !== "object" ||
    (res.data as Record<string, unknown>).revoked !== true
  ) {
    throw new Error("The server did not confirm signed-ingest key revocation.");
  }
}
