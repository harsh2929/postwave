// @vitest-environment happy-dom
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// ECO-22 on desktop: the audit UI can answer "what happened when I clicked
// that?" without joining ids by hand across screens.
//
// Two behaviours carry the clause and both are easy to get subtly wrong:
//
//   - the EMPTY chain must read as an answer. The server returns 200 with
//     rows: [] for a request that audited nothing, and rendering that as a
//     failure tells the operator the lookup broke when the server in fact said
//     "nothing was audited under this request".
//   - the affordance must be CONDITIONAL. Rows written outside a request
//     (workers, queue consumers) carry no correlation id, and the endpoint
//     refuses the "-" sentinel — a link there opens an empty view every time.

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
  getAuditChain: vi.fn(),
  writeClipboard: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getAuditChain: mocks.getAuditChain },
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.writeClipboard,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import {
  AuditChainModal,
  chainActorLabel,
  chainChangePayload,
  chainOffsetLabel,
} from "../../components/audit/AuditChainModal";
import { AuditRequestChain } from "../../components/audit/AuditRequestChain";
import type { AuditChainRow } from "../../lib/api-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const value of Object.values(mocks)) value.mockReset();
  mocks.writeClipboard.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "public",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
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
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

const CHAIN_ROWS: AuditChainRow[] = [
  {
    id: 41,
    action: "campaign.updated",
    resourceType: "campaign",
    resourceId: "camp-1",
    actorType: "human",
    actorLabel: "ada@example.com",
    at: "2026-08-04T10:00:00.000Z",
    metadata: {
      context: { correlation_id: "web-01/AbC-7", route: "/api/v1/campaigns" },
      before: { subject: "Old subject" },
      after: { subject: "New subject" },
    },
  },
  {
    id: 42,
    action: "approval.decided",
    resourceType: "approval",
    resourceId: "appr-9",
    actorType: "human",
    actorLabel: "grace@example.com",
    at: "2026-08-04T10:00:00.120Z",
    metadata: {
      context: { correlation_id: "web-01/AbC-7" },
      before: { state: "pending" },
      after: { state: "approved" },
    },
  },
  {
    id: 43,
    action: "campaign.queued",
    resourceType: "campaign",
    resourceId: "camp-1",
    actorType: "system",
    at: "2026-08-04T10:00:02.500Z",
    metadata: { context: { correlation_id: "web-01/AbC-7" } },
  },
];

