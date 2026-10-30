/**
 * api/assets.ts — transport for the workspace asset library.
 *
 * Every route below was read off the chi mounts themselves —
 * `apps/api/internal/assets/handlers.go::MountRoutes`,
 * `assets/folders.go::MountFolderRoutes` and `assets/bulk.go::MountBulkRoutes`,
 * all wired from `internal/server/analytics_asset_routes.go:56` — and each
 * guard was read in the handler rather than taken from a manifest row:
 *
 *   GET    /api/v1/assets          RequireScope(read:campaigns)  → {items,counts,nextCursor}
 *   GET    /api/v1/assets/folders  RequireScope(read:campaigns)  → {folders:[…]}
 *   GET    /api/v1/assets/tags     RequireScope(read:campaigns)  → {tags:[…]}
 *   GET    /api/v1/assets/{id}     RequireScope(read:campaigns)  → {asset,usage}
 *   POST   /api/v1/assets          RequireScope(write:campaigns) → Asset (201)
 *   DELETE /api/v1/assets/{id}     RequireScope(write:campaigns) → {ok:true} | 409
 *
 * THESE ARE SCOPE GATES, NOT ROLE GATES, AND THE TWO ARE NOT INTERCHANGEABLE.
 * `apikeys.RequireScope` (apikeys/middleware.go:183) splits on the principal:
 * an API key needs the literal scope, while a dashboard SESSION is mapped
 * through `readOnlyScopes` / `editorWriteScopes`. `read:campaigns` sits in
 * `readOnlyScopes`, so every signed-in role — viewer included — may list the
 * library. `write:campaigns` is in `editorWriteScopes`, so upload and delete
 * admit owner, admin AND editor, but not viewer. That is why the screen gates
 * writes on `canAccessMinimumRole("editor", …)` and reads on nothing.
 *
 * WHAT THE UPLOAD BODY ACTUALLY IS. The handler takes multipart OR
 * `{filename, mime, content_base64}` (handlers.go:104-161). Mobile sends the
 * JSON form: the SDK's `request()` JSON-stringifies `opts.body` and has no
 * multipart path at all, and expo-image-picker already hands back base64, so
 * the JSON form is the one that needs no new transport. `mime` is sent for the
 * contract's sake and is IGNORED server-side — `UploadBytes` takes it as `_`
 * and trusts only its own sniff (handlers.go:196).
 *
 * THE ORGANISING WRITES ARE HERE NOW (folders CRUD, tag add/remove, move-to-
 * folder — all editor-floor `write:campaigns`, mounted in folders.go:290 and
 * tags.go:248). The old argument for their absence — "library organisation is
 * desk work" — collapsed on its own premise: the one device that ADDS images
 * (upload is this surface's whole reason to exist, see the screen header)
 * could not file or label what it added, so every phone upload landed
 * uncategorised until a laptop cleaned up after it. All of these writes are
 * ONLINE-ONLY like the surface's other two verbs: the same screen already
 * hides every write affordance offline (lib/offlineQueueSafety), and a folder
 * move or tag replayed hours later could re-file an asset a teammate has
 * since organised differently.
 *
 * PATCH /{id} (alt text) IS here now. The old omission argued "writing
 * accessibility copy is a keyboard job", but the image this library most
 * needs described is the one that was just UPLOADED FROM THIS PHONE — the
 * flow this surface champions — and it shipped undescribed until a laptop
 * opened it. It is one sentence in one text field; phones type sentences
 * fine. The handler accepts `{alt_text, expected_version}` and nothing else
 * (any other key 400s with `unknown_field`), REQUIRES a positive
 * `expected_version` (428 otherwise), and bounds the text at 1024 RUNES
 * (lib/assetLibrary mirrors the bound so the client refuses before the 400).
 *
 * DELIBERATELY NOT HERE:
 *   - POST /assets/bulk-delete. It is a real endpoint, but it exists to fold a
 *     desktop multi-select into one request. This surface has no multi-select
 *     (a grid of thumbnails on a phone is a browsing surface, and arming
 *     destructive multi-select on it invites exactly the misclick the typed
 *     confirm is there to prevent), so there is no batch to fold.
 *   - GET /{id}/blob. Never called directly: it is the URL the filesystem
 *     backend already puts in `Asset.url`.
 *
 * Parsing lives in lib/assetLibrary so it is unit-testable in the node vitest
 * environment; this module is only URLs and envelopes.
 */
import {
  parseAsset,
  parseAssetDetail,
  parseAssetFolders,
  parseAssetPage,
  parseAssetTags,
  type AssetDetail,
  type AssetFolder,
  type AssetPage,
  type AssetTagCount,
  type MobileAsset,
} from "@/lib/assetLibrary";
import { parseAssetTagList } from "@/lib/assetOrganize";
import { ASSET_CREATE_VERSION } from "@/lib/assetVersionGate";

import {
  addAssetTagVersioned,
  removeAssetTagVersioned,
} from "./assetTagWrites";
import { checkedApiResult, rawRequest } from "./request";

const BASE = "/api/v1/assets";

