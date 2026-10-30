/**
 * Pure helpers for the Data Platform → CDP transforms section (#37).
 *
 * Render-free so it unit-tests under the node vitest environment.
 * Wire (WIRING-WRAPPERS.md #37): POST /cdp/transforms/preview is a
 * pure dry-run — `{properties, ops}` in, `{properties, results[],
 * success, failed}` out; GET /ops → `{ops: string[]}`.
 */

import type { CDPTransformOp, CDPTransformResult } from "../../lib/api-client";

export const SAMPLE_PROPERTIES = `{
  "email": "  Ada.Lovelace@Example.COM ",
  "first_name": "ada",
  "country": "gb",
  "ltv_cents": "12900"
}`;

export const SAMPLE_OPS = `[
  { "type": "trim", "field": "email" },
  { "type": "lowercase", "field": "email" }
]`;

export interface ParsedPreviewInput {
  properties: Record<string, unknown> | null;
  ops: CDPTransformOp[] | null;
  propertiesError: string | null;
  opsError: string | null;
}

export function parsePreviewInput(
  propertiesText: string,
  opsText: string,
): ParsedPreviewInput {
  const out: ParsedPreviewInput = {
    properties: null,
    ops: null,
    propertiesError: null,
    opsError: null,
  };

  const pt = propertiesText.trim();
  if (!pt) {
    out.propertiesError = "Provide an input properties object";
  } else {
    try {
      const parsed: unknown = JSON.parse(pt);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        out.propertiesError = "Properties must be a JSON object";
      } else {
        out.properties = parsed as Record<string, unknown>;
      }
    } catch (e) {
      out.propertiesError = `Properties JSON: ${e instanceof Error ? e.message : "parse error"}`;
    }
  }

  const ot = opsText.trim();
  if (!ot) {
    out.opsError = "Provide an ops array";
  } else {
    try {
      const parsed: unknown = JSON.parse(ot);
      if (!Array.isArray(parsed)) {
        out.opsError = "Ops must be a JSON array";
      } else if (parsed.length === 0) {
        out.opsError = "Add at least one op";
      } else {
        const ops: CDPTransformOp[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const p = parsed[i] as Record<string, unknown> | null;
          if (!p || typeof p !== "object" || Array.isArray(p)) {
            out.opsError = `Op ${i + 1} is not an object`;
            break;
          }
          if (typeof p.type !== "string" || !p.type.trim()) {
            out.opsError = `Op ${i + 1} is missing "type"`;
            break;
          }
          if (typeof p.field !== "string" || !p.field.trim()) {
            out.opsError = `Op ${i + 1} is missing "field"`;
            break;
          }
          ops.push({
            type: p.type,
            field: p.field,
            ...(p.args && typeof p.args === "object" && !Array.isArray(p.args)
              ? { args: p.args as Record<string, unknown> }
              : {}),
          });
        }
        if (!out.opsError) out.ops = ops;
      }
    } catch (e) {
      out.opsError = `Ops JSON: ${e instanceof Error ? e.message : "parse error"}`;
    }
  }

  return out;
}

export interface ResultRow {
  label: string;
  changed: boolean;
  oldValue: string;
  newValue: string;
  error: string | null;
}

function fmtValue(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function resultRows(results: CDPTransformResult[]): ResultRow[] {
  return results.map((r) => ({
    label: `${r.op.type}(${r.op.field})`,
    changed: r.changed,
    oldValue: fmtValue(r.old_value),
    newValue: fmtValue(r.new_value),
    error: r.error ?? null,
  }));
}

export function outcomeSummary(o: { success: number; failed: number }): string {
  return `${o.success} op${o.success === 1 ? "" : "s"} succeeded · ${o.failed} failed`;
}
