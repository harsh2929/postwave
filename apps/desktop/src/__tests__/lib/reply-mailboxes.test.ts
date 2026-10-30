import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../../lib/api-client", () => ({ apiRequest: mocks.request }));

import {
  buildReplyMailboxCreateInput,
  createReplyMailbox,
  decodeReplyMailboxList,
  deleteReplyMailbox,
  listReplyMailboxes,
  setReplyMailboxEnabled,
  tenantMailboxSecretPrefix,
} from "../../lib/reply-mailboxes";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const PREFIX = "env:POSTWAVE_REPLY_IMAP_TENANT_11111111111141118111111111111111_";

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    label: "Support",
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

describe("desktop reply mailbox client", () => {
  it("strictly decodes the list and forces a no-store online read", async () => {
    mocks.request.mockResolvedValue({ data: { items: [mailbox()] } });
    await expect(listReplyMailboxes()).resolves.toMatchObject([
      { id: ID, enabled: false },
    ]);
    expect(mocks.request).toHaveBeenCalledWith(
      "/api/v1/replies/mailboxes",
      { method: "GET", cache: "no-store" },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it.each([
    ["array envelope", [mailbox()]],
    ["missing envelope", {}],
    ["unknown field", { items: [mailbox({ credential: "secret" })] }],
    ["wrong enabled type", { items: [mailbox({ enabled: 1 })] }],
    ["credential-looking refs", { items: [mailbox({ password_secret_ref: "hunter2" })] }],
    ["duplicate id", { items: [mailbox(), mailbox()] }],
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
  ])("fails closed on %s", (_label, value) => {
    expect(() => decodeReplyMailboxList(value)).toThrow(/invalid reply mailbox/i);
  });

  it("builds only a fixed TLS/993 disabled-first registration from tenant refs", () => {
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

  it("uses single-attempt online-only writes and validates receipts", async () => {
    mocks.request.mockResolvedValue({ data: mailbox() });
    await createReplyMailbox(
      {
        label: "Support",
        host: "imap.example.net",
        usernameSecretRef: `${PREFIX}SUPPORT_USERNAME`,
        passwordSecretRef: `${PREFIX}SUPPORT_PASSWORD`,
      },
      TENANT,
    );
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/api/v1/replies/mailboxes",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: expect.stringContaining('"use_tls":true'),
      }),
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );

    mocks.request.mockResolvedValue({ data: mailbox({ enabled: true }) });
    await setReplyMailboxEnabled(ID, true);
    expect(mocks.request).toHaveBeenLastCalledWith(
      `/api/v1/replies/mailboxes/${ID}/enable`,
      { method: "POST", cache: "no-store" },
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );

    mocks.request.mockResolvedValue({ data: undefined });
    await expect(deleteReplyMailbox(ID)).resolves.toBeUndefined();
    mocks.request.mockResolvedValue({ data: { ok: true } });
    await expect(deleteReplyMailbox(ID)).rejects.toThrow(/deletion response/i);
  });
});
