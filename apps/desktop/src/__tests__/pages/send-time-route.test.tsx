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

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  canWrite: true,
  me: { tenant: "tenant-a" } as { tenant: string } | null,
  workspace: {
    enabled: true,
    state: { kind: "ready", enabled: true },
  } as Record<string, unknown>,
  audience: {
    catalog: { kind: "ready", segments: [] },
    signal: { kind: "unscoped" },
  } as Record<string, unknown>,
  subscriber: { marker: "subscriber-controller" } as Record<string, unknown>,
  scheduling: { marker: "scheduling-controller" } as Record<string, unknown>,
  workspaceArgs: vi.fn(),
  audienceArgs: vi.fn(),
  subscriberArgs: vi.fn(),
  schedulingArgs: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useCanWrite: () => mocks.canWrite,
  useMe: () => mocks.me,
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({
    eyebrow,
    title,
    subtitle,
    meta,
  }: {
    eyebrow: string;
    title: string;
    subtitle: string;
    meta: ReactElement;
  }) => (
    <header>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {meta}
    </header>
  ),
}));

vi.mock("../../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("../../components/sendtime/useSendTimeControllers", () => ({
  useSendTimeWorkspaceSetting: (args: unknown) => {
    mocks.workspaceArgs(args);
    return mocks.workspace;
  },
  useSendTimeAudienceSignals: (identityKey: string) => {
    mocks.audienceArgs(identityKey);
    return mocks.audience;
  },
  useSubscriberSendTimeLookup: (identityKey: string) => {
    mocks.subscriberArgs(identityKey);
    return mocks.subscriber;
  },
}));

vi.mock("../../components/sendtime/SendTimeWorkspacePolicy", () => ({
  SendTimeWorkspacePolicy: ({ canAdmin }: { canAdmin: boolean }) => (
    <section data-testid="workspace-policy">
      {canAdmin ? "admin policy" : "read-only policy"}
    </section>
  ),
}));

vi.mock("../../components/sendtime/SendTimeAudiencePanel", () => ({
  SendTimeAudiencePanel: () => (
    <section data-testid="audience-panel">Audience panel</section>
  ),
}));

vi.mock("../../components/sendtime/SendTimeSubscriberInspector", () => ({
  SendTimeSubscriberInspector: () => (
    <section data-testid="subscriber-inspector">Subscriber inspector</section>
  ),
}));

vi.mock("../../components/sendtime/SendTimeScheduling", () => ({
  CampaignScheduleCard: ({
    stoEnabled,
    canWrite,
  }: {
    stoEnabled: boolean;
    canWrite: boolean;
  }) => (
    <section data-testid="campaign-scheduling">
      {stoEnabled ? "default enabled" : "default disabled"} ·{" "}
      {canWrite ? "writer" : "viewer"}
    </section>
  ),
  useSendTimeCampaignScheduling: (
    enabled: boolean,
    canWrite: boolean,
    identityKey: string,
  ) => {
    mocks.schedulingArgs(enabled, canWrite, identityKey);
    return mocks.scheduling;
  },
}));

import { SendTime } from "../../pages/SendTime";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.canWrite = true;
  mocks.me = { tenant: "tenant-a" };
  mocks.workspace = {
    enabled: true,
    state: { kind: "ready", enabled: true },
  };
  mocks.audience = {
    catalog: { kind: "ready", segments: [] },
    signal: { kind: "unscoped" },
  };
});

afterEach(() => {
  if (root) {
    const mountedRoot = root;
    act(() => mountedRoot.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

describe("Send-time route composition", () => {
  it("assembles the complete, scoped workflow and keeps activation visibly locked", () => {
    render(<SendTime />);

    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(text()).toContain("Send-time intelligence");
    expect(text()).toContain("Analysis · Scope required");
    expect(text()).toContain("New campaigns: on");
    expect(text()).toContain("Delivery · Locked");
    expect(text()).toContain("Choose one saved segment");
    expect(text()).toContain("Release gate in progress");
    expect(text()).toContain("Subscriber inspection is confidential");
    expect(
      document.querySelector("[data-testid='workspace-policy']"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid='audience-panel']"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid='subscriber-inspector']"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid='campaign-scheduling']"),
    ).not.toBeNull();

    expect(mocks.workspaceArgs).toHaveBeenCalledWith({
      canAdmin: true,
      identityKey: "tenant-a",
    });
    expect(mocks.audienceArgs).toHaveBeenCalledWith("tenant-a");
    expect(mocks.subscriberArgs).toHaveBeenCalledWith("tenant-a");
    expect(mocks.schedulingArgs).toHaveBeenCalledWith(true, true, "tenant-a");
  });

  it.each([
    [{ kind: "loading" }, { kind: "unscoped" }, "Loading scopes"],
    [{ kind: "error" }, { kind: "unscoped" }, "Catalog unavailable"],
    [{ kind: "ready" }, { kind: "ready" }, "Measured"],
    [{ kind: "ready" }, { kind: "loading" }, "Analyzing"],
    [{ kind: "ready" }, { kind: "insufficient" }, "Learning"],
    [{ kind: "ready" }, { kind: "error" }, "Unavailable"],
    [{ kind: "ready" }, { kind: "unscoped" }, "Scope required"],
  ])("labels catalog %o and signal %o as %s", (catalog, signal, expected) => {
    mocks.audience = { catalog, signal };
    render(<SendTime />);

    expect(text()).toContain(`Analysis · ${expected}`);
  });

  it("fails closed when identity and the workspace default are unresolved", () => {
    mocks.canAdmin = false;
    mocks.canWrite = false;
    mocks.me = null;
    mocks.workspace = {
      enabled: false,
      state: { kind: "error", message: "Unavailable" },
    };

    render(<SendTime />);

    expect(text()).toContain("Default unverified");
    expect(text()).toContain("read-only policy");
    expect(text()).toContain("default disabled · viewer");
    expect(mocks.workspaceArgs).toHaveBeenCalledWith({
      canAdmin: false,
      identityKey: "identity-unresolved",
    });
    expect(mocks.schedulingArgs).toHaveBeenCalledWith(
      false,
      false,
      "identity-unresolved",
    );
  });

  it("distinguishes a verified disabled default from an unverified setting", () => {
    mocks.workspace = {
      enabled: false,
      state: { kind: "ready", enabled: false },
    };

    render(<SendTime />);

    expect(text()).toContain("New campaigns: off");
    expect(text()).not.toContain("Default unverified");
  });
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function text(): string {
  return document.body.textContent ?? "";
}
