// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { translateVariables } from "../src/lib/variables.js";

const cases: Array<{
  from: "jinja" | "js" | "go-template";
  to: "jinja" | "js" | "go-template";
  in: string;
  out: string;
}> = [
  // jinja → js
  { from: "jinja", to: "js", in: "Hi {{first_name}}!", out: "Hi ${firstName}!" },
  {
    from: "jinja",
    to: "js",
    in: "{{first_name}} {{last_name}}",
    out: "${firstName} ${lastName}",
  },
  // jinja → go
  {
    from: "jinja",
    to: "go-template",
    in: "Hi {{first_name}}!",
    out: "Hi {{ .FirstName }}!",
  },
  // js → jinja
  { from: "js", to: "jinja", in: "Hi ${firstName}!", out: "Hi {{first_name}}!" },
  // js → go
  {
    from: "js",
    to: "go-template",
    in: "Hi ${firstName}!",
    out: "Hi {{ .FirstName }}!",
  },
  // go → jinja
  {
    from: "go-template",
    to: "jinja",
    in: "Hi {{ .FirstName }}!",
    out: "Hi {{first_name}}!",
  },
  // go → js
  {
    from: "go-template",
    to: "js",
    in: "Hi {{ .FirstName }} {{ .LastName }}!",
    out: "Hi ${firstName} ${lastName}!",
  },
  // identity short-circuit
  {
    from: "jinja",
    to: "jinja",
    in: "no change {{x}}",
    out: "no change {{x}}",
  },
];

describe("translateVariables: table", () => {
  for (const c of cases) {
    it(`${c.from} → ${c.to}: ${c.in}`, () => {
      expect(translateVariables(c.in, c.from, c.to)).toBe(c.out);
    });
  }
});

describe("translateVariables: edge cases", () => {
  it("leaves text without variables unchanged", () => {
    expect(translateVariables("hello world", "jinja", "js")).toBe("hello world");
  });

  it("preserves surrounding punctuation and whitespace", () => {
    expect(
      translateVariables("Dear {{ first_name }}, welcome.", "jinja", "js"),
    ).toBe("Dear ${firstName}, welcome.");
  });

  it("handles multiple occurrences of the same variable", () => {
    expect(
      translateVariables("{{name}} {{name}} {{name}}", "jinja", "go-template"),
    ).toBe("{{ .Name }} {{ .Name }} {{ .Name }}");
  });

  it("does not match Go-template variables when parsing as Jinja", () => {
    // A Go-template `{{ .First }}` should NOT be picked up as a Jinja var
    // (Jinja regex requires no leading dot).
    expect(
      translateVariables("Hi {{ .First }}", "jinja", "js"),
    ).toBe("Hi {{ .First }}");
  });
});
