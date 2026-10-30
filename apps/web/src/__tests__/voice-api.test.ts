import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addSource,
  archiveSequence,
  createSequence,
  generateLandingCopy,
  generateSubjectSuggestions,
  generateVoiceSample,
  getSequence,
  ingestSource,
  listSources,
  regenerateEmail,
  updateSequence,
} from "@/lib/voice-api";
import type { Sequence } from "@/lib/voice-types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice-api subject suggestions", () => {
  it("forwards cancellation to the generation request", async () => {
    const controller = new AbortController();
    const captured: { signal: AbortSignal | null } = { signal: null };
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        captured.signal = init?.signal ?? null;
        return response;
      }),
    );

    const suggestions = generateSubjectSuggestions("Draft subject", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(captured.signal).not.toBeNull());
    expect(captured.signal?.aborted).toBe(false);
    controller.abort();
    expect(captured.signal?.aborted).toBe(true);
    resolveResponse(Response.json({ text: "1. First idea\n2. Second idea" }));
    await expect(suggestions).resolves.toEqual(["First idea", "Second idea"]);
  });

  // With no voice service deployed, every subject keystroke sent POST
  // /api/v1/voice/generate three times (the default mutation transport minted
  // an Idempotency-Key, which made a 5xx retryable). Generation persists
  // nothing: it is asked once, and the failure is the answer.
  it.each([
    [
      "subject suggestions",
      () => generateSubjectSuggestions("Our spring launch is here"),
    ],
    ["a voice sample", () => generateVoiceSample("our spring launch")],
    ["landing copy", () => generateLandingCopy("a spring launch")],
  ])(
    "asks for %s once, with no mutation identity, when the service fails",
    async (_name, generate) => {
      const requests: Headers[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          requests.push(new Headers(init?.headers));
          return new Response(
            JSON.stringify({
              error: {
                code: "internal_error",
                message: "an internal error occurred",
              },
            }),
            { status: 502, headers: { "content-type": "application/json" } },
          );
        }),
      );

      await expect(generate()).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.has("Idempotency-Key")).toBe(false);
    },
  );
});

