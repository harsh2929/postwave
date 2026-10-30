// @vitest-environment happy-dom

import axe from "axe-core";
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

import type { InboundRoute } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    inboundRouteActionRunsList: mocks.listRuns,
  },
}));

import { ActionRunsPanel } from "../../components/inbound/ActionRunsPanel";
import { InboundRoutesTable } from "../../pages/inbound-routes/InboundRoutesTable";

const ROUTE: InboundRoute = {
  id: "route-complete-identifier-001",
  name: "Support triage",
  priority: 10,
  stop_on_match: true,
  enabled: true,
  match_recipient: "support@*",
  match_subject_prefix: "[urgent]",
  match_from_domain: "customer.example.test",
  actions: [
    {
      kind: "webhook",
      url: "https://user:password@private.example.test/hooks/token/private-query",
    },
  ],
  last_matched_at: "2026-07-16T08:30:00.000Z",
  match_count: 1_250,
  updated_at: "2026-08-30T10:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRuns.mockResolvedValue({
    data: {
      runs: [
        {
          id: 917,
          route_id: ROUTE.id,
          match_id: 312,
          action_index: 0,
          action_kind: "webhook",
          status: "failed",
          attempts: 3,
          http_status: 401,
          response_snippet:
            '{"client_secret":"private-secret-value","status":"denied"}',
          error_message:
            "receiver https://private.internal token=private-bearer-value",
          duration_ms: 842,
          executed_at: "2026-07-16T08:30:01.000Z",
        },
      ],
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
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
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("inbound route interaction maturity", () => {
  it("renders semantic order evidence without disclosing webhook destinations", async () => {
    render(
      <InboundRoutesTable
        rows={[ROUTE]}
        loading={false}
        canAdmin
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onMove={vi.fn()}
        onDuplicate={vi.fn()}
        onReorder={vi.fn()}
        activeOperations={new Set([`route:${ROUTE.id}:toggle`])}
      />,
    );

    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector('th[scope="row"]')?.textContent).toContain(
      "Support triage",
    );
    expect(document.body.textContent).toContain("Stop after match");
    expect(document.body.textContent).toContain("1,250");
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-07-16T08:30:00.000Z",
    );
    expect(document.body.innerHTML).not.toContain("private-query");
    expect(document.body.innerHTML).not.toContain("private.example.test");
    expect(container?.querySelector("[title]")).toBeNull();
    expect(button("Edit").disabled).toBe(false);
    expect(button("Edit").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Wait for the current change to Support triage to finish.",
    );

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("classifies action failures and locally redacts response evidence", async () => {
    render(<ActionRunsPanel matchID={312} />);
    await flush();

    expect(document.body.textContent).toContain(
      "destination rejected its configured authentication",
    );
    expect(document.body.textContent).toContain("917");
    expect(document.body.textContent).toContain(ROUTE.id);
    expect(document.body.textContent).toContain("[REDACTED]");
    expect(document.body.textContent).not.toContain("private-secret-value");
    expect(document.body.textContent).not.toContain("private-bearer-value");
    expect(document.body.textContent).not.toContain("private.internal");
    expect(container?.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains action-run transport failures and retries safely", async () => {
    mocks.listRuns
      .mockRejectedValueOnce(
        new Error("private database host and recipient@example.test"),
      )
      .mockResolvedValueOnce({ data: { runs: [] } });
    render(<ActionRunsPanel matchID={312} />);
    await flush();

    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private database host");
    act(() => button("Retry").click());
    await flush();
    expect(mocks.listRuns).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "No action outcomes are present in this verified record",
    );
  });
});
