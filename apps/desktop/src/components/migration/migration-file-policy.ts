import type { ImportPolicy } from "../../lib/file-transfer-types";

export const MAX_MIGRATION_UPLOAD_BYTES = 200 * 1024 * 1024;

export const MIGRATION_IMPORT_POLICY: ImportPolicy = {
  label: "migration CSV",
  privacy: "confidential",
  extensions: ["csv"],
  maxBytes: MAX_MIGRATION_UPLOAD_BYTES,
};

export const SUBSTACK_MIGRATION_IMPORT_POLICY: ImportPolicy = {
  label: "Substack export",
  privacy: "confidential",
  extensions: ["zip", "csv"],
  mimeTypes: [
    "application/zip",
    "application/x-zip-compressed",
    "text/csv",
    "application/csv",
  ],
  maxBytes: MAX_MIGRATION_UPLOAD_BYTES,
};
