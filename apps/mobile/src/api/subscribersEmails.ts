/**
 * api/subscribersEmails.ts — SUB-016 multi-email transport.
 *
 *   GET    /api/v1/subscribers/{id}/emails             viewer
 *   POST   /api/v1/subscribers/{id}/emails             editor  If-Match: SUBSCRIBER version
 *   PATCH  /api/v1/subscribers/{id}/emails/{email_id}  editor  If-Match: ADDRESS version
 *   DELETE /api/v1/subscribers/{id}/emails/{email_id}  editor  If-Match: ADDRESS version
 *
 * TWO DIFFERENT TOKENS, deliberately: attaching an address is conditional on
 * the PROFILE revision (read fresh here, the channel-consents idiom), while
 * consent/suppression/removal on one address bind to THAT ADDRESS's revision
 * as listed on screen — the decision was made against the row the operator
 * SAW, and a silent re-read could bind it to a different state (the 412
 * exists to catch exactly that).
 *
 * Kept react-native-free; the node vitest run pins bodies and headers with
 * `rawRequest` mocked. Envelope errors become THROWS.
 */
import { rawRequest } from "@/api/request";

function base(id: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(id)}/emails`;
}

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

export async function listSubscriberEmails(id: string): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", base(id));
  if (res.error) surface(res.error, "Couldn't load this profile's addresses.");
  return res.data;
}

/** The profile's own strong revision, read fresh for the POST. */
async function freshSubscriberVersion(id: string): Promise<string> {
  const res = await rawRequest<{ version?: unknown }>(
    "GET",
    `/api/v1/subscribers/${encodeURIComponent(id)}`,
  );
  if (res.error) surface(res.error, "Couldn't re-read this subscriber.");
  const version =
    res.data && typeof res.data.version === "string" ? res.data.version : "";
  if (!version) {
    throw new Error(
      "This deployment did not return a profile revision, so the address can't be attached safely.",
    );
  }
  return version;
}

export async function addSubscriberEmail(
  id: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const version = await freshSubscriberVersion(id);
  const res = await rawRequest<unknown>("POST", base(id), body, {
    headers: { "If-Match": version },
  });
  if (res.error) surface(res.error, "Couldn't attach the address.");
  return res.data;
}

function requireRowVersion(version: string): void {
  if (!version) {
    throw new Error(
      "This address is missing its revision token. Re-open the card and try again.",
    );
  }
}

export async function updateSubscriberEmail(
  id: string,
  emailId: string,
  version: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  requireRowVersion(version);
  const res = await rawRequest<unknown>(
    "PATCH",
    `${base(id)}/${encodeURIComponent(emailId)}`,
    body,
    { headers: { "If-Match": version } },
  );
  if (res.error) surface(res.error, "The address change was not recorded.");
  return res.data;
}

export async function deleteSubscriberEmail(
  id: string,
  emailId: string,
  version: string,
): Promise<void> {
  requireRowVersion(version);
  const res = await rawRequest<unknown>(
    "DELETE",
    `${base(id)}/${encodeURIComponent(emailId)}`,
    undefined,
    { headers: { "If-Match": version } },
  );
  if (res.error) surface(res.error, "The address was not removed.");
}
