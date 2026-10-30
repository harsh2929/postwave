/**
 * api/subscribersFederation.ts — SUB-023 federated-identity transport.
 *
 *   GET    /api/v1/subscribers/{id}/federated-links                       viewer
 *   POST   /api/v1/subscribers/{id}/federated-links                       editor  If-Match
 *   DELETE /api/v1/subscribers/{id}/federated-links/{master_subscriber}   editor  If-Match
 *
 * The If-Match token is the `subscriber_version` the LIST response carried —
 * passed by the caller, never re-read here: the link/unlink decision was
 * made against the state on screen (desktop enforces the same). Refuses to
 * write without one. Envelope errors become THROWS.
 */
import { rawRequest } from "@/api/request";

function base(id: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(id)}/federated-links`;
}

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

function requireVersion(version: string): void {
  if (!version) {
    throw new Error(
      "The profile revision is missing. Re-open the card and try again.",
    );
  }
}

export async function listFederatedLinks(id: string): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", base(id));
  if (res.error) surface(res.error, "Couldn't load federated identities.");
  return res.data;
}

export async function createFederatedLink(
  id: string,
  version: string,
  body: Record<string, string>,
): Promise<unknown> {
  requireVersion(version);
  const res = await rawRequest<unknown>("POST", base(id), body, {
    headers: { "If-Match": version },
  });
  if (res.error) surface(res.error, "The identity link was not created.");
  return res.data;
}

export async function deleteFederatedLink(
  id: string,
  masterSubscriberId: string,
  version: string,
): Promise<unknown> {
  requireVersion(version);
  const res = await rawRequest<unknown>(
    "DELETE",
    `${base(id)}/${encodeURIComponent(masterSubscriberId)}`,
    undefined,
    { headers: { "If-Match": version } },
  );
  if (res.error) surface(res.error, "The identity link was not removed.");
  return res.data;
}
