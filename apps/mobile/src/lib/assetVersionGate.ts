/**
 * lib/assetVersionGate.ts — the one rule every asset WRITE now obeys, and the
 * sentences that go with it.
 *
 * WHAT CHANGED SERVER-SIDE. Every mutating route under `/api/v1/assets` is now
 * an optimistic-concurrency write and answers **428 `expected_version_required`**
 * when the field is absent or the wrong shape:
 *
 *   POST   /api/v1/assets                 expected_version must be 0   (handlers.go:171)
 *   PATCH  /api/v1/assets/{id}            positive                     (handlers.go:487)
 *   DELETE /api/v1/assets/{id}            positive, `force` in the BODY(handlers.go:554)
 *   PATCH  /api/v1/assets/{id}/folder     positive                     (folders.go:531)
 *   POST   /api/v1/assets/folders         must be 0                    (folders.go:402)
 *   PATCH  /api/v1/assets/folders/{id}    positive                     (folders.go:448)
 *   DELETE /api/v1/assets/folders/{id}    positive                     (folders.go:486 → handlers.go:657)
 *   POST   /api/v1/assets/{id}/tags       positive                     (tags.go:364)
 *   DELETE /api/v1/assets/{id}/tags/{tag} positive                     (tags.go:415 → handlers.go:657)
 *
 * When the number is present but no longer matches the stored row the answer is
 * **412 `stale_version`** ("asset changed after it was read" / "folder changed
 * after it was read").
 *
 * THE RULE THIS MODULE ENCODES: A VERSION IS READ, NEVER GUESSED. The only
 * honest source of the number is the row the screen is looking at
 * (`MobileAsset.version`, `AssetFolder.version`). When a row carries none, the
 * affordance is WITHHELD rather than fired with a guess — a guessed version is
 * either an immediate 428 or, if it happens to be right, a silent overwrite of
 * a teammate's edit. Both are worse than a control that is not offered.
 *
 * Import-free (no react-native, no expo) so every branch runs in the node
 * vitest environment.
 */

/**
 * `expected_version` for a CREATE. Both create routes demand exactly 0 —
 * `*in.ExpectedVersion != 0` is a 428 — and there is no row to read it from, so
 * it is a constant rather than a threaded value.
 */
export const ASSET_CREATE_VERSION = 0;

/**
 * Mirror of `exactPositiveJSONInteger` (handlers.go:637) and of the
 * `*in.ExpectedVersion <= 0` guard the other handlers use: a whole number from
 * 1 to 2^53-1. Anything else is refused HERE, so a client-side bug never
 * becomes a 428 whose message names a field the operator never saw.
 */
export function isAssetRowVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code.trim();
  }
  return "";
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

/** True for the 412 the server answers when the row moved under the read. */
export function isAssetStaleVersionError(error: unknown): boolean {
  return errorCode(error) === "stale_version" || errorStatus(error) === 412;
}

/** True for the 428 — reachable only as a client bug, and worth saying so. */
export function isAssetVersionMissingError(error: unknown): boolean {
  return (
    errorCode(error) === "expected_version_required" || errorStatus(error) === 428
  );
}

/**
 * The sentence for a version refusal, or null when the error is something else.
 *
 * A 412 is NOT a failure of the network and must not read like one: nothing was
 * written, someone else got there first, and the thing to do is refresh. A 428
 * means this app never sent the number at all — a bug, stated as a bug, rather
 * than blamed on the workspace.
 *
 * `noun` is what the operator was acting on ("image", "folder"), so the
 * sentence names the thing on screen rather than a generic "record".
 */
export function assetVersionErrorMessage(
  error: unknown,
  noun: string,
): string | null {
  if (isAssetStaleVersionError(error)) {
    return `Someone else changed this ${noun} after this screen read it, so nothing was changed. Pull to refresh and try again.`;
  }
  if (isAssetVersionMissingError(error)) {
    return `This app couldn't tell the server which version of the ${noun} it was changing, so nothing was changed. Pull to refresh and try again.`;
  }
  return null;
}

/**
 * Why the write affordances on the asset detail sheet are not being offered —
 * one sentence, or null when they ARE being offered.
 *
 * Three reasons, in the order the operator can act on them: the role, the
 * connection, and the missing version. The last is the new one: every write is
 * version-checked, the row did not carry a version, and a guessed number would
 * either be refused or overwrite someone. Consolidated here so the sheet renders
 * ONE note instead of a stack of conditionals, and so the wording is pinned by a
 * node test rather than by a render.
 */