describe("voice-api sequence step graph support", () => {
  it("round-trips exact delays and fidelity diagnostics", async () => {
    let patchBody: Record<string, unknown> | null = null;
    let patchIfMatch: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "PATCH") {
          patchBody = JSON.parse(String(init?.body));
          patchIfMatch = new Headers(init?.headers).get("If-Match");
        }
        const input = patchBody ?? {};
        return new Response(
          JSON.stringify({
            id: "seq_exact",
            version: method === "PATCH" ? 5 : 4,
            name: "Exact",
            status: "draft",
            emails:
              method === "PATCH"
                ? input.emails
                : [
                    {
                      position: 1,
                      delay_seconds: 1800,
                      subject: "Half hour",
                      body: "Body",
                      voice_fidelity_score: 82.5,
                      fidelity_breakdown: {
                        embedding_similarity: 0.91,
                        stylistic_distance: 0.8,
                        vocabulary_overlap: 0.7,
                        structural_match: 0.6,
                        combined: 82.5,
                      },
                      regeneration_count: 3,
                    },
                  ],
            created_at: "2026-05-19T00:00:00Z",
            updated_at: "2026-05-19T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const loaded = await getSequence("seq_exact");
    expect(loaded.emails[0]).toMatchObject({
      delayHours: 0.5,
      fidelity: 82.5,
      regenerationCount: 3,
      fidelityBreakdownPresent: true,
      fidelityBreakdown: {
        embedding: 91,
        stylistic: 80,
        vocab: 70,
        structural: 60,
      },
    });
    await updateSequence(loaded);
    expect(patchIfMatch).toBe('"4"');
    expect(patchBody).not.toHaveProperty("status");
    expect(patchBody).toMatchObject({
      emails: [
        {
          delay_seconds: 1800,
          regeneration_count: 3,
          fidelity_breakdown: {
            embedding_similarity: 0.91,
            stylistic_distance: 0.8,
            vocabulary_overlap: 0.7,
            structural_match: 0.6,
          },
        },
      ],
    });
  });

  it("keeps never-ingested sources pending and does not fabricate fidelity components", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/v1/voice/sources")) {
          return Response.json([
            {
              id: "source_new",
              type: "newsletter_archive",
              params: { extra: { label: "Campaign archive" } },
              last_item_count: 0,
              last_ingested_at: "0001-01-01T00:00:00Z",
            },
          ]);
        }
        return Response.json({
          id: "seq_no_breakdown",
          name: "Legacy sequence",
          status: "draft",
          emails: [
            {
              position: 1,
              subject: "Legacy",
              body: "Body",
              voice_fidelity_score: 77,
            },
          ],
        });
      }),
    );

    await expect(listSources()).resolves.toEqual([
      expect.objectContaining({
        id: "source_new",
        lastIngestedAt: null,
        status: "pending",
      }),
    ]);
    const sequence = await getSequence("seq_no_breakdown");
    expect(sequence.emails[0]).toMatchObject({
      fidelity: 77,
      fidelityBreakdownPresent: false,
      fidelityBreakdown: {
        embedding: 0,
        stylistic: 0,
        vocab: 0,
        structural: 0,
      },
    });
  });

  it("fails closed before PATCH when a legacy response has no version", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          id: "seq_legacy",
          name: "Legacy",
          status: "draft",
          emails: [],
        });
      }),
    );

    const legacy = await getSequence("seq_legacy");
    await expect(updateSequence(legacy)).rejects.toThrow(
      /fresh sequence version/i,
    );
    expect(methods).toEqual(["GET"]);
  });

  it("does not promote a missing stored status into an editable draft", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          id: "seq_missing_status",
          version: 3,
          name: "Missing status",
          emails: [],
        });
      }),
    );

    const sequence = await getSequence("seq_missing_status");
    expect(sequence.status).toBe("unknown");
    await expect(updateSequence(sequence)).rejects.toThrow(
      /only a confirmed draft/i,
    );
    expect(methods).toEqual(["GET"]);
  });

  it("rejects a nominal success that does not confirm the exact next version", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          id: "seq_uncertain",
          version: 7,
          name: "Uncertain",
          status: "draft",
          emails: [],
        });
      }),
    );

    const sequence = await getSequence("seq_uncertain");
    await expect(updateSequence(sequence)).rejects.toThrow(
      /did not confirm the next sequence version/i,
    );
    expect(methods).toEqual(["GET", "PATCH"]);
  });

  it("keeps legacy operational-labelled rows read-only before PATCH", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sequence: Sequence = {
      id: "seq_legacy_active",
      version: 9,
      name: "Legacy active row",
      templateId: "",
      templateName: "Template",
      status: "active",
      fidelityAvg: 0,
      emails: [],
      createdAt: "2026-05-19T00:00:00Z",
      updatedAt: "2026-05-19T00:00:00Z",
    };

    await expect(updateSequence(sequence)).rejects.toThrow(
      /only a confirmed draft/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("archives with a status-only patch", async () => {
    const calls: Array<{
      method: string;
      body?: unknown;
      ifMatch: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          ifMatch: new Headers(init?.headers).get("If-Match"),
        });
        return new Response(
          JSON.stringify({
            id: "seq_1",
            version: method === "PATCH" ? 8 : 7,
            name: "Archive",
            status: method === "PATCH" ? "archived" : "draft",
            emails: [],
            created_at: "2026-05-19T00:00:00Z",
            updated_at: "2026-05-19T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await archiveSequence("seq_1");
    expect(calls).toEqual([
      { method: "GET", ifMatch: null },
      {
        method: "PATCH",
        body: { status: "archived" },
        ifMatch: '"7"',
      },
    ]);
  });

  it("polls source ingest to completion before refreshing the source", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if ((init?.method ?? "GET") === "POST")
          return new Response(
            JSON.stringify({ job_id: "job_1", status: "pending" }),
            { status: 202, headers: { "content-type": "application/json" } },
          );
        if (url.endsWith("/ingest/job_1"))
          return new Response(
            JSON.stringify({ status: "succeeded", item_count: 4 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return new Response(
          JSON.stringify([
            {
              id: "source_1",
              type: "paste_in",
              params: { extra: { label: "Notes" } },
              last_item_count: 4,
              last_ingested_at: "2026-07-10T00:00:00Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const source = await ingestSource("source_1");
    expect(source).toMatchObject({
      id: "source_1",
      itemCount: 4,
      status: "ready",
    });
    expect(calls).toEqual([
      "POST http://localhost:8080/api/v1/voice/sources/source_1/ingest",
      "GET http://localhost:8080/api/v1/voice/sources/source_1/ingest/job_1",
      "GET http://localhost:8080/api/v1/voice/sources",
    ]);
  });
  it("creates manual sequence drafts with v0.3 steps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          name: "Manual activation flow",
          status: "draft",
          steps: [
            {
              type: "email",
              position: 1,
              email: { subject: "Welcome", body: "Hello", delay_seconds: 0 },
            },
            {
              type: "tag_add",
              position: 2,
              tag: { tag: "activated" },
            },
          ],
        });
        return new Response(
          JSON.stringify({
            id: "seq_manual",
            version: 12,
            name: body.name,
            status: body.status,
            steps: body.steps,
            created_at: "2026-05-19T00:00:00Z",
            updated_at: "2026-05-19T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const sequence = await createSequence({
      name: "Manual activation flow",
      status: "draft",
      steps: [
        {
          type: "email",
          position: 1,
          email: { subject: "Welcome", body: "Hello", delay_seconds: 0 },
        },
        {
          type: "tag_add",
          position: 2,
          tag: { tag: "activated" },
        },
      ],
    });

    expect(sequence.id).toBe("seq_manual");
    expect(sequence.emails).toHaveLength(1);
    expect(sequence.emails[0]?.subject).toBe("Welcome");
    expect(sequence.steps?.[1]).toMatchObject({
      type: "tag_add",
      tag: { tag: "activated" },
    });
  });

  it("rejects a runtime-looking create request before POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(createSequence({ status: "active" } as never)).rejects.toThrow(
      /only be created as drafts/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("updates step-backed sequences without dropping non-email nodes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("If-Match")).toBe('"11"');
        const body = JSON.parse(String(init?.body));
        expect(body.emails).toBeUndefined();
        expect(body.status).toBeUndefined();
        expect(body.steps).toMatchObject([
          {
            type: "email",
            position: 1,
            email: {
              subject: "Edited subject",
              body: "Edited body",
              delay_seconds: 7200,
            },
          },
          {
            type: "tag_remove",
            position: 2,
            tag: { tag: "trial" },
          },
        ]);
        return new Response(
          JSON.stringify({
            id: "seq_manual",
            version: 12,
            name: body.name,
            status: "draft",
            steps: body.steps,
            created_at: "2026-05-19T00:00:00Z",
            updated_at: "2026-05-19T01:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const sequence: Sequence = {
      id: "seq_manual",
      version: 11,
      name: "Manual activation flow",
      templateId: "",
      templateName: "Manual sequence",
      status: "draft",
      fidelityAvg: 0,
      emails: [
        {
          id: "seq_manual-1",
          position: 1,
          subject: "Edited subject",
          bodyMarkdown: "Edited body",
          bodyHtml: "",
          bodyMjml: null,
          delayHours: 2,
          fidelity: 0,
          fidelityBreakdown: {
            embedding: 0,
            stylistic: 0,
            vocab: 0,
            structural: 0,
          },
        },
      ],
      steps: [
        {
          type: "email",
          position: 1,
          email: { subject: "Old subject", body: "Old body" },
        },
        {
          type: "tag_remove",
          position: 2,
          tag: { tag: "trial" },
        },
      ],
      createdAt: "2026-05-19T00:00:00Z",
      updatedAt: "2026-05-19T00:00:00Z",
    };

    const updated = await updateSequence(sequence);

    expect(updated.emails[0]?.subject).toBe("Edited subject");
    expect(updated.steps?.[1]).toMatchObject({
      type: "tag_remove",
      tag: { tag: "trial" },
    });
  });

  it("returns a direct regeneration preview without PATCHing or polling", async () => {
    const calls: Array<{
      url: string;
      method: string;
      body: Record<string, unknown>;
      idempotencyKey: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        });
        return Response.json({
          position: 2,
          delay_seconds: 86400,
          subject: "A sharper subject",
          body: "Candidate body",
          body_html: "<p>Candidate body</p>",
          voice_fidelity_score: 91,
          fidelity_breakdown: {
            embedding_similarity: 0.95,
            stylistic_distance: 0.9,
            vocabulary_overlap: 0.85,
            structural_match: 0.8,
            combined: 91,
          },
          regeneration_count: 4,
        });
      }),
    );

    const candidate = await regenerateEmail(
      "seq/a",
      2,
      {
        hint: "shorter",
        style: {
          humor: 0.2,
          directness: 0.5,
          formality: -0.1,
          lengthBias: -0.5,
        },
      },
      { idempotencyKey: "018f1234-5678-7abc-8def-0123456789ab" },
    );

    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/voice/sequences/seq%2Fa/regenerate/2",
        method: "POST",
        idempotencyKey: "018f1234-5678-7abc-8def-0123456789ab",
        body: {
          user_hint: "shorter",
          style_controls: {
            humor: 0.2,
            directness: 0.5,
            formality_shift: -0.1,
            length: "shorter",
          },
        },
      },
    ]);
    expect(candidate).toMatchObject({
      id: "seq/a-2",
      position: 2,
      subject: "A sharper subject",
      bodyMarkdown: "Candidate body",
      delayHours: 24,
      fidelity: 91,
      regenerationCount: 4,
    });

    await expect(
      regenerateEmail("seq/a", 0, {}, { idempotencyKey: "valid-key" }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      regenerateEmail("seq/a", 2, {}, { idempotencyKey: " leading-space" }),
    ).rejects.toThrow(/stable 1–255 character idempotency key/i);
    expect(calls).toHaveLength(1);
  });

  it("rejects asynchronous or wrong-position regeneration responses", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { job_id: "job_unsafe", status: "pending" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          position: 3,
          subject: "Wrong target",
          body: "Candidate body",
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      regenerateEmail("seq_1", 2, {}, { idempotencyKey: "attempt-one" }),
    ).rejects.toThrow(/direct, unpersisted review candidate/i);
    await expect(
      regenerateEmail("seq_1", 2, {}, { idempotencyKey: "attempt-two" }),
    ).rejects.toThrow(/different email position/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("polls an async generation job and returns the completed sequence", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const updates: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (method === "POST") {
          return new Response(
            JSON.stringify({ job_id: "job_1", status: "pending" }),
            {
              status: 202,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/jobs/job_1")) {
          return new Response(
            JSON.stringify({
              id: "job_1",
              sequence_id: "seq_generated",
              status: "succeeded",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "seq_generated",
            name: "Generated sequence",
            status: "draft",
            emails: [],
            created_at: "2026-05-19T00:00:00Z",
            updated_at: "2026-05-19T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const sequence = await createSequence(
      { templateId: "welcome" },
      { onStatus: (status) => updates.push(status.state) },
    );

    expect(sequence.id).toBe("seq_generated");
    expect(updates).toEqual(["ready"]);
    expect(calls).toEqual([
      { url: "http://localhost:8080/api/v1/voice/sequences", method: "POST" },
      {
        url: "http://localhost:8080/api/v1/voice/sequences/jobs/job_1",
        method: "GET",
      },
      {
        url: "http://localhost:8080/api/v1/voice/sequences/seq_generated",
        method: "GET",
      },
    ]);
  });

  it("surfaces an async generation failure instead of navigating to an undefined sequence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ job_id: "job_failed", status: "pending" }),
            {
              status: 202,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            id: "job_failed",
            status: "failed",
            error_message: "generation provider unavailable",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await expect(createSequence({ templateId: "welcome" })).rejects.toThrow(
      "generation provider unavailable",
    );
  });
});

describe("voice-api source registration", () => {
  it("registers the tenant campaign archive without an ignored external URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          type: "newsletter_archive",
          params: {
            extra: { label: "Moosewave campaign archive" },
          },
        });
        return Response.json({ source_id: "src-archive" }, { status: 201 });
      }),
    );

    await expect(
      addSource({
        type: "newsletter_archive",
        label: "Moosewave campaign archive",
      }),
    ).resolves.toMatchObject({
      id: "src-archive",
      label: "Moosewave campaign archive",
      status: "pending",
    });
  });

  it("registers Twitter handles in API mode instead of archive-path mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          type: "twitter",
          params: {
            extra: {
              mode: "api",
              username: "postwave",
            },
          },
        });
        return new Response(JSON.stringify({ source_id: "src-twitter" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const source = await addSource({ type: "twitter", handle: "@postwave" });

    expect(source).toMatchObject({
      id: "src-twitter",
      type: "twitter",
      label: "postwave",
      status: "pending",
    });
  });

  it("registers podcast transcripts with title and url metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          type: "podcast_transcript",
          params: {
            rawText: "Intro\n\nMain point",
            extra: {
              title: "Founder AMA",
              url: "https://example.com/ama",
            },
          },
        });
        return new Response(JSON.stringify({ source_id: "src-podcast" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const source = await addSource({
      type: "podcast_transcript",
      text: "Intro\n\nMain point",
      title: "Founder AMA",
      url: "https://example.com/ama",
    });

    expect(source).toMatchObject({
      id: "src-podcast",
      type: "podcast_transcript",
      label: "Founder AMA",
      status: "pending",
    });
  });

  it("registers LinkedIn exports as raw CSV content", async () => {
    const csv =
      "Date,ShareCommentary,URL\n2026-05-01,Hello,https://linkedin.test/post/1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          type: "linkedin_export",
          params: {
            rawText: csv,
            extra: {
              label: "linkedin-posts.csv",
            },
          },
        });
        return new Response(JSON.stringify({ source_id: "src-linkedin" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const source = await addSource({
      type: "linkedin_export",
      csvText: csv,
      label: "linkedin-posts.csv",
    });

    expect(source).toMatchObject({
      id: "src-linkedin",
      type: "linkedin_export",
      label: "linkedin-posts.csv",
      status: "pending",
    });
  });
});
