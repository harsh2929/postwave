/**
 * api/tagsManage.ts — tag maintenance transport.
 *
 *   PATCH  /api/v1/tags/{id}         editor  If-Match: "tag:{id}:v{n}"
 *   GET    /api/v1/tags/{id}/history viewer  paged event feed
 *   POST   /api/v1/tag-groups        editor
 *   PATCH  /api/v1/tag-groups/{id}   editor
 *   DELETE /api/v1/tag-groups/{id}   editor
 *
 * NO deleteTag / bulkDeleteTags here — both routes are unconditional
 * server-side 409 holds (see lib/tagManage's module doc). The PATCH
 * refuses to run without the row's etag. Envelope errors THROW.
 */
import { rawRequest } from "@/api/request";

function surface(error: { message: string } | null, fallback: string): never {
  throw Object.assign(new Error(error?.message || fallback), error ?? {});
}

export async function updateTag(
  id: string,
  etag: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!etag) {
    throw new Error(
      "This tag is missing its revision token. Pull the list to refresh and try again.",
    );
  }
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/tags/${encodeURIComponent(id)}`,
    body,
    { headers: { "If-Match": etag } },
  );
  if (res.error) surface(res.error, "The tag was not updated.");
  return res.data;
}

export async function fetchTagHistory(
  id: string,
  cursor?: string,
): Promise<unknown> {
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (cursor) params.set("cursor", cursor);
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/tags/${encodeURIComponent(id)}/history?${params.toString()}`,
  );
  if (res.error) surface(res.error, "Couldn't load the tag's history.");
  return res.data;
}

export async function createTagGroup(
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await rawRequest<unknown>("POST", "/api/v1/tag-groups", body);
  if (res.error) surface(res.error, "The group was not created.");
  return res.data;
}

export async function updateTagGroup(
  id: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/tag-groups/${encodeURIComponent(id)}`,
    body,
  );
  if (res.error) surface(res.error, "The group was not updated.");
  return res.data;
}

export async function deleteTagGroup(id: string): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/tag-groups/${encodeURIComponent(id)}`,
  );
  if (res.error) surface(res.error, "The group was not deleted.");
  return res.data;
}
