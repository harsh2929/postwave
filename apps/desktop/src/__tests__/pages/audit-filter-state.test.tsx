// @vitest-environment happy-dom

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

vi.mock("../../lib/store", () => ({
  useMe: () => ({ user: "auditor-1", tenant: "tenant-1" }),
}));

import type { AuditFilterState } from "../../pages/audit/useAuditFilterState";
import { useAuditFilterState } from "../../pages/audit/useAuditFilterState";
import { clearAuditFilterSessionState } from "../../pages/audit/audit-page-utils";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: AuditFilterState | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  latest = null;
  localStorage.clear();
  clearAuditFilterSessionState();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  localStorage.clear();
});

function Probe(): ReactElement {
  latest = useAuditFilterState();
  return <output>{latest.filterArgs.action ?? "all"}</output>;
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
}

describe("audit filter state truth", () => {
  it("replaces the complete query when a saved view omits prior fields", () => {
    mount();
    act(() => {
      latest?.setActorType("agent");
      latest?.setActorLabel("prior@example.com");
      latest?.setActionQuery("delete");
      latest?.setResourceType("campaign");
      latest?.setResourceId("campaign-prior");
      latest?.setDays(90);
      latest?.setCategory("destructive");
    });

    act(() => latest?.applySavedView({ actorType: "system", days: 7 }));

    expect(latest?.actorType).toBe("system");
    expect(latest?.actorLabel).toBe("");
    expect(latest?.actionQuery).toBe("");
    expect(latest?.resourceType).toBe("");
    expect(latest?.resourceId).toBe("");
    expect(latest?.days).toBe(7);
    expect(latest?.category).toBe("all");
  });

  it("rejects an invalid saved-view blob without mutating the current query", () => {
    mount();
    act(() => {
      latest?.setActorLabel("current@example.com");
      latest?.setResourceType("list");
    });

    act(() =>
      latest?.applySavedView({
        actorType: "owner",
        unknownField: "surprise",
      }),
    );

    expect(latest?.actorLabel).toBe("current@example.com");
    expect(latest?.resourceType).toBe("list");
  });
});