export function assetWriteBlockNote(
  canWrite: boolean,
  online: boolean,
  versioned: boolean,
): string | null {
  if (!canWrite) {
    return "Deleting or organising an image needs an editor role. Anyone here can browse the library and copy an address.";
  }
  if (!online) {
    return "Deleting and organising are hidden while you're offline. They are never queued for later — a change that lands hours from now could undo one a teammate made in the meantime.";
  }
  if (!versioned) {
    return "Deleting and organising are unavailable for this image: this workspace didn't send the version every change is checked against, so a change made here could silently overwrite a teammate's. Pull to refresh.";
  }
  return null;
}

/**
 * May the asset-row writes (delete, file into a folder, tag) be OFFERED at all?
 *
 * The three conditions in one place because they must not drift from
 * `assetWriteBlockNote`, which explains their failure: a screen that gated the
 * button on two of them and the note on three would show an unexplained
 * absence. Kept here rather than inline in the screen so the rule is pinned by
 * a node test rather than by a render, and so the screen body stays inside its
 * complexity budget.
 */
export function canOfferAssetWrite(
  canWrite: boolean,
  online: boolean,
  rowVersion: number | null | undefined,
): boolean {
  return canWrite && online && isAssetRowVersion(rowVersion);
}

/**
 * The same fact for one FOLDER row in the organise sheet, where rename and
 * delete are the two version-gated verbs. Filing an image into the folder is
 * unaffected — that write is gated on the ASSET's version, not the folder's.
 */
export const ASSET_FOLDER_VERSION_MISSING =
  "Renaming and deleting this folder are unavailable: this workspace didn't send the version those changes are checked against. Close this and pull to refresh.";

/* ------------------------------------------------------------------ *
 * Reading the version a write ANSWERED with
 * ------------------------------------------------------------------ */

/**
 * The new version out of a write's response body.
 *
 * Every version-gated asset write answers with the row's NEW number —
 * `{"ok":true,"id":…,"version":N}` for the move, the tag removal and the folder
 * delete (folders.go:565, tags.go:429, folders.go:530), `{"tags":[…],
 * "version":N}` for a tag add (tags.go:398), and the whole row for the folder
 * create/rename and the alt-text PATCH. Returns null when the body carried
 * nothing usable — never a guess.
 */
export function parseAssetWriteVersion(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const version = (raw as Record<string, unknown>).version;
  return isAssetRowVersion(version) ? version : null;
}

/* ------------------------------------------------------------------ *
 * The ledger: which number to send for the NEXT write on a row
 * ------------------------------------------------------------------ */

/**
 * Versions learned from write RESPONSES, by row id (asset or folder).
 *
 * WHY THIS IS NEEDED AND IS NOT A CACHE. Several of these writes bump the
 * row's version without changing anything the list read shows: `AddTagsToAsset`
 * bumps `assets.version` even though the tag lives in a join table, and
 * `MoveAssetToFolder` bumps it on every move. So a second organising write made
 * before the invalidated read has landed would send the version the FIRST one
 * consumed — a 412 whose sentence ("someone else changed this") would be a lie,
 * because the someone else was you, one tap ago.
 *
 * The entries are still READ values, not guesses: each one is the number the
 * server itself put in the answer to the previous write.
 */
export type AssetVersionLedger = Readonly<Record<string, number>>;

export const EMPTY_ASSET_VERSION_LEDGER: AssetVersionLedger = {};

/**
 * The version to send for `rowId`, or null when nothing honest is available.
 *
 * Takes the HIGHER of the two things that have been read — the last write's
 * answer and the row currently on screen — because versions only ever increase
 * per row, so the larger number is strictly the more recent state we have seen.
 * A list refetch that started before our write reports the older one; a
 * teammate's edit reports a newer one, and sending it is right in both cases.
 */
export function ledgerVersion(
  ledger: AssetVersionLedger,
  rowId: string,
  rowVersion: number | null | undefined,
): number | null {
  const known = ledger[rowId];
  const candidates = [known, rowVersion].filter(isAssetRowVersion);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * Record what a write answered with. A non-version (the body did not carry
 * one, or carried junk) leaves the ledger untouched rather than clearing it —
 * forgetting a number that was genuinely read would send the next write back to
 * the staler row value for no reason.
 */
export function recordRowVersion(
  ledger: AssetVersionLedger,
  rowId: string,
  version: unknown,
): AssetVersionLedger {
  if (!rowId || !isAssetRowVersion(version)) return ledger;
  if (ledger[rowId] === version) return ledger;
  return { ...ledger, [rowId]: version };
}

/**
 * Drop a row the server no longer has (a deleted folder). Keeping its number
 * would resurrect it into a later `ledgerVersion` call for a REUSED id.
 */
export function forgetRowVersion(
  ledger: AssetVersionLedger,
  rowId: string,
): AssetVersionLedger {
  if (!(rowId in ledger)) return ledger;
  const next = { ...ledger };
  delete next[rowId];
  return next;
}