describe("AuditChainModal", () => {
  it("renders the chain in the causal order the server sent", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "web-01/AbC-7", rows: CHAIN_ROWS, truncated: false },
    });

    render(<AuditChainModal requestId="web-01/AbC-7" onClose={() => {}} />);
    await flush();

    expect(mocks.getAuditChain).toHaveBeenCalledWith(
      "web-01/AbC-7",
      // The signal is asserted, not tolerated. The client has always accepted
      // one and the modal passed none, so closing the view cancelled only the
      // state write while the read — up to 500 rows — carried on. Pinning it
      // here is what stops that silently regressing.
      expect.objectContaining({ signal: expect.anything() }),
    );
    const entries = Array.from(
      document.querySelectorAll("[data-testid='audit-chain-entries'] > li"),
    );
    expect(entries).toHaveLength(3);
    // Ascending, as received. Reversing would make the chain read backwards.
    expect(entries.map((li) => li.querySelector(".mono")?.textContent)).toEqual(
      ["campaign.updated", "approval.decided", "campaign.queued"],
    );
  });

  it("shows who acted, what changed, and how far into the request", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "web-01/AbC-7", rows: CHAIN_ROWS, truncated: false },
    });

    render(<AuditChainModal requestId="web-01/AbC-7" onClose={() => {}} />);
    await flush();

    const body = text();
    expect(body).toContain("3 entries, in the order they happened");
    // by whom
    expect(body).toContain("ada@example.com");
    expect(body).toContain("grace@example.com");
    // what changed — the diff, not the raw blob
    expect(body).toContain("Old subject");
    expect(body).toContain("New subject");
    expect(body).toContain("approved");
    // when, relative to the start — absolute clocks inside one request are all
    // the same second, which is why the offset is the legible unit.
    expect(body).toContain("+0ms");
    expect(body).toContain("+120ms");
    expect(body).toContain("+2.50s");
    // an entry whose payload is only request context says so instead of
    // rendering an empty diff
    expect(body).toContain("No change payload was recorded for this action.");
  });

  it("answers an empty chain truthfully instead of as a failure", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "req-nothing", rows: [], truncated: false },
    });

    render(<AuditChainModal requestId="req-nothing" onClose={() => {}} />);
    await flush();

    expect(
      document.querySelector("[data-testid='audit-chain-empty']"),
    ).not.toBeNull();
    expect(text()).toContain("Nothing was audited under this request");
    // Not an error: no alert, and no retry affordance implying the read broke.
    expect(document.querySelector("[role='alert']")).toBeNull();
    expect(
      document.querySelector("[data-testid='audit-chain-error']"),
    ).toBeNull();
  });

  it("says when the chain was cut off at the server's cap", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "r", rows: CHAIN_ROWS, truncated: true },
    });

    render(<AuditChainModal requestId="r" onClose={() => {}} />);
    await flush();

    expect(
      document.querySelector("[data-testid='audit-chain-truncated']"),
    ).not.toBeNull();
    expect(text()).toContain("500-entry cap");
  });

  it("does not claim the cap was hit when the server said it was not", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "r", rows: CHAIN_ROWS, truncated: false },
    });

    render(<AuditChainModal requestId="r" onClose={() => {}} />);
    await flush();

    expect(
      document.querySelector("[data-testid='audit-chain-truncated']"),
    ).toBeNull();
  });

  it("surfaces a transport failure as an error with a retry", async () => {
    mocks.getAuditChain.mockResolvedValueOnce({
      error: { kind: "http", status: 500, message: "audit unavailable" },
    });
    mocks.getAuditChain.mockResolvedValueOnce({
      data: { requestId: "r", rows: CHAIN_ROWS, truncated: false },
    });

    render(<AuditChainModal requestId="r" onClose={() => {}} />);
    await flush();

    expect(text()).toContain("audit unavailable");
    expect(document.querySelector("[role='alert']")).not.toBeNull();

    await act(async () => {
      button("Try again").click();
    });
    await flush();

    expect(mocks.getAuditChain).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector("[data-testid='audit-chain-entries']"),
    ).not.toBeNull();
  });

  it("does not let a slow read for one request overwrite the chain of another", async () => {
    // The stale-response race, by the path that is actually reachable.
    //
    // My first draft aimed this at the retry button and that race cannot happen:
    // "Try again" only appears once the first read has already resolved with an
    // error, so there is nothing still in flight to land late. What IS reachable
    // is opening one row's chain and then another — the audit page drives this
    // modal by requestId, so the effect re-fires while the first read is still
    // out. If the slow one wins, the operator is looking at a chain for a
    // request they did not ask about, with nothing on screen saying so.
    //
    // A mutation survived here before: deleting the cleanup guard left every
    // test green, so the guard was real and undefended.
    let releaseFirst: (value: unknown) => void = () => {};
    mocks.getAuditChain.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    mocks.getAuditChain.mockResolvedValueOnce({
      data: {
        requestId: "second",
        rows: [{ ...CHAIN_ROWS[0], action: "the.second.answer" }],
        truncated: false,
      },
    });

    render(<AuditChainModal requestId="first" onClose={() => {}} />);
    await flush();

    // The operator opens a different row's chain while the first is still out.
    await act(async () => {
      root?.render(<AuditChainModal requestId="second" onClose={() => {}} />);
    });
    await flush();
    expect(text()).toContain("the.second.answer");

    // Now the abandoned read finally answers.
    await act(async () => {
      releaseFirst({
        data: {
          requestId: "first",
          rows: [{ ...CHAIN_ROWS[0], action: "the.stale.answer" }],
          truncated: false,
        },
      });
    });
    await flush();

    expect(text()).toContain("the.second.answer");
    expect(text()).not.toContain("the.stale.answer");
  });

  it("copies the request id so it can be carried to a log search", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "web-01/AbC-7", rows: [], truncated: false },
    });

    render(<AuditChainModal requestId="web-01/AbC-7" onClose={() => {}} />);
    await flush();

    await act(async () => {
      button("Copy").click();
    });
    await flush();

    expect(mocks.writeClipboard).toHaveBeenCalledWith("web-01/AbC-7", {
      contentClass: "public",
      label: "Audit request id",
    });
  });
});

