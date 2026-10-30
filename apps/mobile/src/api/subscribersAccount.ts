/**
 * api/subscribersAccount.ts — SUB-012 account-link transport.
 *
 *   GET   /api/v1/accounts                    viewer — the directory
 *   POST  /api/v1/accounts                    editor — inline create
 *   PATCH /api/v1/subscribers/{id}/account    editor — {account_id}|null,
 *         If-Match: the subscriber revision the operator SAW (passed in,
 *         never re-read — the 412 exists to catch a concurrent change).
 *
 * Envelope errors become THROWS; the PATCH refuses to run without a token.
 */
import { rawRequest } from "@/api/request";

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

export async function listAccounts(): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", "/api/v1/accounts");
  if (res.error) surface(res.error, "Couldn't load the account directory.");
  return res.data;
}

export async function createAccount(
  body: Record<string, string>,
): Promise<{ id: string }> {
  const res = await rawRequest<{ id?: unknown }>(
    "POST",
    "/api/v1/accounts",
    body,
  );
  if (res.error) surface(res.error, "The account was not created.");
  const id = res.data && typeof res.data.id === "string" ? res.data.id : "";
  if (!id) {
    throw new Error("The server did not return the new account's id.");
  }
  return { id };
}

export async function setSubscriberAccount(
  subscriberId: string,
  accountId: string | null,
  version: string,
): Promise<unknown> {
  if (!version) {
    throw new Error(
      "The profile revision is missing, so the account link can't be changed safely. Reload and try again.",
    );
  }
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/account`,
    { account_id: accountId },
    { headers: { "If-Match": version } },
  );
  if (res.error) surface(res.error, "The account link was not changed.");
  return res.data;
}
