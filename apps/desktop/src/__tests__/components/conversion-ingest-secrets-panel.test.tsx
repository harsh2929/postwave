// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  issue: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    conversionsApi: {
      ...actual.conversionsApi,
      listIngestSecrets: mocks.list,
      issueIngestSecret: mocks.issue,
      revokeIngestSecret: mocks.revoke,
    },
  };
});

vi.mock("../../lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clipboard")>()),
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: vi.fn(),
  },
}));

import { ConversionIngestSecretsPanel } from "../../components/track/ConversionIngestSecretsPanel";
import {
  CONVERSION_INGEST_V2_CONTRACT,
  issuedConversionIngestSecretSummary,
  parseConversionIngestSecretRegister,
  parseIssuedConversionIngestSecret,
} from "../../components/track/conversion-ingest-secret-contract";

const REVEALED_SECRET = "A".repeat(43);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderPanel(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ConversionIngestSecretsPanel />));
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw failure;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.list.mockResolvedValue({
    data: {
      items: [
        {
          key_id: "0123456789abcdef0123456789abcdef",
          label: "Production checkout",
          created_at: "2026-08-30T10:00:00Z",
          identity_projection_status: "ready",
          identity_projection_updated_at: "2026-08-30T10:01:00Z",
        },
        {
          key_id: "fedcba9876543210fedcba9876543210",
          label: "Retired checkout",
          created_at: "2026-08-01T10:00:00Z",
          revoked_at: "2026-08-29T10:00:00Z",
          identity_projection_status: "failed",
          identity_projection_error_code: "secret_unavailable",
          identity_projection_updated_at: "2026-08-29T10:01:00Z",
        },
      ],
    },
  });
  mocks.issue.mockResolvedValue({
    data: {
      secret: {
        key_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        secret: REVEALED_SECRET,
        label: "Replacement checkout",
        created_at: "2026-08-30T11:00:00Z",
        identity_projection_status: "pending",
        identity_projection_updated_at: "2026-08-30T11:00:00Z",
      },
      notice: "This is the only time the secret is shown.",
    },
  });
  mocks.revoke.mockResolvedValue({ data: { revoked: true } });
  mocks.writeClipboardText.mockResolvedValue({
    ok: true,
    backend: "native",
    contentClass: "secret",
    clearScheduled: true,
    clearAfterMs: 60_000,
    historyWarning: "Clipboard history may retain this secret.",
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

describe("desktop conversion signed-ingest key surface", () => {
  it("lists active and revoked private keys and renders the exact v2 boundary", async () => {
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Production checkout"),
    );
    expect(document.body.textContent).toContain(
      "Trusted server conversion ingest",
    );
    expect(document.body.textContent).toContain(
      "separate from the publishable browser tracking keys",
    );
    expect(document.body.textContent).toContain(
      "X-Postwave-Signature: keyid=<id>,v2=<hex>",
    );
    expect(document.body.textContent).toContain(
      "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
    );
    expect(document.body.textContent).toContain(
      "Never send identity.email, plaintext email",
    );
    expect(document.body.textContent).toContain("email HMAC ready");
    expect(document.body.textContent).toContain("email HMAC failed");
    expect(document.body.textContent).toContain(
      "This key cannot prepare email identities",
    );
    expect(
      Array.from(document.querySelectorAll("button")).filter(
        (candidate) => candidate.textContent?.trim() === "Revoke",
      ),
    ).toHaveLength(1);
  });

  it("issues a one-time secret with lifecycle and secure-storage ceremony", async () => {
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Production checkout"),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Production checkout service"]',
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "Replacement checkout");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Issue server key")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(REVEALED_SECRET),
    );
    expect(mocks.issue).toHaveBeenCalledWith("Replacement checkout");
    expect(document.body.textContent).toContain("approved secret manager");
    expect(document.body.textContent).toContain("email HMAC pending");
    expect(document.body.textContent).toContain("requests receive 503");
    expect(document.body.textContent).toContain(
      "Click-ID and external-ID-only events are unaffected",
    );
    expect(button("Acknowledge and clear")?.getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("fences an ambiguous issue until the register is explicitly reconciled", async () => {
    mocks.issue.mockRejectedValueOnce(new Error("connection lost after upload"));
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Production checkout"),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Production checkout service"]',
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "Possibly issued key");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Issue server key")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The issue outcome is unknown",
      ),
    );
    expect(document.body.textContent).toContain(
      "If a new key ID appeared, revoke it, then issue a replacement",
    );
    expect(document.body.textContent).toContain(
      "Never retry this issuance blindly",
    );
    expect(button("Issue server key")?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(async () => button("Issue server key")?.click());
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls.length).toBeGreaterThan(1);

    await act(async () =>
      button("Register reconciled — allow replacement")?.click(),
    );
    expect(button("Issue server key")?.getAttribute("aria-disabled")).toBeNull();
  });

  it("confirm-gates revocation and requires a positive server acknowledgement", async () => {
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Production checkout"),
    );
    await act(async () => button("Revoke")?.click());
    expect(document.body.textContent).toContain(
      "Revoke this server signing key?",
    );
    expect(document.body.textContent).toContain(
      "move and verify traffic on a new live key first",
    );
    await act(async () => button("Revoke server key")?.click());
    await waitFor(() =>
      expect(mocks.revoke).toHaveBeenCalledWith(
        "0123456789abcdef0123456789abcdef",
      ),
    );
  });

  it("loads bounded register history explicitly", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              key_id: "0123456789abcdef0123456789abcdef",
              label: "Production checkout",
              created_at: "2026-08-30T10:00:00Z",
              identity_projection_status: "ready",
              identity_projection_updated_at: "2026-08-30T10:01:00Z",
            },
          ],
          next_cursor: "opaque-page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              key_id: "fedcba9876543210fedcba9876543210",
              label: "Retired checkout",
              created_at: "2026-08-01T10:00:00Z",
              revoked_at: "2026-08-29T10:00:00Z",
              identity_projection_status: "failed",
              identity_projection_error_code: "secret_unavailable",
              identity_projection_updated_at: "2026-08-29T10:01:00Z",
            },
          ],
        },
      });
    renderPanel();
    await waitFor(() => expect(button("Load more server keys")).toBeTruthy());
    expect(document.body.textContent).not.toContain("Retired checkout");
    await act(async () => button("Load more server keys")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Retired checkout"),
    );
    expect(mocks.list).toHaveBeenCalledWith("opaque-page-2");
  });

  it("keeps every credential affordance admin-only", async () => {
    mocks.canAdmin = false;
    renderPanel();
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain("admin-only");
    expect(document.querySelector("form")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("desktop conversion signed-ingest response codec", () => {
  it("rejects secret-bearing list rows and locks the key-bound preimage", () => {
    expect(
      parseConversionIngestSecretRegister({
        items: [
          {
            key_id: "0123456789abcdef0123456789abcdef",
            label: "bad",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:01:00Z",
            secret: "must-not-be-listable",
          },
        ],
      }),
    ).toBeNull();
    expect(CONVERSION_INGEST_V2_CONTRACT).toEqual([
      "X-Postwave-Signature: keyid=<id>,v2=<hex>",
      "X-Postwave-Timestamp: <Unix seconds>",
      "Idempotency-Key: <stable retry key>",
      "MAC = HMAC-SHA256(signing secret, UTF8('postwave-conversion-v2\\n' + byteLength(key_id) + '\\n' + key_id + byteLength(timestamp) + '\\n' + timestamp) || exact raw JSON bytes)",
      "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
    ]);
    const issued = parseIssuedConversionIngestSecret({
      secret: {
        key_id: "0123456789abcdef0123456789abcdef",
        label: "Production checkout",
        created_at: "2026-08-30T10:00:00Z",
        secret: REVEALED_SECRET,
        identity_projection_status: "pending",
        identity_projection_updated_at: "2026-08-30T10:00:00Z",
      },
      notice: "Only shown once.",
    });
    expect(issued).not.toBeNull();
    const registerRow = issued
      ? issuedConversionIngestSecretSummary(issued)
      : null;
    expect(registerRow).not.toHaveProperty("secret");
  });

  it("fails closed on incomplete or contradictory projection metadata", () => {
    const base = {
      key_id: "0123456789abcdef0123456789abcdef",
      label: "Production checkout",
      created_at: "2026-08-30T10:00:00Z",
      identity_projection_updated_at: "2026-08-30T10:01:00Z",
    };
    expect(
      parseConversionIngestSecretRegister({
        items: [{ ...base, identity_projection_status: "failed" }],
      }),
    ).toBeNull();
    expect(
      parseConversionIngestSecretRegister({
        items: [
          {
            ...base,
            identity_projection_status: "ready",
            identity_projection_error_code: "projection_failed",
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseConversionIngestSecretRegister({
        items: [
          {
            ...base,
            identity_projection_status: "failed",
            identity_projection_error_code: "projection_failed",
          },
        ],
      })?.items[0],
    ).toMatchObject({
      identityProjectionStatus: "failed",
      identityProjectionErrorCode: "projection_failed",
    });
  });

  it("uses exact key, Unicode-label, reveal-secret, and closed-envelope schemas", () => {
    const multibyteLabel = "😀".repeat(128);
    const row = {
      key_id: "0123456789abcdef0123456789abcdef",
      label: multibyteLabel,
      created_at: "2026-08-30T10:00:00Z",
      identity_projection_status: "pending",
      identity_projection_updated_at: "2026-08-30T10:00:00Z",
    };
    expect(
      parseConversionIngestSecretRegister({ items: [row] })?.items[0]?.label,
    ).toBe(multibyteLabel);
    expect(
      parseConversionIngestSecretRegister({
        items: [{ ...row, key_id: "KEY-1" }],
      }),
    ).toBeNull();
    expect(
      parseConversionIngestSecretRegister({
        items: [{ ...row, label: "😀".repeat(129) }],
      }),
    ).toBeNull();
    expect(
      parseIssuedConversionIngestSecret({
        secret: { ...row, secret: REVEALED_SECRET },
        notice: "Only shown once.",
      })?.secret,
    ).toBe(REVEALED_SECRET);
    for (const malformed of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`]) {
      expect(
        parseIssuedConversionIngestSecret({
          secret: { ...row, secret: malformed },
          notice: "Only shown once.",
        }),
      ).toBeNull();
    }
    expect(
      parseIssuedConversionIngestSecret({
        secret: { ...row, secret: REVEALED_SECRET },
        notice: "Only shown once.",
        replayable: true,
      }),
    ).toBeNull();
  });

  it("accepts only a bounded optional opaque register cursor", () => {
    expect(
      parseConversionIngestSecretRegister({
        items: [],
        next_cursor: "next/opaque+cursor==",
      }),
    ).toEqual({ items: [], nextCursor: "next/opaque+cursor==" });
    expect(
      parseConversionIngestSecretRegister({ items: [], next_cursor: "" }),
    ).toBeNull();
    expect(
      parseConversionIngestSecretRegister({
        items: [],
        next_cursor: "x".repeat(513),
      }),
    ).toBeNull();
    expect(
      parseConversionIngestSecretRegister({ items: [], total: 0 }),
    ).toBeNull();
  });
});