describe("AuditRequestChain affordance", () => {
  it("renders nothing for a row written outside any request", () => {
    // The retention trimmer, queue consumers and workers write no correlation
    // id. A link here would open an empty view every time.
    render(<AuditRequestChain row={{ metadata: { after: { pruned: 4 } } }} />);
    expect(
      document.querySelector("[data-testid='audit-request-chain']"),
    ).toBeNull();
  });

  it("renders nothing for the placeholder id the endpoint refuses", () => {
    render(
      <AuditRequestChain
        row={{ metadata: { context: { correlation_id: "-" } } }}
      />,
    );
    expect(
      document.querySelector("[data-testid='audit-request-chain']"),
    ).toBeNull();
  });

  it("shows the correlation id and opens the chain for a row that carries one", async () => {
    mocks.getAuditChain.mockResolvedValue({
      data: { requestId: "web-01/AbC-7", rows: CHAIN_ROWS, truncated: false },
    });

    render(
      <AuditRequestChain
        row={{ metadata: { context: { correlation_id: "web-01/AbC-7" } } }}
      />,
    );

    expect(text()).toContain("web-01/AbC-7");
    expect(mocks.getAuditChain).not.toHaveBeenCalled();

    await act(async () => {
      button("View request chain").click();
    });
    await flush();

    expect(mocks.getAuditChain).toHaveBeenCalledWith(
      "web-01/AbC-7",
      // The signal is asserted, not tolerated. The client has always accepted
      // one and the modal passed none, so closing the view cancelled only the
      // state write while the read — up to 500 rows — carried on. Pinning it
      // here is what stops that silently regressing.
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(
      document.querySelector("[data-testid='audit-chain-entries']"),
    ).not.toBeNull();
  });
});

describe("chain presentation helpers", () => {
  it("strips request context from the change payload", () => {
    // `context` records how the row got here, not what the action changed, and
    // it is byte-identical on every entry — repeating it under each step would
    // bury the one line that differs.
    expect(
      chainChangePayload({
        context: { correlation_id: "web-01/AbC-7" },
        before: { state: "pending" },
        after: { state: "approved" },
      }),
    ).toEqual({ before: { state: "pending" }, after: { state: "approved" } });
  });

  it("reports no payload when only request context was recorded", () => {
    expect(
      chainChangePayload({ context: { correlation_id: "web-01/AbC-7" } }),
    ).toBeNull();
    expect(chainChangePayload({})).toBeNull();
    expect(chainChangePayload(undefined)).toBeNull();
  });

  it("formats the offset in the unit the reader needs", () => {
    const start = "2026-08-04T10:00:00.000Z";
    expect(chainOffsetLabel(start, start)).toBe("+0ms");
    expect(chainOffsetLabel("2026-08-04T10:00:00.120Z", start)).toBe("+120ms");
    expect(chainOffsetLabel("2026-08-04T10:00:02.500Z", start)).toBe("+2.50s");
    expect(chainOffsetLabel("2026-08-04T10:00:30.000Z", start)).toBe("+30.0s");
  });

  it("gives no offset rather than a fake one for an unparseable time", () => {
    expect(chainOffsetLabel("not-a-date", "2026-08-04T10:00:00.000Z")).toBe("");
  });

  it("names the actor from whichever columns the server sent", () => {
    expect(
      chainActorLabel({
        id: 1,
        action: "a",
        resourceType: "r",
        at: "x",
        actorType: "human",
        actorLabel: "ada@example.com",
      }),
    ).toBe("human · ada@example.com");
    // actorType and actorLabel are both omitempty server-side.
    expect(
      chainActorLabel({ id: 1, action: "a", resourceType: "r", at: "x" }),
    ).toBe("unknown");
  });
});
