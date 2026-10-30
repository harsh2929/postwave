/**
 * api/subscriberChannelConsents.ts — SUB-042 per-channel consent transport.
 *
 *   GET   /api/v1/subscribers/{id}/channel-consents            viewer
 *   PATCH /api/v1/subscribers/{id}/channel-consents/{channel}  editor
 *
 * THE PATCH IS CONDITIONAL. The handler answers 428 unless it receives a
 * strong `If-Match` carrying the CURRENT subscriber version (the channel rows
 * hang off the parent profile's concurrency token — channel_consents.go
 * rejects absent/wildcard/weak/list If-Match before touching anything). The
 * token changes on every profile write, so it is READ FRESH here immediately
 * before the PATCH — the same reasoning as api/subscriberConditionalWrite.ts,
 * which cannot be reused directly because it PATCHes the profile route itself.
 *
 * Kept react-native-free (only impure import is ./request) so the node vitest
 * run can pin the wire shapes — including the If-Match header — with
 * `rawRequest` mocked.
 */
import { rawRequest } from "@/api/request";

function base(id: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(id)}/channel-consents`;
}

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

/** The raw GET body ({items: [...]}) — parsing lives in the lib sibling. */
export async function fetchChannelConsents(id: string): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", base(id));
  if (res.error) surface(res.error, "Couldn't load channel consents.");
  return res.data;
}

/**
 * Read the profile's CURRENT version for the conditional write. The detail
 * body carries it as `version` (the same field the archive endpoints demand
 * verbatim); some deployments wrap the row in `{data: …}`.
 */
async function freshSubscriberVersion(id: string): Promise<string> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/subscribers/${encodeURIComponent(id)}`,
  );
  if (res.error) surface(res.error, "Couldn't read the subscriber.");
  const body = res.data as { version?: unknown; data?: { version?: unknown } };
  const version =
    typeof body?.version === "string"
      ? body.version
      : typeof body?.data?.version === "string"
        ? body.data.version
        : "";
  if (!version) {
    throw new Error(
      "This deployment did not return a concurrency token for this subscriber, so the consent change can't be saved safely.",
    );
  }
  return version;
}

/**
 * Upsert one channel's consent WITH the reviewed-evidence envelope (built by
 * lib/subscriberConsentEvidence.buildChannelConsentBody — this function never
 * invents body keys). Returns the response row, whose `subscriber_version` is
 * the fresh token for whoever writes next.
 */
export async function setChannelConsent(
  id: string,
  channel: string,
  body: Record<string, string>,
): Promise<unknown> {
  const version = await freshSubscriberVersion(id);
  const res = await rawRequest<unknown>(
    "PATCH",
    `${base(id)}/${encodeURIComponent(channel)}`,
    body,
    { headers: { "If-Match": version } },
  );
  if (res.error) surface(res.error, "Couldn't record the consent change.");
  return res.data;
}
