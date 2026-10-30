// SPDX-License-Identifier: MIT

import { readFileSync, statSync } from "node:fs";

export const DEFAULT_MAX_TEXT_FILE_BYTES = 512 * 1024;

export function readUtf8FileLimited(
  path: string,
  maxBytes = DEFAULT_MAX_TEXT_FILE_BYTES,
): string {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`File is too large (${size} bytes, max ${maxBytes}): ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`File is too large (${bytes} bytes, max ${maxBytes}): ${path}`);
  }
  return text;
}
