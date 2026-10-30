// SPDX-License-Identifier: AGPL-3.0-only
//
// The "Older messages" control's request: listHelpdeskMessages sends the
// opaque continuation cursor to the mounted message route, newest first, and
// hands the next cursor back from the page receipt.
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMocks,
}));

import { listHelpdeskMessages } from "@/lib/service-suite-operations-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  apiMocks.get.mockReset();
});

describe("helpdesk message cursor transport", () => {
  it("requests the older page with the cursor on the conversation's message route", async () => {
    apiMocks.get.mockResolvedValueOnce({
      tenantId: TENANT,
      items: [
        {
          tenantId: TENANT,
          tenant_id: TENANT,
          id: "33333333-3333-4333-8333-333333333333",
          conversation_id: CONVERSATION,
          direction: "inbound",
          sender_type: "customer",
          sender: "customer@example.test",
          body_text: "Older customer text",
          record_kind: "inbound_record",
          delivery_status: "received",
          attachment_count: 0,
          projection_truncated: false,
          sent_at: "2026-08-28T09:00:00Z",
          created_at: "2026-08-28T09:00:01Z",
        },
      ],
      page: {
        has_more: true,
        next_cursor: "cursor-oldest",
        as_of: "2026-08-29T10:01:00Z",
        consistency: "created_at_window",
        may_reorder: true,
      },
    });
    const page = await listHelpdeskMessages({
      tenantId: TENANT,
      conversationId: CONVERSATION,
      order: "desc",
      cursor: "cursor-older",
    });
    expect(apiMocks.get).toHaveBeenCalledWith(
      `/api/v1/service-suite/conversations/${CONVERSATION}/messages`,
      { query: { limit: expect.any(Number), cursor: "cursor-older", order: "desc" } },
    );
    expect(page.items[0]?.bodyText).toBe("Older customer text");
    expect(page.page.nextCursor).toBe("cursor-oldest");
  });
});
