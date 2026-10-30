// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type FormEmbedSnippetResponse } from "../../lib/api-client";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("forms embed API contract", () => {
  it("encodes the form id and returns the typed server-authored location", async () => {
    const payload: FormEmbedSnippetResponse = {
      flavor: "react",
      snippet: "export function PostwaveForm() { return null; }",
      language: "tsx",
      instructions: "Drop this component into a React page.",
      public_host: "https://forms.example.test",
      public_url: "https://forms.example.test/forms/launch",
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getFormEmbed("form/with slash", "react");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(payload);
    const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(requestUrl).toContain(
      "/api/v1/forms/form%2Fwith%20slash/embed/react",
    );
  });

  it("threads a caller abort signal through the canonical embed read", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();
    abortController.abort();

    const result = await api.getFormEmbed("form-1", "iframe", {
      signal: abortController.signal,
    });

    expect(result.error).toMatchObject({ code: "aborted", kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
