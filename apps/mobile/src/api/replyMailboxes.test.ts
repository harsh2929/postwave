import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteReplyMailbox,
  listReplyMailboxes,
  setReplyMailboxEnabled,
} from "./replyMailboxes";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const id = "018f47f2-9f25-7f73-8ec6-3fd483eb51dd";
const wire = {
  id,
  label: "Support",
  host: "imap.example.com",
  port: 993,
  use_tls: true,
  folder: "INBOX",
  username_secret_ref:
    "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_USER",
  password_secret_ref:
    "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_PASSWORD",
  enabled: false,
};
const noStore = { headers: { "Cache-Control": "no-store" } };

beforeEach(() => rawRequest.mockReset());

describe("reply mailbox transport", () => {
  it("strictly decodes the list envelope and requests no-store", async () => {
    rawRequest.mockResolvedValue({ data: { items: [wire] }, error: null });

    await expect(listReplyMailboxes()).resolves.toHaveLength(1);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/replies/mailboxes",
      undefined,
      noStore,
    );

    rawRequest.mockResolvedValueOnce({ data: [], error: null });
    await expect(listReplyMailboxes()).rejects.toThrow(/invalid/ui);
  });

  it("verifies enable and disable receipts", async () => {
    rawRequest.mockResolvedValue({
      data: { ...wire, enabled: true },
      error: null,
    });

    await expect(setReplyMailboxEnabled(id, true)).resolves.toMatchObject({
      id,
      enabled: true,
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      `/api/v1/replies/mailboxes/${id}/enable`,
      {},
      noStore,
    );

    rawRequest.mockResolvedValueOnce({ data: wire, error: null });
    await expect(setReplyMailboxEnabled(id, true)).rejects.toThrow(/receipt/u);
  });

  it("rejects malformed ids before transport", async () => {
    await expect(setReplyMailboxEnabled("../other", true)).rejects.toThrow(
      /invalid reply mailbox id/ui,
    );
    await expect(deleteReplyMailbox("../other")).rejects.toThrow(
      /invalid reply mailbox id/ui,
    );
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("requires a bodyless no-store delete receipt", async () => {
    rawRequest.mockResolvedValue({ data: undefined, error: null });
    await expect(deleteReplyMailbox(id)).resolves.toBeUndefined();
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      `/api/v1/replies/mailboxes/${id}`,
      undefined,
      noStore,
    );

    rawRequest.mockResolvedValueOnce({ data: {}, error: null });
    await expect(deleteReplyMailbox(id)).rejects.toThrow(/unexpected/ui);
  });
});
