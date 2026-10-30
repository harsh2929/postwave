// SPDX-License-Identifier: AGPL-3.0-only
//
// Example-invocation values for the MCP skill pages.
//
// Lives here rather than in the route: a Next page module may only export a
// fixed set of names (default, metadata, generateStaticParams, …), so exporting
// these from page.tsx for testing fails the generated route type-check — which
// vitest does not see, because it does not typecheck. Pure logic belongs out of
// the route file anyway.
import type { SkillField } from "@/lib/docs/loadSkills";

export function exampleValue(field: SkillField): unknown {
  if (field.kind === "string") {
    if (field.enumValues?.length) return field.enumValues[0];
    if (field.name.endsWith("_id") || field.name === "id") return "abc123";
    if (field.name.includes("url")) return "https://example.com";
    if (field.name.includes("email")) return "founder@acme.com";
    return "string";
  }
  if (field.kind === "number") return 0;
  if (field.kind === "boolean") return false;
  if (
    (field.kind === "enum" || field.kind === "literal") &&
    field.enumValues?.length
  ) {
    const only = field.enumValues[0]!;
    // z.literal(true) must render as the boolean, not the string "true".
    if (field.kind === "literal") {
      if (only === "true") return true;
      if (only === "false") return false;
      if (/^-?\d+(\.\d+)?$/.test(only)) return Number(only);
    }
    return only;
  }
  if (field.kind === "array") return [];
  if (field.kind === "object") return {};
  // Anything the schema parser could not type. `null` was the previous answer
  // and it is the one value guaranteed to be wrong — it looks like a real
  // argument. A named placeholder says out loud that the reader must supply it.
  return `<${field.name}>`;
}

export function buildExampleInvocation(
  name: string,
  fields: SkillField[],
): string {
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.optional) continue;
    args[f.name] = exampleValue(f);
  }
  return JSON.stringify({ tool: name, arguments: args }, null, 2);
}
