// SPDX-License-Identifier: AGPL-3.0-only

export type EditorMode = "blocks" | "writer" | "clients";

export const EDITOR_MODE_STORAGE_KEY = "postwave:editor-mode";
const MAX_STORED_EDITOR_MODES_BYTES = 64 * 1024;
const MAX_STORED_EDITOR_MODE_ENTRIES = 500;
const MAX_DOCUMENT_ID_CHARS = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function isEditorMode(value: unknown): value is EditorMode {
  return value === "blocks" || value === "writer" || value === "clients";
}

export function parseStoredEditorModes(raw: string | null): Record<string, EditorMode> {
  if (!raw) return {};
  if (new TextEncoder().encode(raw).byteLength > MAX_STORED_EDITOR_MODES_BYTES) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, EditorMode> = {};
    for (const [documentId, mode] of Object.entries(parsed)) {
      if (Object.keys(out).length >= MAX_STORED_EDITOR_MODE_ENTRIES) break;
      if (
        documentId &&
        documentId.length <= MAX_DOCUMENT_ID_CHARS &&
        documentId.trim() === documentId &&
        !CONTROL_RE.test(documentId) &&
        isEditorMode(mode)
      ) {
        out[documentId] = mode;
      }
    }
    return out;
  } catch {
    return {};
  }
}