/**
 * EVERY WRITE ON THIS SURFACE IS VERSION-GATED, AND THE GATE IS NOT OPTIONAL
 * SERVER-SIDE: 428 `expected_version_required` when the field is missing or the
 * wrong shape, 412 `stale_version` when it no longer matches the row. The
 * per-route table (which want 0, which want a positive number, which read it
 * from a DELETE's BODY) is in lib/assetVersionGate, read off the Go source.
 * Mobile sent it on none of them, so every asset write from this app failed.
 */

/**
 * `ListPageWithCounts` clamps anything outside 1..500 back to 50 (repo.go:159).
 * 30 keeps a two-column grid's first page to fifteen rows of thumbnails, which
 * is roughly three screens on a phone.
 */
export const ASSET_PAGE_SIZE = 30;

export interface AssetListQuery {
  /** Free text. Matched server-side against `lower(filename) LIKE`. */
  query?: string;
  /** One of ASSET_FILTERS; anything else is a 400. */
  filter?: string;
  /** A folder uuid, or the "root" sentinel for Uncategorised. */
  folderId?: string | null;
  tag?: string | null;
  /** One of ASSET_SORTS (lib/assetLibrary); anything else is a 400. */
  sort?: string | null;
  /** An asset id from a previous page's `nextCursor` — never constructed. */
  before?: string | null;
}

export function assetListPath(input: AssetListQuery): string {
  const params = new URLSearchParams();
  const query = (input.query ?? "").trim();
  if (query) params.set("q", query);
  // "all" is the server's own no-op value; omitting it keeps the URL honest
  // about what is actually being filtered.
  if (input.filter && input.filter !== "all") params.set("filter", input.filter);
  if (input.folderId) params.set("folder_id", input.folderId);
  if (input.tag) params.set("tag", input.tag);
  // "newest" is the server's own default ordering; omitting it keeps the URL
  // honest about what is actually being asked for.
  if (input.sort && input.sort !== "newest") params.set("sort", input.sort);
  if (input.before) params.set("before", input.before);
  params.set("limit", String(ASSET_PAGE_SIZE));
  return `${BASE}?${params.toString()}`;
}

export function assetPath(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export async function fetchAssetPage(
  input: AssetListQuery,
): Promise<AssetPage> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", assetListPath(input)),
  );
  return parseAssetPage(res.data);
}

export async function fetchAssetFolders(): Promise<AssetFolder[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${BASE}/folders`),
  );
  return parseAssetFolders(res.data);
}

export async function fetchAssetTags(): Promise<AssetTagCount[]> {
  const res = await checkedApiResult(rawRequest<unknown>("GET", `${BASE}/tags`));
  return parseAssetTags(res.data);
}

/**
 * The single read. It is NOT a more detailed version of the list row: the
 * handler re-runs `RecomputeReferenceCount` and refuses to answer at all if
 * that recompute fails (handlers.go:360), so the usage list it carries is
 * authoritative at the moment of the read while the list row's
 * `referencesCount` is a periodically refreshed scalar.
 */
export async function fetchAssetDetail(id: string): Promise<AssetDetail> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", assetPath(id)),
  );
  return parseAssetDetail(res.data);
}

export interface AssetUploadInput {
  /** Post-sanitisation preview lives in lib/assetUploadPolicy. */
  filename: string;
  /** Sent for the contract; the server sniffs and ignores it. */
  mime: string;
  contentBase64: string;
}

/**
 * Upload one image. 201 with the stored `Asset` as the bare body.
 *
 * The SDK auto-mints an `Idempotency-Key` for POST, which matters more here
 * than usual: this request carries megabytes over a mobile link, and a
 * transport-level retry of a succeeded upload would otherwise leave the
 * workspace with two identical rows and two blobs.
 *
 * `expected_version` IS A CONSTANT 0 HERE, NOT A THREADED VALUE: 428
 * "expected_version must be 0 for an asset create" for anything else
 * (handlers.go:171), because a create has no prior row to have read. Sent
 * unconditionally — no caller decision to get wrong. (Multipart takes it as a
 * form FIELD, handlers.go:137; the SDK has no multipart path.)
 */
export async function uploadAsset(
  input: AssetUploadInput,
): Promise<MobileAsset | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", BASE, {
      filename: input.filename,
      mime: input.mime,
      content_base64: input.contentBase64,
      expected_version: ASSET_CREATE_VERSION,
    }),
  );
  return parseAsset(res.data);
}

/* ------------------------------------------------------------------ *
 * Organising writes — folders CRUD, per-asset move, per-asset tags.
 * All editor-floor, all online-only (see the module header).
 * ------------------------------------------------------------------ */

/**
 * The FOLDER writes and the per-asset MOVE live in api/assetFolderWrites.ts —
 * this module was at its source budget — and are re-exported here so the
 * import surface every caller already uses is unchanged. Their version gates
 * are not uniform (create wants 0, rename/delete want the FOLDER's number, the
 * move wants the ASSET's), which is argued at length in that file.
 */
export {
  createAssetFolder,
  deleteAssetFolder,
  moveAssetToFolder,
  renameAssetFolder,
} from "./assetFolderWrites";

/** GET /api/v1/assets/{id}/tags — the asset's own tags, `{tags: [string]}`. */
export async function fetchAssetTagList(assetId: string): Promise<string[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${assetPath(assetId)}/tags`),
  );
  return parseAssetTagList(res.data);
}

