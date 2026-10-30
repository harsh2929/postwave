/**
 * api/collections.ts — the two reference-collection reads a phone performs,
 * and the three writes it deliberately does not.
 *
 * AUTHORIZATION, READ FROM THE MOUNT TABLE (`collections/handlers.go:47-51`),
 * not from the manifest — and the five routes are NOT uniformly scoped, which
 * is the whole reason this file has a header:
 *
 *   GET    /api/v1/collections        RequireScope(ScopeReadSubscribers)   (:47)
 *   GET    /api/v1/collections/{id}   RequireScope(ScopeWriteSubscribers)  (:48)
 *   POST   /api/v1/collections        RequireScope(ScopeWriteSubscribers)  (:49)
 *   PATCH  /api/v1/collections/{id}   RequireScope(ScopeWriteSubscribers)  (:50)
 *   DELETE /api/v1/collections/{id}   RequireScope(ScopeWriteSubscribers)  (:51)
 *
 * The comment above that block states why the READ of one collection needs a
 * WRITE scope: "A full detail response can contain confidential lookup values,
 * so detail and mutations require write:subscribers until a dedicated
 * collection-data scope exists" (`handlers.go:36-39`).
 *
 * WHAT THAT MEANS FOR A SESSION, traced through the middleware rather than
 * assumed. `RequireScope` on the session-cookie path calls
 * `requireAdminRoleForScopes` (`apikeys/middleware.go:342-349`), which returns
 * true for any scope outside the `readOnlyScopes` allowlist. `read:subscribers`
 * IS in that allowlist (`middleware.go:332-337`), so the LIST never reaches a
 * role check — every role, viewer included, can read it. `write:subscribers` is
 * NOT in the allowlist, so the DETAIL reaches `sessionRoleAllowsScopes`
 * (`middleware.go:300-318`), which admits owner/admin and — because
 * `write:subscribers` is in `editorWriteScopes` (`middleware.go:291-294`) —
 * editor. A viewer gets 403 `insufficient_role`.
 *
 * So the floor is SPLIT: viewer for the catalogue, editor for the row bodies.
 * `routeauth/manifest.json` agrees (both rows `review_status: "reviewed"`,
 * `session_minimum_role` viewer and editor respectively), but the handler and
 * the middleware are what the split above is based on. A custom role can also
 * be granted the scope additively via `storedGrantsCoverScopes`
 * (`middleware.go:216`), which is why the screen still HANDLES a successful
 * detail read for a role the client pre-emptively doubted, and handles a live
 * 403 rather than only pre-empting.
 *
 * THREE ROUTES DELIBERATELY NOT USED. POST / PATCH / DELETE are authoring, and
 * authoring here means composing a rows array: `Create` takes `{ name,
 * collection_type, source_type, data }` where `data` is the already-parsed rows
 * and "a multipart CSV/JSON upload is parsed client-side ... before hitting
 * this endpoint" (`handlers.go:104-108`). A phone is the wrong device to hold
 * a 50,000-row file, and PATCH's data semantics are a trap in miniature —
 * omitted leaves the rows alone, `[]` clears them, `null` is rejected
 * (`types.go:86-95`) — which is a rule to get right on a keyboard with the
 * desktop's validator in view, not on a train.
 */
import {
  normalizeCollectionDetail,
  normalizeCollectionListPage,
  type CollectionDetail,
  type CollectionListPage,
} from "@/lib/collections";
import {
  COLLECTION_PAGE_LIMIT,
  collectionTypeParam,
  sanitizeCollectionQuery,
  type CollectionTypeFilter,
} from "@/lib/collectionInventory";
import { WireShapeError } from "@/lib/wireShapeError";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/** Keeps the HTTP status and code so the UI can tell a 403 from a 500. */
export class CollectionRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "CollectionRequestError";
  }
}

async function collectionRequest(path: string, label: string): Promise<unknown> {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) throw new CollectionRequestError(res.error, label);
  return res.data;
}

export interface CollectionListArgs {
  type: CollectionTypeFilter;
  query: string;
  /** Opaque `next_cursor` from the previous page, or `null` for page one. */
  cursor: string | null;
}

/**
 * One metadata page.
 *
 * `parseListOptions` rejects ANY query parameter outside
 * `{include_data, limit, cursor, q, collection_type}` with a 400
 * (`handlers.go:294-306`), so this builder is deliberately closed: nothing is
 * appended without a line in that allowlist.
 *
 * `include_data` is never sent. `include_data=true` is an explicit 400 —
 * "collection lists are metadata-only; fetch one collection detail with write
 * access" (`handlers.go:313-316`) — and `false` is the default, so sending it
 * would be a parameter that can only ever be redundant or fatal.
 */
export async function fetchCollections(
  args: CollectionListArgs,
): Promise<CollectionListPage> {
  const params = new URLSearchParams({ limit: String(COLLECTION_PAGE_LIMIT) });
  const type = collectionTypeParam(args.type);
  if (type) params.set("collection_type", type);
  const search = sanitizeCollectionQuery(args.query);
  // An unsubmittable query is dropped rather than sent: `q` is rejected
  // server-side for length or control/bidi runes (`handlers.go:343-350`), and
  // turning the user's own keystrokes into a red error state is worse than
  // showing the unfiltered list beside the reason.
  if (search.submittable && search.value) params.set("q", search.value);
  if (args.cursor) params.set("cursor", args.cursor);
  const raw = await collectionRequest(
    `/api/v1/collections?${params.toString()}`,
    "Loading reference collections",
  );
  return normalizeCollectionListPage(raw);
}

/**
 * One collection with its complete row bodies.
 *
 * The id goes through `encodeURIComponent` even though the server only accepts
 * a UUID (`readCollectionID` → `normalizeCollectionID`, `handlers.go:375-387`):
 * the id reaching this function comes from a payload, and building a path by
 * concatenation is how a malformed one becomes a request to a different route.
 */
export async function fetchCollectionDetail(
  id: string,
): Promise<CollectionDetail> {
  const trimmed = (id ?? "").trim();
  if (!trimmed) throw new Error("A collection id is required.");
  const raw = await collectionRequest(
    `/api/v1/collections/${encodeURIComponent(trimmed)}`,
    "Loading collection rows",
  );
  const detail = normalizeCollectionDetail(raw);
  if (!detail) {
    // A 200 whose body has no id is not an empty collection — it is a response
    // this client cannot read, and rendering it as zero rows would be a lie.
    throw new WireShapeError(
      "collection",
      "The server returned a collection this app cannot read.",
    );
  }
  return detail;
}
