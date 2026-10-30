import { describe, expect, it, vi } from "vitest";

import { createfeedbackApi } from "../../lib/api/feedback";
import type { ApiRequester } from "../../lib/api/result";

describe("feedback API sensitive transport", () => {
  it("carries the exact trimmed-case mailbox in a POST body, never the URL", async () => {
    const requestMock = vi.fn(async (_path: string, _init?: RequestInit) => ({
      data: { bounces: [], complaints: [] },
    }));
    const request = requestMock as unknown as ApiRequester;
    const email = "Alice.Tag+News@Example.COM";

    await createfeedbackApi(request).getHistory(email);

    expect(request).toHaveBeenCalledWith("/api/v1/feedback/history", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(requestMock.mock.calls[0]?.[0]).not.toContain(email);
    expect(requestMock.mock.calls[0]?.[0]).not.toContain("@");
  });
});
