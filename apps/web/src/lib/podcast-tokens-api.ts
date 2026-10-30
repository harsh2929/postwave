// SPDX-License-Identifier: AGPL-3.0-only

/**
 * lib/podcast-tokens-api.ts — private podcast subscriber tokens.
 *
 * Backend surface (apps/api/internal/podcast/podcast.go, admin scope):
 *   GET    /api/v1/podcast/subscribers/{email}/token  — metadata (404 when none)
 *   POST   /api/v1/podcast/subscribers/{email}/token  — mint or ROTATE;
 *          the raw token + feed_url come back ONLY on this response.
 *   DELETE /api/v1/podcast/subscribers/{email}/token  — revoke → {ok}.
 *
 * Public feeds (podcast.MountPublicRoutes):
 *   /api/public/podcast/{tenant_slug}/feed.xml          — free episodes
 *   /api/public/podcast/{tenant_slug}/feed/{token}.xml  — entitlement-aware
 *
 * Release-held: every verb refuses before any request while
 * ARCHIVE_PRIVATE_PODCAST_AVAILABLE is false (desktop gates the whole card
 * behind the same flag), so a held verb cannot reach the network from any
 * path.
 */
import { ApiError, api } from "@/lib/api";
import {
  ARCHIVE_PRIVATE_PODCAST_AVAILABLE,
  ArchiveOperationUnavailableError,
} from "@/lib/archive-operational-availability";

export interface PodcastSubscriberToken {
  tenant_id: string;
  subscriber_email: string;
  /** Raw secret — returned ONLY by the POST (mint/rotate); GET omits it. */
  token?: string;
  feed_url?: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Loose email shape check for the lookup input (desktop parity). */
export function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function apiOrigin(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/u, "");
}

/** Public (un-tokenized) RSS feed URL — free episodes only. */
export function publicPodcastFeedUrl(tenantSlug: string): string {
  return `${apiOrigin()}/api/public/podcast/${encodeURIComponent(tenantSlug)}/feed.xml`;
}

/**
 * Per-subscriber tokenized feed URL. The token is the raw secret the mint POST
 * returns ONCE — the server never re-issues it. Prefer the server-returned
 * `feed_url`; this builder is the fallback when the mint response omits it.
 */
export function tokenizedPodcastFeedUrl(
  tenantSlug: string,
  token: string,
): string {
  return `${apiOrigin()}/api/public/podcast/${encodeURIComponent(tenantSlug)}/feed/${encodeURIComponent(token)}.xml`;
}

export function resolveMintedPodcastFeedUrl(
  minted: PodcastSubscriberToken | null,
  tenantSlug: string | null,
): string | null {
  if (minted?.feed_url) return minted.feed_url;
  if (!minted?.token || !tenantSlug) return null;
  return tokenizedPodcastFeedUrl(tenantSlug, minted.token);
}

/** Never let the normal metadata row become a second plaintext owner. */
export function podcastTokenMetadata(
  value: PodcastSubscriberToken,
): PodcastSubscriberToken {
  const { token: _token, feed_url: _feedUrl, ...metadata } = value;
  return metadata;
}

function tokenPath(email: string): string {
  return `/api/v1/podcast/subscribers/${encodeURIComponent(email.trim())}/token`;
}

function requirePrivatePodcast(): void {
  if (!ARCHIVE_PRIVATE_PODCAST_AVAILABLE) {
    throw new ArchiveOperationUnavailableError("private_podcast");
  }
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function nullableStr(v: unknown): string | null | undefined {
  if (v === null) return null;
  return optStr(v);
}

/**
 * Whitelist copy of a server token row, verified against the email it was
 * requested for so a mis-routed record can never be shown as this
 * subscriber's.
 */
export function parsePodcastSubscriberToken(
  raw: unknown,
  expectedEmail: string,
): PodcastSubscriberToken {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const email = optStr(r.subscriber_email);
  const createdAt = optStr(r.created_at);
  if (
    !email ||
    !createdAt ||
    email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    throw new Error(
      "The service returned a podcast token record that could not be verified against the subscriber requested.",
    );
  }
  return {
    tenant_id: optStr(r.tenant_id) ?? "",
    subscriber_email: email,
    token: optStr(r.token),
    feed_url: optStr(r.feed_url),
    last_used_at: nullableStr(r.last_used_at),
    revoked_at: nullableStr(r.revoked_at),
    created_at: createdAt,
    updated_at: optStr(r.updated_at) ?? createdAt,
  };
}

/** GET — token metadata, or null when the subscriber has none (404). */
export async function getPodcastSubscriberToken(
  email: string,
  options: { signal?: AbortSignal } = {},
): Promise<PodcastSubscriberToken | null> {
  requirePrivatePodcast();
  try {
    const raw = await api.get<unknown>(tokenPath(email), {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: options.signal,
    });
    return parsePodcastSubscriberToken(raw, email);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * POST — mints a token, or ROTATES the existing one (the old feed URL stops
 * working). Reveal-once and non-replayable: no idempotency key, one attempt,
 * and no transparent step-up replay.
 */
export async function mintPodcastSubscriberToken(
  email: string,
): Promise<PodcastSubscriberToken> {
  requirePrivatePodcast();
  const raw = await api.post<unknown>(
    tokenPath(email),
    {},
    {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: null,
      allowStepUpRetry: false,
    },
  );
  return parsePodcastSubscriberToken(raw, email);
}

/** DELETE — revokes; the feed stops working on the next fetch. */
export async function revokePodcastSubscriberToken(
  email: string,
): Promise<void> {
  requirePrivatePodcast();
  const raw = await api.delete<{ ok?: unknown }>(tokenPath(email), {
    cache: "no-store",
    requireOnline: true,
    maxAttempts: 1,
  });
  if (raw?.ok !== true) {
    throw new Error("The service did not confirm that the token was revoked.");
  }
}
