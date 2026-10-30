// @vitest-environment happy-dom
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// ECO-22 wiring: the chain is reachable from the audit UI an operator already
// uses, not just from a component that exists.
//
// This renders the REAL AuditEventSlideover — the panel that opens when a row
// in the audit log is clicked — because a chain viewer nothing links to answers
// the clause no better than the server endpoint did on its own.

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  auditSessionReplay: vi.fn(),
  getInclusionProof: vi.fn(),
  getAuditChain: vi.fn(),
}));

vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({ hasScope: () => true, loading: false, error: null }),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auditSessionReplay: mocks.auditSessionReplay,
      getInclusionProof: mocks.getInclusionProof,
      getAuditChain: mocks.getAuditChain,
    },
  };
});

import { AuditEventSlideover } from "../../components/AuditEventSlideover";
import type { AuditRow } from "../../lib/api-client";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const value of Object.values(mocks)) value.mockReset();
  mocks.auditSessionReplay.mockResolvedValue({ data: { available: false } });
  mocks.getAuditChain.mockResolvedValue({
    data: {
      requestId: "postwave-api-7c9f/lF3kQ2xTvB-000042",
      rows: [
        {
          id: 41,
          action: "campaign.updated",
          resourceType: "campaign",
          actorType: "human",
          actorLabel: "ada@example.com",
          at: "2026-08-04T10:00:00.000Z",
          metadata: { after: { subject: "New subject" } },
        },
      ],
      truncated: false,
    },
  });
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function baseRow(metadata: Record<string, unknown>): AuditRow {
  return {
    id: 41,
    action: "campaign.updated",
    resourceType: "campaign",
    resourceId: "camp-1",
    actorType: "human",
    actorLabel: "ada@example.com",
    at: "2026-08-04T10:00:00.000Z",
    metadata,
  };
}

describe("the audit slideover reaches the request chain", () => {
  it("offers the chain for a row that carries a correlation id", async () => {
    render(
      <AuditEventSlideover
        row={baseRow({
          context: { correlation_id: "postwave-api-7c9f/lF3kQ2xTvB-000042" },
          after: { subject: "New subject" },
        })}
        onClose={() => {}}
      />,
    );
    await settle();

    const open = document.querySelector<HTMLButtonElement>(
      "[data-testid='audit-request-chain-open']",
    );
    expect(open).not.toBeNull();
    // The id is shown, not only implied — it is what an engineer pastes into a
    // log search to leave the app with the same thread in hand.
    expect(document.body.textContent).toContain(
      "postwave-api-7c9f/lF3kQ2xTvB-000042",
    );

    await act(async () => {
      open?.click();
    });
    await settle();

    // Encoded on the wire; the raw id at the call site. The URL encoding itself
    // is pinned against real chi routing in audit-chain-api.test.ts.
    expect(mocks.getAuditChain).toHaveBeenCalledWith(
      "postwave-api-7c9f/lF3kQ2xTvB-000042",
      { signal: expect.any(AbortSignal) },
    );
    expect(
      document.querySelector("[data-testid='audit-chain-entries']"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("campaign.updated");
  });

  it("aborts the chain read when the request-chain dialog closes", async () => {
    let signal: AbortSignal | undefined;
    mocks.getAuditChain.mockImplementation(
      (_requestId: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      },
    );
    render(
      <AuditEventSlideover
        row={baseRow({ context: { correlation_id: "request/slow" } })}
        onClose={() => {}}
      />,
    );
    await settle();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          "[data-testid='audit-request-chain-open']",
        )
        ?.click();
    });
    await settle();
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      const close = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Close"]',
        ),
      ).at(-1);
      expect(close).toBeDefined();
      close?.click();
    });
    expect(signal?.aborted).toBe(true);
  });

  it("offers nothing for a row written outside any request", async () => {
    // The retention trimmer and queue consumers write no correlation id. An
    // always-visible link would open an empty view every time and teach the
    // operator the feature is broken.
    render(
      <AuditEventSlideover
        row={baseRow({ after: { pruned: 4 } })}
        onClose={() => {}}
      />,
    );
    await settle();

    expect(
      document.querySelector("[data-testid='audit-request-chain']"),
    ).toBeNull();
    expect(mocks.getAuditChain).not.toHaveBeenCalled();
  });

  it("keeps the release-qualified drawer read-only without prefetching held workflows", async () => {
    const row = baseRow({
      context: { correlation_id: "request/release-contained" },
      after: { subject: "Reviewed subject" },
    });
    row.hasEncryptedMetadata = true;

    render(
      <AuditEventSlideover row={row} releaseContained onClose={() => {}} />,
    );
    await settle();

    expect(mocks.auditSessionReplay).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-testid='audit-event-release-boundary']"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Read-only evidence view");
    expect(document.body.textContent).not.toContain("Why high risk?");
    expect(document.body.textContent).not.toContain("Investigate");
    expect(document.body.textContent).not.toContain(
      "Reveal sensitive metadata",
    );
    expect(document.body.textContent).not.toContain(
      "Generate proof for this event",
    );
    expect(document.body.textContent).not.toContain("Retention & legal hold");
    expect(
      document.querySelector("[data-testid='audit-request-chain-open']"),
    ).not.toBeNull();
  });

  it("distinguishes a recorded zero-row audit read from missing row-count evidence", async () => {
    const missingCount = baseRow({
      path: "/api/v1/audit",
      query_canonical: "actor_type=human",
    });
    missingCount.action = "audit.read.list";
    render(
      <AuditEventSlideover
        row={missingCount}
        releaseContained
        onClose={() => {}}
      />,
    );
    await settle();

    const readBlock = document.querySelector(
      "[data-testid='audit-meta-read-block']",
    );
    expect(readBlock?.textContent).toContain("Rows returned: Not recorded");

    act(() => {
      root?.render(
        <AuditEventSlideover
          row={{
            ...missingCount,
            metadata: { ...missingCount.metadata, row_count: 0 },
          }}
          releaseContained
          onClose={() => {}}
        />,
      );
    });
    expect(
      document.querySelector("[data-testid='audit-meta-read-block']")
        ?.textContent,
    ).toContain("Rows returned: 0");

    act(() => {
      root?.render(
        <AuditEventSlideover
          row={{
            ...missingCount,
            metadata: { ...missingCount.metadata, row_count: "0" },
          }}
          releaseContained
          onClose={() => {}}
        />,
      );
    });
    expect(
      document.querySelector("[data-testid='audit-meta-read-block']")
        ?.textContent,
    ).toContain("Rows returned: Not recorded");
  });
});
