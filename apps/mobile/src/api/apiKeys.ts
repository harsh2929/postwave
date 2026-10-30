/**
 * api/apiKeys.ts — read + revoke for workspace API keys.
 *
 * Revoking a leaked key is the single most time-critical security action a
 * workspace owner ever takes, and until now it required a laptop: a key
 * committed to a public repo stayed live until someone got to a desk.
 * Revocation needs no typing beyond a confirmation, so it belongs on a phone.
 *
 * DELIBERATELY NOT HERE:
 *  - CREATE. The creation editor is a 13-scope matrix plus IP allow-lists and
 *    rate limits; scopes are fixed at creation time, so a mis-tapped scope on a
 *    phone is unfixable. That is a desktop shape.
 *  - ROTATE. Rotation returns the new plaintext EXACTLY ONCE. Mobile has no
 *    hardened capture ceremony for a reveal-once secret today (no clipboard
 *    dependency, no capture-before-dismiss gate), so offering rotate here would
 *    manufacture the exact dead end it is supposed to solve: a secret the user
 *    can see, cannot copy, and cannot get back.
 *
 * Endpoints: GET /api/v1/api-keys, DELETE /api/v1/api-keys/{id} (a SOFT revoke
 * — `revoked_at` is stamped and audit history is preserved).
 */
import { rawRequest, type AIApiError } from "./request";

export interface ApiKeySummary {
  id: string;
  label: string;
  /** Non-secret prefix — the only part of the key the server ever shows again. */
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
  /** "human" | "agent" — an agent key is a machine principal. */
  actorType: string;
  actorLabel?: string | undefined;
  /** True when the key is forced into sandbox mode and can never send real mail. */
  sandboxOnly: boolean;
  expiresAt?: string | undefined;
}

class ApiKeyError extends Error {
  readonly status: number;
  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ApiKeyError";
    this.status = error.status;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeKey(entry: unknown): ApiKeySummary | null {
  if (!entry || typeof entry !== "object") return null;
  const r = entry as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const scopes = Array.isArray(r.scopes)
    ? r.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return {
    id,
    label: str(r.label) || "Untitled key",
    prefix: str(r.prefix),
    scopes,
    createdAt: str(r.createdAt),
    ...(optionalStr(r.lastUsedAt) ? { lastUsedAt: optionalStr(r.lastUsedAt) } : {}),
    ...(optionalStr(r.revokedAt) ? { revokedAt: optionalStr(r.revokedAt) } : {}),
    actorType: str(r.actorType) || "human",
    ...(optionalStr(r.actorLabel) ? { actorLabel: optionalStr(r.actorLabel) } : {}),
    sandboxOnly: r.sandboxOnly === true,
    ...(optionalStr(r.expiresAt) ? { expiresAt: optionalStr(r.expiresAt) } : {}),
  };
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/api-keys");
  if (res.error) throw new ApiKeyError(res.error, "Couldn't load API keys.");
  // The handler writes the repository slice directly, so the wire shape is a
  // bare array; tolerate an enveloped variant rather than rendering nothing.
  const raw = Array.isArray(res.data)
    ? res.data
    : res.data && typeof res.data === "object"
      ? ((res.data as { items?: unknown }).items ?? [])
      : [];
  const arr = Array.isArray(raw) ? raw : [];
  const out: ApiKeySummary[] = [];
  for (const entry of arr) {
    const key = normalizeKey(entry);
    if (key) out.push(key);
  }
  return out;
}

/** Soft-revoke a key. Irreversible from the client's point of view. */
export async function revokeApiKey(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/api-keys/${encodeURIComponent(id)}`,
  );
  if (res.error) throw new ApiKeyError(res.error, "Couldn't revoke the key.");
}
