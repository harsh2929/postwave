/**
 * @vitest-environment happy-dom
 */
//
// Mounting THIS component, which had no render test while its helpers had 19.
//
// An adversarial review showed the cost: three mutations survive the whole
// suite undetected, including one that restores the cross-campaign merge bug
// verbatim. The helpers are thoroughly tested and the wiring that calls them is
// not — the "I tested the helper and believed I tested the wiring" shape this
// ledger keeps recording.
//
// The ledger row said desktop "has NO component-render harness (zero
// @testing-library/react imports anywhere)". The @testing-library half is true
// and irrelevant: 374 test files here already opt into happy-dom and 362
// already render with react-dom/client. The harness was never missing, only the
// library nobody uses — and the row deferred this work as an "app-wide
// infrastructure decision" on that basis. It was one docblock.
//
// So this follows the house pattern rather than inventing one: per-file
// `@vitest-environment happy-dom`, react-dom/client, React 19's `act`.

import { act } from "react";
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

// The component reaches for these two modules; both are replaced so the test
// drives real component behaviour rather than a network or a real bus.
const listAudit = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { listAudit: (...args: unknown[]) => listAudit(...args) },
}));

const subscribers: Array<(msg: unknown) => void> = [];
vi.mock("@/lib/event-bus", () => ({
  useEventBus: () => ({
    subscribe: (_topic: string, handler: (msg: unknown) => void) => {
      subscribers.push(handler);
      return () => {
        const i = subscribers.indexOf(handler);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  }),
}));

const { CampaignActivityFeed } =
  await import("../../components/CampaignActivityFeed");

// The shape `pickAuditRows` narrows to — `actorLabel`, not `actor_email`.
// Getting this wrong the first time produced a failing test against a working
// component, which is a fair warning about how easy the field names are to
// assume.
function auditRow(
  id: string,
  action: string,
  campaignID: string,
  actor: string,
) {
  return {
    id,
    action,
    at: "2026-08-06T10:00:00Z",
    actorType: "human",
    actorLabel: actor,
    resourceType: "campaign",
    resourceId: campaignID,
    metadata: {},
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  listAudit.mockReset();
  subscribers.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(campaignId: string) {
  await act(async () => {
    root.render(<CampaignActivityFeed campaignId={campaignId} />);
  });
}

describe("CampaignActivityFeed", () => {
  it("shows the campaign's back-filled history", async () => {
    listAudit.mockResolvedValue({
      data: {
        data: [
          auditRow("a1", "campaign.updated", "camp-1", "ada@example.test"),
        ],
      },
    });
    await render("camp-1");

    expect(listAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "campaign",
        resourceId: "camp-1",
      }),
    );
    expect(container.textContent).toContain("ada@example.test");
  });

  // The bug this file exists for.
  //
  // The slideover is REUSED: opening it on another campaign changes the prop
  // without unmounting, so `entries` still held the previous campaign's rows
  // and the new campaign's back-fill was merged into them. The panel then
  // attributed one campaign's activity to another, and kept doing so for as
  // long as it stayed open.
  it("does not carry one campaign's history into another", async () => {
    listAudit.mockResolvedValue({
      data: {
        data: [auditRow("a1", "campaign.sent", "camp-1", "ada@example.test")],
      },
    });
    await render("camp-1");
    expect(container.textContent).toContain("ada@example.test");

    listAudit.mockResolvedValue({
      data: {
        data: [auditRow("b1", "campaign.paused", "camp-2", "bob@example.test")],
      },
    });
    await render("camp-2");

    expect(container.textContent).toContain("bob@example.test");
    expect(container.textContent).not.toContain("ada@example.test");
  });

  it("keeps live events for the campaign on screen", async () => {
    listAudit.mockResolvedValue({ data: { data: [] } });
    await render("camp-1");
    expect(subscribers.length).toBeGreaterThan(0);

    // ONE handler: the component subscribes to three topic patterns that share
    // a handler, and the real bus delivers a message to the matching pattern
    // only. Firing all three tripled the rows and said nothing about the
    // component.
    await act(async () => {
      subscribers[0]!({
        topic: "campaign.updated",
        at: "2026-08-06T11:00:00Z",
        payload: { id: "camp-1", actor: "grace@example.test" },
      });
    });
    expect(container.textContent).toContain("grace@example.test");
  });

  it("ignores a live event for a different campaign", async () => {
    listAudit.mockResolvedValue({ data: { data: [] } });
    await render("camp-1");

    await act(async () => {
      subscribers[0]!({
        topic: "campaign.updated",
        at: "2026-08-06T11:00:00Z",
        payload: { id: "camp-999", actor: "mallory@example.test" },
      });
    });
    expect(container.textContent).not.toContain("mallory@example.test");
  });

  // A failed back-fill is silent on purpose — the live bus still works and an
  // error banner on a collapsible side panel would be louder than the loss.
  // Pinned so "silent" cannot quietly become "crashes".
  it("survives a failed back-fill", async () => {
    listAudit.mockResolvedValue({ error: "boom" });
    await expect(render("camp-1")).resolves.toBeUndefined();
    expect(container.textContent).toBeTruthy();
  });
});
