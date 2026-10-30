// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export interface TemplateMergePreview {
  rendered: string;
  error?: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const RESERVED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** The merge engine resolves dotted keys through nested objects. */
export function nestMergePreviewVars(vars: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null);
  for (const [path, value] of Object.entries(vars)) {
    const parts = path.split(".");
    if (parts.some((part) => !SAFE_SEGMENT.test(part) || RESERVED_SEGMENTS.has(part))) {
      throw new Error(`Sample variable ${path} has an unsupported key.`);
    }
    let current = root;
    for (const part of parts.slice(0, -1)) {
      const existing = current[part];
      if (existing === undefined) {
        current[part] = Object.create(null) as Record<string, unknown>;
      } else if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(`Sample variable ${path} conflicts with another field.`);
      }
      current = current[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (typeof current[last] === "object" && current[last] !== null) {
      throw new Error(`Sample variable ${path} conflicts with another field.`);
    }
    current[last] = value;
  }
  return root;
}

/**
 * Use the same conditional/loop/merge engine as campaign rendering. A local
 * regex replacement cannot truthfully preview {% if %}, defaults or filters.
 */
export async function renderTemplateWithSampleData(
  template: string,
  vars: Record<string, string>,
  signal?: AbortSignal,
): Promise<TemplateMergePreview> {
  if (!template.includes("{{") && !template.includes("{%")) {
    return { rendered: template };
  }
  const result = await api.post<TemplateMergePreview>(
    "/api/v1/merge/preview",
    { template, vars: nestMergePreviewVars(vars), html: true },
    { signal, requireOnline: true, maxAttempts: 1 },
  );
  if (!result || typeof result.rendered !== "string" ||
      (result.error !== undefined && typeof result.error !== "string")) {
    throw new Error("The template preview service returned an invalid response.");
  }
  return result;
}
