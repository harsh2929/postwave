import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportSmsConversationsCsv } from "./smsConversationsExport";

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      apiKey: null,
      baseUrl: "https://api.example.com",
      mode: "session",
      session: { workspaceSlug: "acme" },
      tenantId: null,
    }),
  },
}));

const TRUTH = {
  "X-Postwave-Export-Limit": "10000",
  "X-Postwave-Export-As-Of": "2026-08-21T10:00:00Z",
  "X-Postwave-Export-Row-Count": "2",
  "X-Postwave-Truncated": "false",
};

function response(over: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}) {
  const headers: Record<string, string> = over.headers ?? { ...TRUTH };
  return {
    ok: over.ok ?? true,
    status: over.status ?? 200,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => over.body ?? "phone_e164,last_message_at\n",
    json: async () => JSON.parse(over.body ?? "{}") as unknown,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exportSmsConversationsCsv", () => {
  it("sends the audit reason header on the session-authenticated fetch", async () => {
    fetchMock.mockResolvedValue(response({}));
    const result = await exportSmsConversationsCsv({
      reason: "  quarterly compliance review  ",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/sms/conversations.csv");
    expect(
      (init.headers as Record<string, string>)["X-Postwave-Audit-Reason"],
    ).toBe("quarterly compliance review");
    expect(init.credentials).toBe("include");
    expect(result.truth.rowCount).toBe(2);
    expect(result.filename).toContain("postwave-sms-conversations-");
  });

  it("refuses an invalid reason before any request", async () => {
    await expect(exportSmsConversationsCsv({ reason: " " })).rejects.toThrow(
      /required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an export that arrives without its truth headers", async () => {
    fetchMock.mockResolvedValue(response({ headers: {} }));
    await expect(
      exportSmsConversationsCsv({ reason: "compliance review" }),
    ).rejects.toThrow(/verification headers/);
  });

  it("surfaces the server error envelope's message", async () => {
    fetchMock.mockResolvedValue(
      response({
        ok: false,
        status: 400,
        body: JSON.stringify({
          error: {
            code: "audit_reason_required",
            message: "X-Postwave-Audit-Reason is required for a bulk SMS export",
          },
        }),
      }),
    );
    await expect(
      exportSmsConversationsCsv({ reason: "compliance review" }),
    ).rejects.toThrow(/Audit-Reason is required/);
  });
});
