import type { FormField } from "@/lib/forms-types";

const PUBLIC_UPLOAD_HARD_CAP_BYTES = 25 * 1024 * 1024;
const PUBLIC_UPLOAD_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
];

export type PublicUploadValidationIssue =
  | { code: "empty" }
  | { code: "too_large"; max: string }
  | { code: "no_supported_types" }
  | { code: "type_not_allowed"; accepted: string };

export function publicUploadValidationIssue(
  field: FormField,
  file: File,
): PublicUploadValidationIssue | null {
  if (file.size <= 0) {
    return { code: "empty" };
  }
  const configuredMax =
    typeof field.maxBytes === "number" &&
    Number.isFinite(field.maxBytes) &&
    field.maxBytes > 0
      ? field.maxBytes
      : PUBLIC_UPLOAD_HARD_CAP_BYTES;
  const maxBytes = Math.min(configuredMax, PUBLIC_UPLOAD_HARD_CAP_BYTES);
  if (file.size > maxBytes) {
    return { code: "too_large", max: formatBytes(maxBytes) };
  }
  const configuredAllowed = (field.acceptMime ?? [])
    .map(normalizeMime)
    .filter(Boolean);
  const platformAllowed = new Set(PUBLIC_UPLOAD_ALLOWED_MIME);
  const allowed =
    configuredAllowed.length > 0
      ? configuredAllowed.filter((mime) => platformAllowed.has(mime))
      : PUBLIC_UPLOAD_ALLOWED_MIME;
  if (allowed.length === 0) {
    return { code: "no_supported_types" };
  }
  const fileMime = normalizeMime(file.type);
  if (!fileMime || !allowed.includes(fileMime)) {
    return { code: "type_not_allowed", accepted: allowed.join(", ") };
  }
  return null;
}

/** English compatibility formatter for non-localized callers and tests. */
export function validatePublicUpload(
  field: FormField,
  file: File,
): string | null {
  const issue = publicUploadValidationIssue(field, file);
  if (!issue) return null;
  if (issue.code === "empty") return "File is empty.";
  if (issue.code === "too_large") {
    return `File is too large. Maximum size is ${issue.max}.`;
  }
  if (issue.code === "no_supported_types") {
    return "This upload field has no supported file types configured.";
  }
  return `File type is not allowed. Accepted types: ${issue.accepted}.`;
}

function normalizeMime(value: string): string {
  const mime = value.toLowerCase().trim();
  const semi = mime.indexOf(";");
  return semi >= 0 ? mime.slice(0, semi).trim() : mime;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