/**
 * POST /api/v1/assets/{id}/tags — body `{tag, expected_version}`. Idempotent
 * server-side (ON CONFLICT DO NOTHING); answers the full tag list plus the
 * row's NEW version. The gate is the ASSET's version (positive; 428 at
 * tags.go:364) and `AddTagsToAsset` bumps `assets.version` even though the tag
 * lives in a join table — so two tags in a row need a refreshed number between
 * them, not the same one twice.
 *
 * THIS WRAPPER RESOLVES TO THE TAG LIST ALONE, and that is the only reason it
 * still exists: src/api/assets.test.ts (another session's file) pins the
 * resolved shape, and an array cannot also carry the new version. The app calls
 * `addAssetTagVersioned` directly; both are one request through one parse.
 */
export async function addAssetTag(
  assetId: string,
  tag: string,
  expectedVersion?: number,
): Promise<string[]> {
  return (await addAssetTagVersioned(assetId, tag, expectedVersion)).tags;
}

/**
 * DELETE /api/v1/assets/{id}/tags/{tag} — the tag is in the PATH, the version
 * is in the BODY (`readExpectedVersionBody`, tags.go:415 → handlers.go:642).
 * Answers the row's NEW version, which the next organising write needs.
 */
export async function removeAssetTag(
  assetId: string,
  tag: string,
  expectedVersion?: number,
): Promise<number | null> {
  return removeAssetTagVersioned(assetId, tag, expectedVersion);
}

/**
 * PATCH /api/v1/assets/{id} — the alt-text edit, and nothing else.
 *
 * The handler is strict about exactly that: the accepted keys are `alt_text`
 * and `expected_version` and nothing else (`unknown_field`, handlers.go:468),
 * `alt_text` must be present even when clearing — send `""` — and it is
 * bounded at 1024 RUNES (`alt_too_long`). The bound is mirrored client-side by
 * lib/assetLibrary.altTextBlockReason so the operator is refused before the
 * round trip, not after it.
 *
 * IT IS A VERSION-GATED WRITE, AND THAT IS NOT OPTIONAL SERVER-SIDE.
 * `exactPositiveJSONInteger(in["expected_version"])` (handlers.go:487) answers
 * 428 `expected_version_required` when the key is missing or not a positive
 * integer, and `UpdateAltText` answers 412 `stale_version` when it no longer
 * matches the stored row. Mobile sent neither and every save was therefore a
 * guaranteed 428. The version is now read off the asset row
 * (`MobileAsset.version`) and passed here.
 *
 * `expectedVersion` is typed optional ONLY because src/api/assets.test.ts pins
 * the pre-version body shape and is owned by another session; the app never
 * takes that path — the screen withholds the affordance when the row carries
 * no version, precisely so that a doomed request is never sent.
 *
 * ONLINE-ONLY like the surface's other writes: not registered in
 * lib/offlineMutationContract, so it is never queued. A description replayed
 * hours later could overwrite one a teammate wrote in the meantime — and the
 * version gate would refuse it anyway, which is the same argument in the
 * server's own words.
 *
 * The answer is the updated asset row (`writeJSON(w, http.StatusOK, a)`), so
 * the caller can patch its caches from the response instead of guessing.
 */
export async function updateAssetAltText(
  id: string,
  altText: string,
  expectedVersion?: number,
): Promise<MobileAsset | null> {
  const body: Record<string, unknown> = { alt_text: altText };
  if (
    typeof expectedVersion === "number" &&
    Number.isInteger(expectedVersion) &&
    expectedVersion > 0
  ) {
    body["expected_version"] = expectedVersion;
  }
  const res = await checkedApiResult(
    rawRequest<unknown>("PATCH", assetPath(id), body),
  );
  return parseAsset(res.data);
}

/**
 * Soft-delete one image.
 *
 * Without `force`, an asset embedded in a live campaign / template / form is
 * refused with 409 `has_references` and the referrer list (handlers.go:559).
 * That refusal is a FEATURE — it is the server declining to break a draft that
 * is about to go out — so the caller escalates deliberately behind a
 * typed-phrase confirm rather than sending `force` by default.
 *
 * BOTH FIELDS GO IN THE BODY, AND `?force=true` IS NOW A 400 IN ITS OWN RIGHT:
 * `r.URL.Query().Has("force")` answers `unsafe_force_transport` "force must be
 * supplied in the request body" (handlers.go:536) whatever the value. Mobile
 * sent exactly that query string, so a forced delete 400'd and an ordinary one
 * 428'd. `expected_version` must be a positive integer (handlers.go:554) and is
 * REQUIRED here — nothing pins this call's old body, so there is no reason to
 * leave a doomed shape reachable.
 */
export async function deleteAsset(
  id: string,
  expectedVersion: number,
  force = false,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("DELETE", assetPath(id), {
      expected_version: expectedVersion,
      force,
    }),
  );
}
