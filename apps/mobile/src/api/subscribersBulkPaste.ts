/**
 * api/subscribersBulkPaste.ts — POST /api/v1/subscribers/bulk-paste (editor).
 *
 * The RAW paste travels as-is: the server owns the splitting (bulk_paste.go),
 * and a client that pre-parsed and re-joined would silently disagree with it
 * on some clipboard shape. `status` is pinned to "unconfirmed" — the same
 * non-sendability stance as the single create, and exactly what desktop's
 * SubscriberAddModal submits.
 *
 * Kept react-native-free so the node vitest run pins the wire body with
 * `rawRequest` mocked. UNWRAP BEFORE USING: `rawRequest` resolves to the
 * {data, error} ENVELOPE; error becomes a THROW so a refused paste can never
 * read as an accepted one.
 */
import { rawRequest } from "@/api/request";

export async function bulkPasteSubscribers(input: {
  /** The operator's paste, untouched. */
  emails: string;
  tags: string[];
}): Promise<unknown> {
  const res = await rawRequest<unknown>("POST", "/api/v1/subscribers/bulk-paste", {
    emails: input.emails,
    status: "unconfirmed",
    ...(input.tags.length > 0 ? { tags: input.tags } : {}),
  });
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't add the pasted subscribers."),
      res.error,
    );
  }
  return res.data;
}
