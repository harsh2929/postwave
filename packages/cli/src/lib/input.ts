// SPDX-License-Identifier: MIT

import { readFileSync, statSync } from "node:fs";

export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

export interface JsonObjectParseLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxKeys?: number;
  maxStringChars?: number;
}

export const DEFAULT_JSON_PARSE_LIMITS = {
  maxBytes: DEFAULT_MAX_INPUT_BYTES,
  maxDepth: 24,
  maxKeys: 2_000,
  maxStringChars: 128 * 1024,
} satisfies Required<JsonObjectParseLimits>;

export function readTextFileLimited(
  path: string,
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
): string {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`Input file is too large (${size} bytes, max ${maxBytes}).`);
  }
  const text = readFileSync(path, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Input file is too large (${bytes} bytes, max ${maxBytes}).`);
  }
  return text;
}

export function readStdinLimited(maxBytes = DEFAULT_MAX_INPUT_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let total = 0;
    let buf = "";
    let rejected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (rejected) return;
      total += Buffer.byteLength(chunk, "utf8");
      if (total > maxBytes) {
        rejected = true;
        reject(new Error(`stdin is too large (max ${maxBytes} bytes).`));
        return;
      }
      buf += chunk;
    });
    process.stdin.on("end", () => {
      if (!rejected) resolve(buf);
    });
    process.stdin.on("error", reject);
  });
}

export function parseJsonObject(
  text: string,
  label: string,
  limits: JsonObjectParseLimits = {},
): Record<string, unknown> {
  const resolved = { ...DEFAULT_JSON_PARSE_LIMITS, ...limits };
  if (Buffer.byteLength(text, "utf8") > resolved.maxBytes) {
    throw new Error(`${label} JSON is too large; limit is ${resolved.maxBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${label} JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} JSON must be an object.`);
  }
  validateJsonValue(parsed, label, resolved);
  return parsed as Record<string, unknown>;
}

function validateJsonValue(
  value: unknown,
  label: string,
  limits: Required<JsonObjectParseLimits>,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let keys = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    const { value: current, depth } = item;

    if (depth > limits.maxDepth) {
      throw new Error(`${label} JSON exceeds maximum depth of ${limits.maxDepth}.`);
    }
    if (typeof current === "string" && current.length > limits.maxStringChars) {
      throw new Error(
        `${label} JSON contains a string longer than ${limits.maxStringChars} characters.`,
      );
    }
    if (typeof current !== "object" || current === null) continue;

    if (Array.isArray(current)) {
      for (const entry of current) stack.push({ value: entry, depth: depth + 1 });
      continue;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    keys += entries.length;
    if (keys > limits.maxKeys) {
      throw new Error(`${label} JSON contains more than ${limits.maxKeys} object keys.`);
    }
    for (const [, entry] of entries) {
      stack.push({ value: entry, depth: depth + 1 });
    }
  }
}
