import { describe, expect, it, vi } from "vitest";

import { PostwaveClient, RequestAbortedError } from "../src/index.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("polling wait helpers", () => {
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };

  it("aborts sequence job waits during the poll sleep", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        id: "job_1",
        tenant_id: "t",
        status: "running",
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:00:00Z",
      }),
    );
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const promise = pw.sequences.waitForJob("job_1", {
      signal: ac.signal,
      intervalMs: 30_000,
    });

    await Promise.resolve();
    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts voice ingest waits during the poll sleep", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        id: "job_1",
        tenant_id: "t",
        source_id: "src_1",
        status: "pending",
        item_count: 0,
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:00:00Z",
      }),
    );
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const promise = pw.voiceProfile.waitForIngestJob("src_1", "job_1", {
      signal: ac.signal,
      intervalMs: 30_000,
    });

    await Promise.resolve();
    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
