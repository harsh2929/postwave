// SPDX-License-Identifier: AGPL-3.0-only
//
// Every skill page publishes a copy-pasteable example invocation, built from
// the tool's own input schema. Ninety-five required arguments rendered as
// `null`.
//
// The cause was upstream. The generator inferred field kinds by matching
// `z.string(` / `z.enum(` in the field expression, so anything declared
// through a module-local alias — `session_id: MigrationJobId`,
// `source: SourceEnum`, `confirm: ExplicitApproval` — fell through to
// "unknown", which exampleValue had no case for. "unknown" was the
// second-most-common kind in the artifact.
//
// `null` is the one value guaranteed to be wrong, and it does not look wrong:
// it reads as a real argument rather than a placeholder. An agent copying
// `{"tool":"migrate_delta_import","arguments":{"source":null,...}}` sends a
// call that cannot succeed.
//
// The generator now resolves one level of alias and understands z.literal, and
// exampleValue emits a named placeholder for anything still untyped.
import { describe, expect, it } from "vitest";

import { buildExampleInvocation, exampleValue } from "@/lib/docs/skill-example";
import { listSkills } from "@/lib/docs/loadSkills";

describe("skill example invocations", () => {
  const skills = listSkills();

  it("reads the catalog", () => {
    // Guard the guard: an empty artifact would satisfy every sweep below.
    expect(skills.length).toBeGreaterThan(100);
    expect(
      skills.reduce((n, s) => n + s.inputFields.length, 0),
    ).toBeGreaterThan(300);
  });

  it("never renders a required argument as null", () => {
    const nulls: string[] = [];
    for (const skill of skills) {
      for (const field of skill.inputFields) {
        if (field.optional) continue;
        if (exampleValue(field) === null) {
          nulls.push(`${skill.name}.${field.name} (${field.kind})`);
        }
      }
    }
    expect(nulls.slice(0, 10)).toEqual([]);
  });

  it("emits valid JSON for every skill", () => {
    const broken: string[] = [];
    for (const skill of skills) {
      const example = buildExampleInvocation(skill.name, skill.inputFields);
      try {
        const parsed = JSON.parse(example) as { tool: string };
        if (parsed.tool !== skill.name)
          broken.push(`${skill.name}: wrong tool`);
      } catch {
        broken.push(`${skill.name}: unparseable`);
      }
    }
    expect(broken.slice(0, 10)).toEqual([]);
  });

  it("resolves aliased schemas rather than giving up on them", () => {
    // The specific shapes that were unknown. Checked through the artifact so
    // this fails if the generator regresses, not just if exampleValue does.
    const byName = new Map(skills.map((s) => [s.name, s]));
    const field = (tool: string, name: string) =>
      byName.get(tool)?.inputFields.find((f) => f.name === name);

    expect(field("migrate_discover", "session_id")?.kind).toBe("string");
    expect(field("migrate_discover", "source")?.kind).toBe("enum");
    expect(
      field("migrate_discover", "source")?.enumValues?.length,
    ).toBeGreaterThan(2);
    // z.literal(true) — an approval gate with exactly one accepted value.
    expect(field("migrate_delta_import", "confirm")?.kind).toBe("literal");
    expect(exampleValue(field("migrate_delta_import", "confirm")!)).toBe(true);
  });

  it("marks anything still untyped as a placeholder, visibly", () => {
    // Residual unknowns are honest — they come from schemas imported across
    // modules. What matters is that they cannot be mistaken for a value.
    const untyped = skills
      .flatMap((s) => s.inputFields)
      .filter((f) => f.kind === "unknown");
    for (const field of untyped) {
      expect(exampleValue(field)).toBe(`<${field.name}>`);
    }
  });
});
