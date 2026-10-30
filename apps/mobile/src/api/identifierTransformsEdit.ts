/**
 * api/identifierTransformsEdit.ts — the WRITE and the dry-run behind the
 * identifier-transforms editor sheet.
 *
 *   PATCH /api/v1/settings/identifier-transforms   (admin)
 *   POST  /api/v1/subscribers/preview-transforms   (editor)
 *
 * api/platformConfig.ts owns the read and recorded why the phone was
 * read-only; this module is the deliberate reversal for the one surface the
 * parity register judged phone-shaped, on two conditions the sheet enforces:
 * a live preview of the unsaved draft, and a confirm before the save.
 *
 * Errors are typed by status (PlatformConfigError) for the same reason the
 * reads are: the sheet's decision is "hide" vs "show a failure".
 */
import { PlatformConfigError } from "./platformConfig";
import { rawRequest } from "./request";

import {
  normalizeTransformPreview,
  type IdentifierTransformsPatch,
  type TransformPreviewRequest,
  type TransformPreviewView,
} from "@/lib/identifierTransformsEdit";
import {
  normalizeIdentifierTransforms,
  type IdentifierTransformsView,
} from "@/lib/platformConfig";
import { WireShapeError } from "@/lib/wireShapeError";

/**
 * Partial PATCH — only the fields present change (pointer semantics on the
 * server, identifier_normalizer.go:405). Answers the full config as stored.
 */
export async function updateIdentifierTransforms(
  patch: IdentifierTransformsPatch,
): Promise<IdentifierTransformsView> {
  const res = await rawRequest<unknown>(
    "PATCH",
    "/api/v1/settings/identifier-transforms",
    patch,
  );
  if (res.error) {
    throw new PlatformConfigError(
      res.error.status,
      res.error.message || "Couldn't save the identifier rules.",
    );
  }
  return normalizeIdentifierTransforms(res.data);
}

/**
 * Dry-run the DRAFT (sent as `overrides`) against a sample — the same
 * endpoint the import wizard uses, so what the sheet shows is what ingest
 * would store (identifier_normalizer.go:445).
 */
export async function previewIdentifierTransforms(
  body: TransformPreviewRequest,
): Promise<TransformPreviewView> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/subscribers/preview-transforms",
    body,
  );
  if (res.error) {
    throw new PlatformConfigError(
      res.error.status,
      res.error.message || "Couldn't preview the identifier rules.",
    );
  }
  const preview = normalizeTransformPreview(res.data);
  if (!preview) {
    throw new WireShapeError(
      "identifier transform preview",
      "Preview response was malformed.",
    );
  }
  return preview;
}
