/**
 * lib/assetErrors.ts — what to SAY when the asset library refuses something,
 * and how hard to make a delete.
 *
 * Split out of lib/assetUploadPolicy when that file crossed its 450-line source
 * budget. The seam is deliberate rather than mechanical: the policy module
 * answers "may this happen", while this one answers "the server said no — what
 * does a person do about it". Both stay import-free (no react-native, no expo)
 * so every branch is exercised in the node vitest environment.
 *
 * THE ONE THING THAT MAKES THIS ENDPOINT DIFFERENT. Three genuinely different
 * refusals share ONE error code. `Upload` passes the Go sentinel straight
 * through as the message (`httperror.WriteValidation(w, "validation_failed",
 * err.Error())`, handlers.go:178), so "too big", "not an image" and "empty
 * body" all arrive as `validation_failed` and differ only in text like
 * "assets: exceeds max size". Branching on the code alone would collapse them
 * into one useless sentence; showing the message raw would put a Go error
 * string in front of an operator. So this module branches on both.
 */
import {
  ASSET_ACCEPTED_SENTENCE,
  ASSET_MAX_BYTES,
  assetSizeLabel,
} from "./assetUploadPolicy";

const ACCEPTED_SENTENCE = ASSET_ACCEPTED_SENTENCE;


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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/**
 * One sentence for a failed upload.
 *
 * `validation_failed` needs a second level of branching that no other endpoint
 * in this app needs: the handler passes the Go sentinel straight through as the
 * message (`httperror.WriteValidation(w, "validation_failed", err.Error())`,
 * handlers.go:178), so all three distinct refusals share ONE code and differ
 * only in text like "assets: exceeds max size". Showing that text raw would put
 * a Go error string in front of an operator.
 */
export function assetUploadErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const code = errorCode(error);
  const text = errorText(error).toLowerCase();
  if (code === "validation_failed") {
    if (text.includes("exceeds max size")) {
      return `The server refused it as too large. Images must be under ${assetSizeLabel(ASSET_MAX_BYTES)}.`;
    }
    if (text.includes("not a recognised image")) {
      return `The server couldn't read that as an image. ${ACCEPTED_SENTENCE}`;
    }
    if (text.includes("empty body")) {
      return "The upload arrived empty. Try picking the image again.";
    }
    return `The server refused that image. ${ACCEPTED_SENTENCE}`;
  }
  if (code === "payload_too_large") {
    return `That upload is over the request limit. Images must be under ${assetSizeLabel(ASSET_MAX_BYTES)}.`;
  }
  if (code === "bad_base64") {
    return "The image data was corrupted on the way out. Try again.";
  }
  if (code === "storage_unavailable" || code === "repo_unavailable") {
    return "This workspace has no asset storage configured, so nothing can be uploaded yet.";
  }
  const status = errorStatus(error);
  if (status === 401) return "Your session expired. Sign in and try again.";
  if (status === 403) return "Your role on this workspace doesn't allow uploads.";
  if (status === 413) {
    return `That upload is over the request limit. Images must be under ${assetSizeLabel(ASSET_MAX_BYTES)}.`;
  }
  if (status === 429) return "Too many requests just now — try again shortly.";
  if (status === 503) {
    return "Asset storage is unavailable on this deployment right now.";
  }
  if (status >= 500) return "The server couldn't store that image. Try again.";
  const raw = errorText(error).trim();
  return raw || fallback;
}

/**
 * One sentence for a failed delete.
 *
 * `has_references` is the interesting one: it is the server REFUSING to break
 * live drafts (handlers.go:473), not a fault, and the caller answers it by
 * re-issuing with `?force=true` behind a typed-phrase confirm — so this message
 * is only ever reached when the caller decided not to escalate.
 */
export function assetDeleteErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const code = errorCode(error);
  if (code === "has_references") {
    return "That image is still used by live drafts, so it wasn't deleted.";
  }
  if (code === "repo_unavailable") {
    return "This workspace has no asset storage configured.";
  }
  const status = errorStatus(error);
  if (status === 401) return "Your session expired. Sign in and try again.";
  if (status === 403) return "Your role on this workspace doesn't allow deleting.";
  if (status === 404) return "That image is already gone from this workspace.";
  if (status === 409) {
    return "That image is still used by live drafts, so it wasn't deleted.";
  }
  if (status >= 500) return "The server couldn't delete that image. Try again.";
  const raw = errorText(error).trim();
  return raw || fallback;
}

/** True when the server refused a delete because live drafts still use it. */
export function isAssetReferencedError(error: unknown): boolean {
  return errorCode(error) === "has_references" || errorStatus(error) === 409;
}

/* ------------------------------------------------------------------ *
 * The delete prompt
 * ------------------------------------------------------------------ */

/**
 * Structurally compatible with `ConfirmOptions` (components/ConfirmSheet) and
 * declared here rather than imported, because importing it would drag
 * react-native into this module and cost every rule above its node test.
 */
export interface AssetDeletePrompt {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: boolean;
  consequence?: string;
  confirmPhrase?: string;
}

/**
 * How hard to make the operator work to delete this image.
 *
 * The escalation is the server's own distinction, not a UI flourish. A DELETE
 * without `?force=true` is refused with 409 for any asset a live campaign,
 * template or form still embeds (handlers.go:473) — so choosing to send `force`
 * is choosing to leave a broken image inside something that may be about to
 * send. That gets the typed-phrase gate; an unreferenced image gets an ordinary
 * confirm, because making every delete feel identical is how people stop
 * reading them.
 *
 * `referenceCount === null` means the count was never established. It is
 * treated as REFERENCED: the expensive confirm on an unused image costs a few
 * seconds, the cheap confirm on a used one costs a live send.
 */
export function assetDeletePrompt(
  filename: string,
  referenceCount: number | null,
): AssetDeletePrompt {
  const name = filename.trim() || "this image";
  const referenced = referenceCount === null || referenceCount > 0;
  if (!referenced) {
    return {
      title: `Delete ${name}?`,
      message:
        "It leaves the library immediately. Anything already sent keeps working — those emails were delivered with their own copy.",
      confirmLabel: "Delete",
      destructive: true,
    };
  }
  const used =
    referenceCount === null
      ? "This workspace couldn't confirm what still uses this image"
      : referenceCount === 1
        ? "1 live campaign, template or form still uses this image"
        : `${referenceCount} live campaigns, templates or forms still use this image`;
  return {
    title: "Delete an image that is in use?",
    message: `${used}. Deleting it leaves a broken image in each of them, including anything scheduled to send.`,
    confirmLabel: "Delete anyway",
    destructive: true,
    consequence: `Type ${name} to confirm.`,
    confirmPhrase: name,
  };
}
