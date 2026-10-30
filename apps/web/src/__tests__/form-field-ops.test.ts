import { describe, expect, it } from "vitest";

import { cloneField, duplicateFieldAt, insertFieldAt } from "@/lib/form-field-ops";
import { FORM_TEMPLATES, getFormTemplate } from "@/lib/form-templates";
import type { FormField } from "@/lib/forms-types";

const radio: FormField = {
  id: "r1",
  kind: "radio",
  label: "Pick one",
  required: true,
  customKey: "pick",
  options: [{ label: "A" }, { label: "B" }],
};
const submit: FormField = { id: "s", kind: "submit", label: "Go", required: false };

describe("cloneField", () => {
  it("assigns a new id and deep-copies options", () => {
    const clone = cloneField(radio, "r2");
    expect(clone.id).toBe("r2");
    expect(clone.options).toEqual(radio.options);
    expect(clone.options).not.toBe(radio.options);
    clone.options![0].label = "changed";
    expect(radio.options![0].label).toBe("A");
  });
});

describe("duplicateFieldAt", () => {
  it("inserts the clone immediately after the source", () => {
    const out = duplicateFieldAt([radio, submit], "r1", () => "r2");
    expect(out.map((f) => f.id)).toEqual(["r1", "r2", "s"]);
    expect(out[1].kind).toBe("radio");
  });
  it("is a no-op copy when the source is missing", () => {
    const out = duplicateFieldAt([radio], "nope", () => "x");
    expect(out.map((f) => f.id)).toEqual(["r1"]);
  });
});

describe("insertFieldAt", () => {
  const newField: FormField = { id: "n", kind: "text", label: "New", required: false };
  it("inserts before Submit by default", () => {
    const out = insertFieldAt([radio, submit], newField);
    expect(out.map((f) => f.id)).toEqual(["r1", "n", "s"]);
  });
  it("appends when there is no Submit", () => {
    const out = insertFieldAt([radio], newField);
    expect(out.map((f) => f.id)).toEqual(["r1", "n"]);
  });
  it("inserts at an explicit clamped index", () => {
    expect(insertFieldAt([radio, submit], newField, 0).map((f) => f.id)).toEqual([
      "n",
      "r1",
      "s",
    ]);
    expect(insertFieldAt([radio, submit], newField, 99).map((f) => f.id)).toEqual([
      "r1",
      "s",
      "n",
    ]);
  });
});

describe("FORM_TEMPLATES", () => {
  it("every template has a required email field and a submit button", () => {
    for (const t of FORM_TEMPLATES) {
      const kinds = t.structure.fields.map((f) => f.kind);
      expect(kinds).toContain("email");
      expect(kinds).toContain("submit");
      const email = t.structure.fields.find((f) => f.kind === "email");
      expect(email?.required).toBe(true);
    }
  });
  it("field ids are unique within each template", () => {
    for (const t of FORM_TEMPLATES) {
      const ids = t.structure.fields.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it("getFormTemplate resolves by id", () => {
    expect(getFormTemplate("nps")?.name).toBe("NPS / Survey");
    expect(getFormTemplate("missing")).toBeUndefined();
  });
});
