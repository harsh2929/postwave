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
  listOutboundWebhooks: vi.fn(),
  navigate: vi.fn(),
  onHandoff: vi.fn(),
  secretActivate: vi.fn(),
  secretResolve: vi.fn(),
}));

vi.mock("../../hooks/useSettingsDraftLifecycle", () => ({
  useDiscardOnlyDraftLifecycle: vi.fn(),
}));

vi.mock("../../components/SubjectLab", () => ({
  SubjectLab: (props: {
    open: boolean;
    onPickVariant: (value: string) => void;
    onRunBandit: (rows: Array<{ text: string }>) => void;
    banditActionLabel?: string;
  }) =>
    props.open ? (
      <div role="dialog" aria-label="Canonical Subject Lab">
        <button
          type="button"
          onClick={() => props.onPickVariant("Canonical selected subject")}
        >
          Pick canonical subject
        </button>
        <button
          type="button"
          onClick={() =>
            props.onRunBandit([
              { text: "Candidate one" },
              { text: "Candidate two" },
              { text: "Candidate three" },
            ])
          }
        >
          {props.banditActionLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("../../lib/api-client", () => ({
  listOutboundWebhooks: mocks.listOutboundWebhooks,
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => true,
}));

vi.mock("../../hooks/useShownOnceSecretLifecycle", () => ({
  useShownOnceSecretLifecycle: () => ({
    activate: mocks.secretActivate,
    resolve: mocks.secretResolve,
  }),
}));

vi.mock("../../components/ai/AgentKeyCard", () => ({
  AgentKeyCard: (props: {
    activePlaintext: string | null;
    onMintedPlaintext: (value: string) => void;
    onPlaintextResolved: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => props.onMintedPlaintext("pw_shown_once")}
      >
        Simulate key mint
      </button>
      {props.activePlaintext ? (
        <button type="button" onClick={props.onPlaintextResolved}>
          Resolve shown key
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("../../components/ai/AgentConnectCard", () => ({
  AgentConnectCard: ({ apiKey }: { apiKey: string }) => (
    <div data-testid="connection-key">
      {apiKey || "placeholder connection key"}
    </div>
  ),
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigate,
  requestDesktopRouteNavigation: mocks.navigate,
}));

import { SubjectLabWorkspace } from "../../components/SubjectLabWorkspace";
import { McpAgentSummary } from "../../components/ai/McpAgentSummary";
import { McpConnectionSetup } from "../../components/mcp/McpConnectionSetup";
import { WebhookAdministrationSummary } from "../../components/settings/WebhookAdministrationSummary";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.navigate.mockResolvedValue("proceeded");
  mocks.onHandoff.mockResolvedValue(true);
  mocks.listOutboundWebhooks.mockResolvedValue({
    data: {
      webhooks: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          url: "https://one.example.test",
          events: ["campaign.sent", "subscriber.added"],
          active: true,
          consecutive_failures: 0,
          signing_algorithm: "hmac_sha256",
          auth_config_status: "ready",
          url_status: "ready",
          delivery_policy_status: "ready",
          created_at: "2026-07-16T00:00:00Z",
          updated_at: "2026-07-16T00:00:00Z",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          url: "https://two.example.test",
          events: ["campaign.sent"],
          active: false,
          consecutive_failures: 5,
          disabled_reason: "auto_failures",
          signing_algorithm: "hmac_sha256",
          auth_config_status: "ready",
          url_status: "ready",
          delivery_policy_status: "ready",
          created_at: "2026-07-16T00:00:00Z",
          updated_at: "2026-07-16T00:00:00Z",
        },
      ],
      next_cursor: "",
    },
  });
});

afterEach(() => {
  if (root) {
    const mountedRoot = root;
    act(() => mountedRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const result = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const result = document.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!result) throw new Error(`Missing input: ${placeholder}`);
  return result;
}

function setInput(element: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
      await act(async () => Promise.resolve());
    }
  }
  throw error;
}

describe("DUX-039 ownership surfaces", () => {
  it("stages canonical Subject Lab candidates and requires explicit campaign handoff", async () => {
    render(
      <SubjectLabWorkspace canMutate onContinueInCampaigns={mocks.onHandoff} />,
    );
    setInput(
      inputByPlaceholder("Type at least 10 characters"),
      "A sufficiently long seed subject",
    );
    act(() => button("Open confidence lab").click());
    act(() => button("Stage top 3 for campaign review").click());

    expect(mocks.onHandoff).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Candidate one");
    expect(document.body.textContent).toContain("Nothing is created or sent");

    act(() => button("Continue in Campaigns").click());
    await waitFor(() => expect(mocks.onHandoff).toHaveBeenCalledTimes(1));
    expect(mocks.onHandoff).toHaveBeenCalledWith({
      subject: "Candidate one",
      body: "",
      stagedSubjects: ["Candidate one", "Candidate two", "Candidate three"],
    });
  });

  it("retains the Subject Lab draft when guarded campaign navigation does not proceed", async () => {
    mocks.onHandoff.mockResolvedValueOnce(false);
    render(
      <SubjectLabWorkspace canMutate onContinueInCampaigns={mocks.onHandoff} />,
    );
    const subjectInput = inputByPlaceholder("Type at least 10 characters");
    setInput(subjectInput, "Keep this subject if navigation is cancelled");
    act(() => button("Continue in Campaigns").click());
    await waitFor(() => expect(mocks.onHandoff).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(button("Continue in Campaigns").disabled).toBe(false),
    );
    expect(subjectInput.value).toContain("Keep this");
  });

  it("contains rejected Subject Lab handoff detail and keeps a retryable draft", async () => {
    mocks.onHandoff.mockRejectedValueOnce(
      new Error("private router trace with customer@example.com"),
    );
    render(
      <SubjectLabWorkspace canMutate onContinueInCampaigns={mocks.onHandoff} />,
    );
    const subjectInput = inputByPlaceholder("Type at least 10 characters");
    setInput(subjectInput, "Keep this subject after a failed handoff");
    act(() => button("Continue in Campaigns").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Handoff did not complete"),
    );
    expect(document.body.textContent).toContain(
      "Your Subject Lab draft is still here",
    );
    expect(document.body.textContent).not.toContain("customer@example.com");
    expect(subjectInput.value).toContain("Keep this subject");
    expect(button("Continue in Campaigns").disabled).toBe(false);
  });

  it("renders Settings webhook health without mutation controls and routes to the owner", async () => {
    render(<WebhookAdministrationSummary />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("2 subscriptions"),
    );

    expect(document.body.textContent).toContain("1 active");
    expect(document.body.textContent).toContain("1 paused");
    expect(document.body.textContent).toContain("1 attention");
    expect(document.body.textContent).not.toContain("Add webhook");
    expect(document.body.textContent).not.toContain("Delete webhook");
    act(() => button("Manage webhooks").click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      section: "webhooks",
      tab: "outbound",
    });
  });

  it("counts legacy-pending receiver state as attention", async () => {
    mocks.listOutboundWebhooks.mockResolvedValueOnce({
      data: {
        webhooks: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            url: "https://one.example.test",
            events: ["campaign.sent"],
            active: true,
            consecutive_failures: 0,
            signing_algorithm: "hmac_sha256",
            auth_config_status: "legacy_pending",
            url_status: "ready",
            delivery_policy_status: "ready",
            created_at: "2026-07-16T00:00:00Z",
            updated_at: "2026-07-16T00:00:00Z",
          },
        ],
        next_cursor: "",
      },
    });

    render(<WebhookAdministrationSummary />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("1 attention"),
    );
  });

  it("labels a bounded canonical webhook summary as a lower bound", async () => {
    mocks.listOutboundWebhooks.mockResolvedValueOnce({
      data: {
        webhooks: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            url: "https://one.example.test",
            events: ["campaign.sent"],
            active: true,
            consecutive_failures: 0,
            signing_algorithm: "hmac_sha256",
            auth_config_status: "ready",
            url_status: "ready",
            delivery_policy_status: "ready",
            created_at: "2026-07-16T00:00:00Z",
            updated_at: "2026-07-16T00:00:00Z",
          },
        ],
        next_cursor: "opaque-page-two",
      },
    });

    render(<WebhookAdministrationSummary />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("1+ subscriptions"),
    );

    expect(document.body.textContent).toContain("1+ active");
    expect(document.body.textContent).toContain(
      "lower bounds from the first 200 subscriptions",
    );
    expect(mocks.listOutboundWebhooks).toHaveBeenCalledWith({ limit: 200 });
  });

  it("mounts release-held MCP copy with only a typed status handoff", async () => {
    render(<McpAgentSummary />);

    expect(document.body.textContent).toContain(
      "mcp_distribution_release_held",
    );
    expect(document.body.textContent).toContain("No runnable setup");
    expect(document.body.textContent).toContain(
      "unsupported private-source evaluation only",
    );
    expect(document.body.textContent).not.toContain("Mint key");
    expect(document.body.textContent).not.toContain("Copy snippet");
    expect(document.body.textContent).not.toContain("Install a client");
    expect(document.body.textContent).not.toContain("full execution history");
    act(() => button("Review MCP release status").click());
    await act(async () => Promise.resolve());
    expect(mocks.navigate.mock.calls).toEqual([
      [{ section: "mcp", tab: "setup" }],
    ]);
  });

  it("keeps MCP credential lifecycle structurally outside the held route", () => {
    render(
      <McpConnectionSetup identityScope="user-1:tenant-1:admin:epoch-1" />,
    );
    expect(document.body.textContent).toContain("placeholder connection key");
    expect(document.body.textContent).toContain("release-held");
    expect(document.body.textContent).not.toContain("Simulate key mint");
    expect(mocks.secretActivate).not.toHaveBeenCalled();
    expect(mocks.secretResolve).not.toHaveBeenCalled();
  });
});
