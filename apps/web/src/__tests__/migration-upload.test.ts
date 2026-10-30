import { afterEach, describe, expect, it, vi } from "vitest";

function makeFile(text: string, name = "contacts.csv"): File {
  const blob = new Blob([text], { type: "text/csv" });
  return Object.assign(blob, { name, lastModified: 123 }) as File;
}

function installBrowserStorage() {
  const storage = new Map<string, string>();
  const localStorage = {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("crypto", {
    randomUUID: () => "upload-fixed",
  });
  return storage;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("migration file uploads", () => {
  it("isolates resumable ledgers by exact authority scope and clears only migration metadata", async () => {
    const storage = installBrowserStorage();
    storage.set("unrelated", "keep-me");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("temporary failure", { status: 503 })),
    );
    const { clearMigrationUploadLedgers, uploadMigrationFile } =
      await import("../lib/migration-api");
    const file = makeFile("email\nx@y.com");

    await expect(
      uploadMigrationFile("csv", file, undefined, {
        scopeKey: "tenant-a\u0000user-a\u0000admin\u0000member",
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      uploadMigrationFile("csv", file, undefined, {
        scopeKey: "tenant-b\u0000user-b\u0000admin\u0000member",
      }),
    ).rejects.toMatchObject({ status: 503 });

    const ledgerKeys = [...storage.keys()].filter((key) =>
      key.startsWith("postwave.web.migration-upload.v1:"),
    );
    expect(ledgerKeys).toHaveLength(2);
    expect(ledgerKeys.some((key) => key.includes("tenant-a%00user-a"))).toBe(
      true,
    );
    expect(ledgerKeys.some((key) => key.includes("tenant-b%00user-b"))).toBe(
      true,
    );

    clearMigrationUploadLedgers();
    expect(storage.get("unrelated")).toBe("keep-me");
    expect(
      [...storage.keys()].some((key) =>
        key.startsWith("postwave.web.migration-upload.v1:"),
      ),
    ).toBe(false);
  });

  it("does not restore a cleared ledger from a stale aborted chunk response", async () => {
    const storage = installBrowserStorage();
    let resolveChunk!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveChunk = resolve;
          }),
      ),
    );
    const { clearMigrationUploadLedgers, uploadMigrationFile } =
      await import("../lib/migration-api");
    const controller = new AbortController();
    const request = uploadMigrationFile(
      "csv",
      makeFile("email\nx@y.com"),
      undefined,
      {
        signal: controller.signal,
        scopeKey: "tenant-a\u0000user-a\u0000admin\u0000member",
      },
    );
    for (let attempt = 0; attempt < 20 && !resolveChunk; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    clearMigrationUploadLedgers();
    controller.abort();
    resolveChunk(new Response(null, { status: 204 }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.size).toBe(0);
  });

  it("keeps browser uploads on the same-origin API proxy even when a public API origin is set", async () => {
    const storage = installBrowserStorage();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { uploadMigrationFile } = await import("../lib/migration-api");
    const progress: number[] = [];
    const result = await uploadMigrationFile(
      "csv",
      makeFile("email\nx@y.com"),
      (p) => progress.push(p.uploadedBytes),
    );

    expect(result).toEqual({ job_id: "job_1", account_id: "contacts.csv" });
    expect(progress).toEqual([13]);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/migrations/csv/uploads/upload-fixed?filename=contacts.csv",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: expect.any(Blob),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          "Content-Range": "bytes 0-12/13",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/migrations/csv/uploads/upload-fixed/complete",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    expect(storage.size).toBe(0);
  });

  it("keeps the upload ledger when a chunk fails so retry can resume the same upload", async () => {
    const storage = installBrowserStorage();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    const fetch = vi.fn(async () => {
      return new Response("file too large", { status: 413 });
    });
    vi.stubGlobal("fetch", fetch);

    const { uploadMigrationFile } = await import("../lib/migration-api");

    await expect(
      uploadMigrationFile("csv", makeFile("email\nx@y.com")),
    ).rejects.toMatchObject({
      message: "file too large",
      status: 413,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse([...storage.values()][0] ?? "{}")).toMatchObject({
      uploadId: "upload-fixed",
      uploadedBytes: 0,
      updatedAt: expect.any(Number),
    });
    expect([...storage.keys()].join("\n")).not.toContain("contacts.csv");
  });

  it("uses a sanitized filename in chunk URLs", async () => {
    installBrowserStorage();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { uploadMigrationFile } = await import("../lib/migration-api");
    await uploadMigrationFile(
      "csv",
      makeFile("email\nx@y.com", "folder\\customer export ?secret=1.csv"),
    );

    const url = new URL(
      fetch.mock.calls[0]?.[0] as string,
      "https://app.postwave.test",
    );
    expect(url.searchParams.get("filename")).toBe(
      "customer export _secret_1.csv",
    );
  });

  it("resumes from the last server-acknowledged byte", async () => {
    const storage = installBrowserStorage();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    const body = "email\n" + "x".repeat(600 * 1024);
    const file = makeFile(body);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ received: 512 * 1024 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ received: 512 * 1024, total: body.length }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ received: body.length }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    const { uploadMigrationFile } = await import("../lib/migration-api");

    await expect(uploadMigrationFile("csv", file)).rejects.toMatchObject({
      status: 503,
    });
    expect(JSON.parse([...storage.values()][0] ?? "{}")).toMatchObject({
      uploadId: "upload-fixed",
      uploadedBytes: 512 * 1024,
      updatedAt: expect.any(Number),
    });

    await expect(uploadMigrationFile("csv", file)).resolves.toEqual({
      job_id: "job_1",
      account_id: "contacts.csv",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/migrations/csv/uploads/upload-fixed",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "/api/v1/migrations/csv/uploads/upload-fixed?filename=contacts.csv",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Range": `bytes ${512 * 1024}-${body.length - 1}/${body.length}`,
        }),
      }),
    );
    expect(storage.size).toBe(0);
  });

  it("restarts from byte zero when the server has pruned a saved upload", async () => {
    const storage = installBrowserStorage();
    const file = makeFile("email\nx@y.com");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporary failure", { status: 503 }),
      );
    vi.stubGlobal("fetch", fetch);
    const { uploadMigrationFile } = await import("../lib/migration-api");
    await expect(uploadMigrationFile("csv", file)).rejects.toMatchObject({
      status: 503,
    });
    const ledgerKey = [...storage.keys()][0];
    expect(ledgerKey).toBeDefined();
    storage.set(
      ledgerKey,
      JSON.stringify({
        uploadId: "upload-stale",
        uploadedBytes: 9,
        updatedAt: Date.now(),
      }),
    );

    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ received: 13 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    await expect(uploadMigrationFile("csv", file)).resolves.toMatchObject({
      job_id: "job_1",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/uploads/upload-stale?filename="),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Range": "bytes 0-12/13",
        }),
      }),
    );
  });

  it("ignores oversized legacy upload ledgers before resuming", async () => {
    const storage = installBrowserStorage();
    storage.set(
      "postwave.web.migration-upload.v1:csv:contacts.csv:13:123",
      `legacy-${"x".repeat(9_000)}`,
    );
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { uploadMigrationFile } = await import("../lib/migration-api");
    await expect(
      uploadMigrationFile("csv", makeFile("email\nx@y.com")),
    ).resolves.toEqual({
      job_id: "job_1",
      account_id: "contacts.csv",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/migrations/csv/uploads/upload-fixed?filename=contacts.csv",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
