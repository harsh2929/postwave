import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSnippet,
  type CodeLang,
  type RequestPlan,
} from "../../components/playground/PlaygroundCodeGen";

const SYNTHETIC_REAL_SECRET = "pw_live_route44_must_never_be_copied";
const previousApiKey = process.env.POSTWAVE_API_KEY;

function workspacePlan(overrides: Partial<RequestPlan> = {}): RequestPlan {
  return {
    method: "post",
    url: "https://api.postwave.test/api/v1/tags",
    headers: { "Content-Type": "application/json" },
    body: '{"name":"release"}',
    bodyIsJSON: true,
    authMode: "workspace",
    snippetAllowed: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (previousApiKey === undefined) delete process.env.POSTWAVE_API_KEY;
  else process.env.POSTWAVE_API_KEY = previousApiKey;
});

describe("PlaygroundCodeGen", () => {
  it.each<[CodeLang, string]>([
    ["curl", "Authorization: Bearer $POSTWAVE_API_KEY"],
    ["js", "Authorization: `Bearer ${process.env.POSTWAVE_API_KEY}`"],
    ["python", "os.environ['POSTWAVE_API_KEY']"],
  ])(
    "uses a safe workspace auth placeholder in %s",
    (language, placeholder) => {
      process.env.POSTWAVE_API_KEY = SYNTHETIC_REAL_SECRET;

      const snippet = buildSnippet(workspacePlan(), language);

      expect(snippet).toContain(placeholder);
      expect(snippet).not.toContain(SYNTHETIC_REAL_SECRET);
      expect(snippet).not.toContain("pw_live_");
    },
  );

  it("fails closed when reviewed policy metadata is absent at runtime", () => {
    const incomplete = {
      method: "get",
      url: "https://api.postwave.test/api/v1/tags",
      headers: {},
      body: "",
      bodyIsJSON: false,
    } as unknown as RequestPlan;

    const snippet = buildSnippet(incomplete, "js");

    expect(snippet).toContain("Snippet unavailable:");
    expect(snippet).not.toContain("fetch(");
  });

  it("omits ambient browser credentials from bearer snippets", () => {
    const snippet = buildSnippet(workspacePlan(), "js");
    expect(snippet).toContain('credentials: "omit"');
    expect(snippet).toContain('redirect: "error"');
  });

  it("prevents Python requests from replaying a mutation across redirects", () => {
    expect(buildSnippet(workspacePlan(), "python")).toContain(
      "allow_redirects=False",
    );
  });

  it.each<[NonNullable<RequestPlan["authMode"]>, CodeLang, string]>([
    ["session", "curl", "browser-managed session authentication"],
    ["session", "js", "browser-managed session authentication"],
    ["session", "python", "browser-managed session authentication"],
    ["unsupported", "curl", "authentication scheme is not supported"],
    ["unsupported", "js", "authentication scheme is not supported"],
    ["unsupported", "python", "authentication scheme is not supported"],
  ])(
    "renders a non-executable %s-auth notice for %s",
    (authMode, language, reason) => {
      const snippet = buildSnippet(workspacePlan({ authMode }), language);

      expect(snippet).toContain("Snippet unavailable:");
      expect(snippet).toContain(reason);
      expect(snippet).toContain("authentication was not included");
      expect(snippet).toContain("No executable snippet was generated.");
      expect(snippet).not.toMatch(/curl |fetch\(|requests\.request/);
      expect(snippet).not.toContain("Authorization");
      expect(snippet.length).toBeLessThan(260);
    },
  );

  it.each(["curl", "js", "python"] as const)(
    "does not emit %s for a held bearer operation",
    (language) => {
      const snippet = buildSnippet(
        workspacePlan({
          snippetAllowed: false,
          snippetUnavailableReason: "Release hold: route44-review",
        }),
        language,
      );
      expect(snippet).toContain("reviewed runner policy");
      expect(snippet).toContain("Release hold: route44-review");
      expect(snippet).toContain("No executable snippet was generated");
      expect(snippet).not.toMatch(/curl |fetch\(|requests\.request/);
    },
  );

  it("emits valid raw-body paths and non-JSON response handling", () => {
    const rawBody = "plain=hello\nquote='safe'\\tail";
    const plan = workspacePlan({
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: rawBody,
      bodyIsJSON: false,
    });

    const curl = buildSnippet(plan, "curl");
    expect(curl).toContain("--data-binary $'");
    expect(curl).toContain("plain=hello\\n");
    expect(curl).toContain("quote=\\'safe\\'");

    const javascript = buildSnippet(plan, "js");
    expect(javascript).toContain(`body: ${JSON.stringify(rawBody)},`);
    expect(javascript).toContain(
      'contentType.includes("json") ? await res.json() : await res.text()',
    );

    const python = buildSnippet(plan, "python");
    expect(python).toContain(`payload = ${JSON.stringify(rawBody)}`);
    expect(python).toContain('data=payload.encode("utf-8")');
    expect(python).not.toContain("json=payload");
    expect(python).toContain(
      'res.json() if "json" in res.headers.get("content-type", "") else res.text',
    );
  });

  it("rejects deeply nested JSON before parsing or recursive formatting", () => {
    const parse = vi.spyOn(JSON, "parse");
    const body = `${"[".repeat(5_000)}0${"]".repeat(5_000)}`;

    const snippets = (["curl", "js", "python"] as const).map((language) =>
      buildSnippet(workspacePlan({ body }), language),
    );

    expect(parse).not.toHaveBeenCalled();
    expect(new Set(snippets)).toHaveLength(1);
    expect(snippets[0]).toContain("Snippet unavailable:");
    expect(snippets[0]).toContain("nesting preview limit");
    expect(snippets[0]).toContain("No executable snippet was generated.");
    expect(snippets[0]).not.toMatch(/curl |fetch\(|requests\.request/);
    expect(snippets[0]!.length).toBeLessThan(240);
  });

  it("rejects an oversized JSON preview without echoing its body", () => {
    const marker = "route44-large-json-marker";
    const body = JSON.stringify(`${marker}${"x".repeat(100_000)}`);

    const snippet = buildSnippet(workspacePlan({ body }), "js");

    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(256 * 1024);
    expect(snippet).toContain("UTF-8 byte preview limit");
    expect(snippet).toContain("No executable snippet was generated.");
    expect(snippet).not.toContain(marker);
    expect(snippet).not.toContain("fetch(");
  });

  it("rejects wide JSON before stringify or Python representation expansion", () => {
    const body = JSON.stringify(new Array(5_000).fill(0));

    for (const language of ["js", "python"] as const) {
      const snippet = buildSnippet(workspacePlan({ body }), language);
      expect(snippet).toContain("value preview limit");
      expect(snippet).toContain("No executable snippet was generated.");
      expect(snippet).not.toMatch(/JSON\.stringify\(|payload =/);
    }
  });

  it.each(['{"name":"first","name":"second"}', '{"value":9007199254740993}'])(
    "preserves exact raw JSON body bytes for %s",
    (body) => {
      const javascript = buildSnippet(workspacePlan({ body }), "js");
      expect(javascript).toContain(`body: ${JSON.stringify(body)},`);
      expect(javascript).not.toContain("body: JSON.stringify(");

      const python = buildSnippet(workspacePlan({ body }), "python");
      expect(python).toContain(`payload = ${JSON.stringify(body)}`);
      expect(python).toContain('data=payload.encode("utf-8")');
      expect(python).not.toContain("json=payload");
    },
  );
});
