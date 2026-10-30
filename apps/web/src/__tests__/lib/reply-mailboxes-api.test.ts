// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  buildReplyMailboxCreateInput,
  createReplyMailbox,
  decodeReplyMailboxList,
  deleteReplyMailbox,
  listReplyMailboxes,
  setReplyMailboxEnabled,
  tenantMailboxSecretPrefix,
} from "@/lib/reply-mailboxes-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const PREFIX = "env:POSTWAVE_REPLY_IMAP_TENANT_11111111111141118111111111111111_";

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    label: "Support replies",
    host: "imap.example.net",
    port: 993,
    use_tls: true,
    folder: "INBOX",
    username_secret_ref: `${PREFIX}SUPPORT_USERNAME`,
    password_secret_ref: `${PREFIX}SUPPORT_PASSWORD`,
    enabled: false,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("reply mailbox web client", () => {
  it("strictly decodes the authoritative envelope and requests no-store", async () => {
    mocks.get.mockResolvedValue({ items: [mailbox()] });
    await expect(listReplyMailboxes()).resolves.toMatchObject([
      { id: ID, enabled: false, host: "imap.example.net" },
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/replies/mailboxes", {
      cache: "no-store",
      signal: undefined,
    });
  });

  it.each([
    ["legacy array envelope", [mailbox()]],
    ["missing items", {}],
    ["malformed row", { items: [mailbox({ enabled: "false" })] }],
    ["credential-looking refs", { items: [mailbox({ password_secret_ref: "hunter2" })] }],
    ["unknown field", { items: [mailbox({ password: "hunter2" })] }],
    ["duplicate ids", { items: [mailbox(), mailbox()] }],
    [
      "enabled quarantine",
      {
        items: [
          mailbox({
            enabled: true,
            security_quarantined_at: "2026-08-30T10:00:00Z",
            security_quarantine_reason:
              "legacy_insecure_transport_or_secret_reference",
          }),
        ],
      },
    ],
  ])("fails closed on %s", (_label, payload) => {
    expect(() => decodeReplyMailboxList(payload)).toThrow(/invalid reply mailbox/i);
  });

  it("derives and enforces the exact tenant namespace without accepting credentials", () => {
    expect(tenantMailboxSecretPrefix(TENANT)).toBe(PREFIX);
    expect(
      buildReplyMailboxCreateInput(
        {
          label: " Support ",
          host: " imap.example.net ",
          usernameSecretRef: `${PREFIX}SUPPORT_USERNAME`,
          passwordSecretRef: `${PREFIX}SUPPORT_PASSWORD`,
        },
        TENANT,
      ),
    ).toEqual({
      label: "Support",
      host: "imap.example.net",
      port: 993,
      use_tls: true,
      folder: "INBOX",
      username_secret_ref: `${PREFIX}SUPPORT_USERNAME`,
      password_secret_ref: `${PREFIX}SUPPORT_PASSWORD`,
    });
    expect(() =>
      buildReplyMailboxCreateInput(
        {
          label: "Support",
          host: "imap.example.net",
          usernameSecretRef: "support@example.net",
          passwordSecretRef: "hunter2",
        },
        TENANT,
      ),
    ).toThrow(/never a credential value/i);
  });

  it("uses online-only single-attempt mutations and validates receipts", async () => {
    mocks.post.mockResolvedValue(mailbox());
    await createReplyMailbox(
      {
        label: "Support",
        host: "imap.example.net",
        usernameSecretRef: `${PREFIX}SUPPORT_USERNAME`,
        passwordSecretRef: `${PREFIX}SUPPORT_PASSWORD`,
      },
      TENANT,
    );
    expect(mocks.post).toHaveBeenLastCalledWith(
      "/api/v1/replies/mailboxes",
      expect.objectContaining({ port: 993, use_tls: true }),
      expect.objectContaining({ requireOnline: true, maxAttempts: 1, cache: "no-store" }),
    );

    mocks.post.mockResolvedValue(mailbox({ enabled: true }));
    await setReplyMailboxEnabled(ID, true);
    expect(mocks.post).toHaveBeenLastCalledWith(
      `/api/v1/replies/mailboxes/${ID}/enable`,
      undefined,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );

    mocks.delete.mockResolvedValue(undefined);
    await expect(deleteReplyMailbox(ID)).resolves.toBeUndefined();
    mocks.delete.mockResolvedValue({ ok: true });
    await expect(deleteReplyMailbox(ID)).rejects.toThrow(/deletion response/i);
  });
});
