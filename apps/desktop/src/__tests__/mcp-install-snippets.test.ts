// Tests for the MCP install-snippet renderer. Pins the {{API_KEY}}
// substitution semantics so the dashboard's Setup tab never ships
// stale-looking snippets (e.g. leftover placeholder when a key IS
// supplied).

import { describe, expect, it } from "vitest";

import {
  HOSTED_MCP_API_BASE,
  MCP_CLIENTS,
  renderSnippet,
} from "../lib/mcp-install-snippets";

describe("renderSnippet", () => {
  it("substitutes a single API key occurrence", () => {
    const out = renderSnippet(
      "claude mcp add -e POSTWAVE_API_KEY={{API_KEY}}",
      "pw_abc123",
    );
    expect(out).toBe("claude mcp add -e POSTWAVE_API_KEY=pw_abc123");
    expect(out).not.toContain("{{API_KEY}}");
  });

  it("substitutes every occurrence (not just first)", () => {
    const out = renderSnippet(
      "FIRST={{API_KEY}} SECOND={{API_KEY}}",
      "pw_xyz",
    );
    expect(out).toBe("FIRST=pw_xyz SECOND=pw_xyz");
  });

  it("leaves placeholder visible when API key is empty", () => {
    const out = renderSnippet("KEY={{API_KEY}}", "");
    expect(out).toContain("{{API_KEY}}");
  });

  it("doesn't interpret regex backref characters in the key", () => {
    // A key containing $1 or $& would be a disaster with String.replace.
    // We use split/join precisely to avoid that.
    const out = renderSnippet("K={{API_KEY}}", "pw_$1$&");
    expect(out).toBe("K=pw_$1$&");
  });

  it("preserves the rest of the template verbatim", () => {
    const template = `{
  "key": "{{API_KEY}}",
  "other": "value"
}`;
    const out = renderSnippet(template, "pw_x");
    expect(out).toContain('"other": "value"');
    expect(out).toContain('"key": "pw_x"');
  });

  // D14-settings-misc#7: base-URL injection for self-hosted / localhost.
  it("injects POSTWAVE_BASE_URL into a JSON env block for a self-hosted base", () => {
    const out = renderSnippet(
      `"env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }`,
      "pw_x",
      "https://mail.acme.internal",
    );
    expect(out).toContain('"POSTWAVE_BASE_URL": "https://mail.acme.internal"');
    expect(out).not.toContain("{{BASE_URL_JSON}}");
  });

  it("injects a POSTWAVE_BASE_URL -e flag for the bash one-liner", () => {
    const out = renderSnippet(
      `claude mcp add -e POSTWAVE_API_KEY={{API_KEY}}{{BASE_URL_BASH_FLAG}} -- npx`,
      "pw_x",
      "http://localhost:8080",
    );
    expect(out).toContain("-e POSTWAVE_BASE_URL=http://localhost:8080");
  });

  it("omits POSTWAVE_BASE_URL when the base equals the hosted default", () => {
    const out = renderSnippet(
      `"env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }`,
      "pw_x",
      HOSTED_MCP_API_BASE,
    );
    expect(out).not.toContain("POSTWAVE_BASE_URL");
    expect(out).not.toContain("{{BASE_URL_JSON}}");
  });

  it("treats a trailing slash on the hosted default as equal (still omitted)", () => {
    const out = renderSnippet(
      `x{{BASE_URL_BASH_FLAG}}`,
      "pw_x",
      `${HOSTED_MCP_API_BASE}/`,
    );
    expect(out).not.toContain("POSTWAVE_BASE_URL");
  });

  it("omits POSTWAVE_BASE_URL (and leaves no placeholder) when no base is passed", () => {
    const out = renderSnippet(
      `"env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }`,
      "pw_x",
    );
    expect(out).not.toContain("POSTWAVE_BASE_URL");
    expect(out).not.toContain("{{BASE_URL_JSON}}");
  });
});

describe("MCP_CLIENTS catalogue", () => {
  it("ships at least five clients", () => {
    expect(MCP_CLIENTS.length).toBeGreaterThanOrEqual(5);
  });

  it("includes the expected core clients", () => {
    const names = MCP_CLIENTS.map((c) => c.client);
    expect(names).toContain("Claude Code");
    expect(names).toContain("Cursor");
    expect(names).toContain("Claude Desktop");
  });

  it("every template references {{API_KEY}} exactly once or more", () => {
    for (const c of MCP_CLIENTS) {
      expect(c.template, `${c.client} must reference {{API_KEY}}`).toContain(
        "{{API_KEY}}",
      );
    }
  });

  it("every entry has a non-empty hint", () => {
    for (const c of MCP_CLIENTS) {
      expect(c.hint.trim(), `${c.client} hint is empty`).not.toBe("");
    }
  });

  it("clients have unique display names", () => {
    const names = MCP_CLIENTS.map((c) => c.client);
    const set = new Set(names);
    expect(set.size).toBe(names.length);
  });

  it("language values are constrained to bash | json", () => {
    for (const c of MCP_CLIENTS) {
      expect(["bash", "json"]).toContain(c.language);
    }
  });

  // D14-settings-misc#7: no rendered snippet may ever leak a raw
  // {{BASE_URL_*}} placeholder, whether or not a base URL is injected.
  it("never leaves a raw base-URL placeholder after render (self-hosted base)", () => {
    for (const c of MCP_CLIENTS) {
      const out = renderSnippet(c.template, "pw_key", "https://self.hosted");
      expect(out, `${c.client} leaked a base-URL placeholder`).not.toMatch(
        /\{\{BASE_URL/,
      );
    }
  });

  it("never leaves a raw base-URL placeholder after render (hosted default)", () => {
    for (const c of MCP_CLIENTS) {
      const out = renderSnippet(c.template, "pw_key", HOSTED_MCP_API_BASE);
      expect(out, `${c.client} leaked a base-URL placeholder`).not.toMatch(
        /\{\{BASE_URL/,
      );
    }
  });
});
