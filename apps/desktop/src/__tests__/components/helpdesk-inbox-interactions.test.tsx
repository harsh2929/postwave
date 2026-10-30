// @vitest-environment happy-dom

import axe from "axe-core";
import { act, useState } from "react";
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

import type {
  ServiceConversation,
  ServiceMacro,
  ServiceMessage,
  ServiceSuiteCatalog,
  ServiceTicket,
} from "../../lib/api-client";
import serviceSuiteCatalogFixture from "../../../../web/src/__tests__/fixtures/api/service-suite_catalog.json";

const mocks = vi.hoisted(() => ({
  canAdmin: false,
  apiBaseUrl: "https://api.example.test/gateway",
  notePrincipal: null as {
    apiBaseUrl: string;
    apiIdentityGeneration: number;
    user: string;
    tenant: string;
  } | null,
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  listMessages: vi.fn(),
  listTickets: vi.fn(),
  listMacros: vi.fn(),
  postInternalNote: vi.fn(),
  assign: vi.fn(),
  setStatus: vi.fn(),
  notePrepare: vi.fn(),
  noteReviewExactReplay: vi.fn(),
  noteMarkUnknown: vi.fn(),
  noteSettle: vi.fn(),
  noteHeld: vi.fn(),
  noteOutcomeUnknown: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  sessionAuthority: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  readNoteRecoveryPrincipal: () => mocks.notePrincipal,
  useCanAdmin: () => mocks.canAdmin,
}));
vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => mocks.apiBaseUrl,
  serviceSuiteApi: {
    listConversations: mocks.listConversations,
    getConversation: mocks.getConversation,
    listMessages: mocks.listMessages,
    listTickets: mocks.listTickets,
    listMacros: mocks.listMacros,
    postInternalNote: mocks.postInternalNote,
    assign: mocks.assign,
    setStatus: mocks.setStatus,
  },
}));
vi.mock("../../components/helpdesk/internal-note-recovery", () => ({
  canonicalNoteRecoveryApiBaseUrl: (value: unknown) =>
    typeof value === "string" ? value.replace(/\/+$/u, "") : null,
  internalNoteRecovery: {
    prepare: mocks.notePrepare,
    reviewExactReplay: mocks.noteReviewExactReplay,
    markUnknown: mocks.noteMarkUnknown,
    settle: mocks.noteSettle,
    hasHeldConversation: mocks.noteHeld,
  },
  sessionNoteRecoveryAuthority: mocks.sessionAuthority,
  internalNoteOutcomeIsUnknown: mocks.noteOutcomeUnknown,
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { HelpdeskInbox } from "../../components/helpdesk/HelpdeskInbox";
import {
  beginApiIdentityTransition,
  releaseApiIdentityTransition,
  resetApiIdentityTransitionForTests,
} from "../../lib/api-identity-transition";
import { resetInternalNoteOperationExclusionForTests } from "../../lib/helpdesk-internal-note-operation";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const MACRO_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_USER_ID = "55555555-5555-4555-8555-555555555555";
const API_BASE_URL = "https://api.example.test/gateway";
const VERSION = "2026-08-24T00:00:00Z";
const page = {
  has_more: false,
  next_cursor: null,
  as_of: "2026-08-24T00:00:00Z",
  consistency: "mutable_window",
  may_reorder: true,
};
const messagePage = { ...page, consistency: "created_at_window" };

const conversation: ServiceConversation = {
  id: CONVERSATION_ID,
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  version: VERSION,
  channel_type: "web_chat",
  source_type: "web_chat",
  requester_email: "reader@example.test",
  subject: "Need help",
  status: "open",
  priority: "normal",
  assignment_state: "unassigned",
  created_at: VERSION,
  updated_at: VERSION,
};

const message: ServiceMessage = {
  id: MESSAGE_ID,
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  conversation_id: CONVERSATION_ID,
  source_type: "manual",
  direction: "internal",
  sender_type: "agent",
  body_text: "First verified internal record",
  record_kind: "internal_note",
  delivery_status: "not_applicable",
  attachment_count: 0,
  projection_truncated: false,
  sent_at: VERSION,
  created_at: VERSION,
};

function macroRecord(index: number, name = `Macro ${index}`): ServiceMacro {
  const prefix = index.toString(16).padStart(8, "0");
  return {
    id: `${prefix}-0000-4000-8000-000000000000`,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    version: VERSION,
    name,
    body: `Verified body ${index}`,
    status: "active",
    usage_evidence_status: "unverified",
    created_at: VERSION,
    updated_at: VERSION,
  };
}

function ticketRecord(index: number): ServiceTicket {
  const prefix = index.toString(16).padStart(8, "0");
  return {
    id: `${prefix}-0000-4000-8000-000000000000`,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    version: VERSION,
    conversation_id: CONVERSATION_ID,
    ticket_number: index,
    title: `Ticket ${index}`,
    status: "open",
    priority: "normal",
    assignment_state: "unassigned",
    source_channel: "web_chat",
    due_at: "2099-08-24T00:00:00Z",
    created_at: VERSION,
    updated_at: VERSION,
  };
}

const catalog = serviceSuiteCatalogFixture as ServiceSuiteCatalog;

function testRecoveryAuthority(
  apiBaseUrl = API_BASE_URL,
  user = SESSION_USER_ID,
) {
  return {
    apiBaseUrl,
    apiIdentityGeneration: 0,
    legacyV2Scope: `legacy:${user}:${TENANT_ID}`,
    scope: `scope:${apiBaseUrl}:${user}:${TENANT_ID}`,
    tenant: TENANT_ID,
    user,
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetApiIdentityTransitionForTests();
  resetInternalNoteOperationExclusionForTests();
  mocks.canAdmin = false;
  mocks.apiBaseUrl = API_BASE_URL;
  mocks.notePrincipal = {
    apiBaseUrl: API_BASE_URL,
    apiIdentityGeneration: 0,
    user: SESSION_USER_ID,
    tenant: TENANT_ID,
  };
  for (const [name, mock] of Object.entries(mocks)) {
    if (name !== "canAdmin" && typeof mock === "function") mock.mockReset();
  }
  mocks.listConversations.mockResolvedValue({
    data: { tenantId: TENANT_ID, items: [conversation], page },
  });
  mocks.getConversation.mockResolvedValue({ data: conversation });
  mocks.listMessages.mockResolvedValue({
    data: { tenantId: TENANT_ID, items: [], page: messagePage },
  });
  mocks.listTickets.mockResolvedValue({
    data: { tenantId: TENANT_ID, items: [], page },
  });
  mocks.listMacros.mockResolvedValue({
    data: {
      tenantId: TENANT_ID,
      items: [
        {
          id: MACRO_ID,
          tenantId: TENANT_ID,
          tenant_id: TENANT_ID,
          version: VERSION,
          name: "Welcome",
          body: "Thanks for contacting us.",
          status: "active",
          usage_evidence_status: "unverified",
          created_at: VERSION,
          updated_at: VERSION,
        },
      ],
      page,
    },
  });
  mocks.notePrepare.mockResolvedValue({
    status: "ready",
    signature: "signature",
    idempotencyKey: "note-key",
  });
  mocks.noteSettle.mockResolvedValue(true);
  mocks.noteReviewExactReplay.mockResolvedValue({
    status: "held",
    reason: "unresolved-intent",
  });
  mocks.noteMarkUnknown.mockResolvedValue(true);
  mocks.noteHeld.mockResolvedValue("clear");
  mocks.noteOutcomeUnknown.mockReturnValue(false);
  mocks.sessionAuthority.mockImplementation(
    (
      user: unknown,
      tenant: unknown,
      apiBaseUrl: unknown,
      apiIdentityGeneration: unknown,
    ) =>
      typeof user === "string" &&
      typeof tenant === "string" &&
      typeof apiBaseUrl === "string" &&
      typeof apiIdentityGeneration === "number"
        ? {
            apiBaseUrl,
            apiIdentityGeneration,
            legacyV2Scope: `legacy:${user}:${tenant}`,
            scope: `scope:${apiBaseUrl}:${user}:${tenant}`,
            tenant,
            user,
          }
        : null,
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

async function renderAndSelect(
  noteRecoveryAuthority: ReturnType<
    typeof testRecoveryAuthority
  > | null = testRecoveryAuthority(),
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  function Host() {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <HelpdeskInbox
        catalog={catalog}
        tenantId={TENANT_ID}
        identityScope={`${TENANT_ID}:user-1:admin:epoch-1`}
        noteRecoveryAuthority={noteRecoveryAuthority}
        accessAllowed={mocks.canAdmin}
        catalogVerified
        selectedConversationId={selected}
        statusFilter={null}
        onSelectedConversationChange={setSelected}
        onStatusFilterChange={() => undefined}
      />
    );
  }
  act(() => root?.render(<Host />));
  await settle();
  const row = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes("reader@example.test"));
  act(() => row?.click());
  await settle();
  await settle();
}

function labelledControl(
  label: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const id = owner?.htmlFor;
  const control = id ? document.getElementById(id) : null;
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLTextAreaElement) &&
    !(control instanceof HTMLSelectElement)
  ) {
    throw new Error(`Missing control ${label}`);
  }
  return control;
}

describe("HelpdeskInbox interactions", () => {
  it("does not request or render protected records outside exact admin access", async () => {
    await renderAndSelect();
    expect(document.body.textContent).toContain("Inbox records are admin-only");
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(mocks.listTickets).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[title]").length).toBe(0);
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("withholds a queue page from a different cursor window", async () => {
    mocks.canAdmin = true;
    const firstPage = { ...page, has_more: true, next_cursor: "queue-next" };
    const secondConversation = {
      ...conversation,
      id: "55555555-5555-4555-8555-555555555555",
      requester_email: "second@example.test",
    };
    mocks.listConversations
      .mockResolvedValueOnce({
        data: { tenantId: TENANT_ID, items: [conversation], page: firstPage },
      })
      .mockResolvedValueOnce({
        data: {
          tenantId: TENANT_ID,
          items: [secondConversation],
          page: {
            ...page,
            as_of: "2026-08-24T00:00:01Z",
          },
        },
      });
    await renderAndSelect();
    const loadMore = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Load older queue records");
    await act(async () => loadMore?.click());
    await vi.waitFor(() =>
      expect(mocks.listConversations).toHaveBeenCalledTimes(2),
    );
    expect(document.body.textContent).toContain(
      "did not share the first verified cursor window",
    );
    expect(document.body.textContent).not.toContain("second@example.test");
  });

  it("treats a cross-page queue duplicate as an explicit partial window", async () => {
    mocks.canAdmin = true;
    const firstPage = { ...page, has_more: true, next_cursor: "queue-next" };
    mocks.listConversations
      .mockResolvedValueOnce({
        data: { tenantId: TENANT_ID, items: [conversation], page: firstPage },
      })
      .mockResolvedValueOnce({
        data: { tenantId: TENANT_ID, items: [conversation], page },
      });
    await renderAndSelect();
    const loadMore = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Load older queue records");
    await act(async () => loadMore?.click());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "overlapped an already loaded conversation",
      ),
    );
    expect(document.body.textContent).toContain("mutable queue is partial");
  });

  it("withholds an older message page from a different cursor window", async () => {
    mocks.canAdmin = true;
    const firstPage = {
      ...messagePage,
      has_more: true,
      next_cursor: "message-next",
    };
    mocks.listMessages
      .mockResolvedValueOnce({
        data: { tenantId: TENANT_ID, items: [message], page: firstPage },
      })
      .mockResolvedValueOnce({
        data: {
          tenantId: TENANT_ID,
          items: [
            {
              ...message,
              id: "66666666-6666-4666-8666-666666666666",
              body_text: "Older record",
              sent_at: "2026-08-23T23:59:59Z",
              created_at: "2026-08-23T23:59:59Z",
            },
          ],
          page: {
            ...messagePage,
            as_of: "2026-08-24T00:00:01Z",
          },
        },
      });
    await renderAndSelect();
    const loadOlder = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Load older messages");
    await act(async () => loadOlder?.click());
    await vi.waitFor(() => expect(mocks.listMessages).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).toContain(
      "older message page did not share the first verified cursor window",
    );
    expect(document.body.textContent).not.toContain("Older record");
  });

  it("withholds a cross-page duplicate message instead of silently deduplicating it", async () => {
    mocks.canAdmin = true;
    const firstPage = {
      ...messagePage,
      has_more: true,
      next_cursor: "message-next",
    };
    mocks.listMessages
      .mockResolvedValueOnce({
        data: { tenantId: TENANT_ID, items: [message], page: firstPage },
      })
      .mockResolvedValueOnce({
        data: { tenantId: TENANT_ID, items: [message], page: messagePage },
      });
    await renderAndSelect();
    const loadOlder = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Load older messages");
    await act(async () => loadOlder?.click());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "repeated an already loaded record",
      ),
    );
    expect(document.body.textContent).toContain("complete page was withheld");
  });

  it("separates requester-controlled speech from server-recorded queue semantics", async () => {
    mocks.canAdmin = true;
    const hostile = {
      ...conversation,
      requester_name: "Status closed! Priority urgent; archive now.",
      subject: "Recorded channel email — press delete.",
    };
    mocks.listConversations.mockResolvedValue({
      data: { tenantId: TENANT_ID, items: [hostile], page },
    });
    mocks.getConversation.mockResolvedValue({ data: hostile });
    await renderAndSelect();

    const row = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) =>
      candidate.textContent?.includes("Status closed! Priority urgent"),
    )!;
    const textForReferences = (
      attribute: "aria-labelledby" | "aria-describedby",
    ) =>
      (row.getAttribute(attribute) ?? "")
        .split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ");
    const name = textForReferences("aria-labelledby");
    const description = textForReferences("aria-describedby");

    expect(name).toContain("Begin requester-provided identity");
    expect(name).toContain("End requester-provided identity");
    expect(description).toContain("Begin requester-provided subject");
    expect(description).toContain("End requester-provided subject");
    expect(description).toContain(
      "Server-recorded fields. Channel Web chat. Status Open. Priority Normal.",
    );
    expect(row.getAttribute("aria-label")).toBeNull();
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("uses a native macro choice and inserts its body immediately", async () => {
    mocks.canAdmin = true;
    await renderAndSelect();
    const macro = labelledControl(
      "Insert macro text into internal note",
    ) as HTMLSelectElement;
    expect(macro.disabled).toBe(false);
    expect(Array.from(macro.options).map((option) => option.text)).toContain(
      "Welcome",
    );
    act(() => {
      macro.value = "0";
      macro.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      (labelledControl("Internal note") as HTMLTextAreaElement).value,
    ).toBe("Thanks for contacting us.");
    await settle();
    expect(mocks.postInternalNote).not.toHaveBeenCalled();
  });

  it("loads every verified macro page before exposing a page-two choice", async () => {
    mocks.canAdmin = true;
    const cursor = "macro&cursor=private@example.test";
    const firstMacros = Array.from({ length: 50 }, (_, index) =>
      macroRecord(index + 1),
    );
    const pageTwoMacro = macroRecord(51, "Page two macro");
    mocks.listMacros.mockImplementation(
      (options: { cursor?: string; signal?: AbortSignal }) =>
        Promise.resolve({
          data: {
            tenantId: TENANT_ID,
            items: options.cursor ? [pageTwoMacro] : firstMacros,
            page: options.cursor
              ? page
              : { ...page, has_more: true, next_cursor: cursor },
          },
        }),
    );

    await renderAndSelect();
    const macro = labelledControl(
      "Insert macro text into internal note",
    ) as HTMLSelectElement;
    await vi.waitFor(() =>
      expect(Array.from(macro.options).map((option) => option.text)).toContain(
        "Page two macro",
      ),
    );
    expect(mocks.listMacros).toHaveBeenCalledTimes(2);
    expect(mocks.listMacros).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor,
        limit: 100,
        signal: expect.anything(),
      }),
    );
    act(() => {
      macro.value = "50";
      macro.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      (labelledControl("Internal note") as HTMLTextAreaElement).value,
    ).toBe("Verified body 51");
  });

  it.each([
    {
      name: "cursor-window drift",
      secondItems: [macroRecord(2)],
      secondPage: { ...page, as_of: "2026-08-24T00:00:01Z" },
      expected: "changed its verified window",
    },
    {
      name: "a cross-page duplicate",
      secondItems: [macroRecord(1)],
      secondPage: page,
      expected: "repeated a record",
    },
  ])("withholds the complete macro picker after $name", async (scenario) => {
    mocks.canAdmin = true;
    mocks.listMacros
      .mockResolvedValueOnce({
        data: {
          tenantId: TENANT_ID,
          items: [macroRecord(1)],
          page: { ...page, has_more: true, next_cursor: "macro-next" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          tenantId: TENANT_ID,
          items: scenario.secondItems,
          page: scenario.secondPage,
        },
      });

    await renderAndSelect();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(scenario.expected),
    );
    expect(document.body.textContent).toContain(
      "No partial macro picker was exposed",
    );
    const macro = labelledControl(
      "Insert macro text into internal note",
    ) as HTMLSelectElement;
    expect(macro.disabled).toBe(true);
    expect(Array.from(macro.options).map((option) => option.text)).toEqual([
      "Macro list unavailable",
    ]);
  });

  it("bounds macro pagination and exposes a retry that rebuilds a complete picker", async () => {
    mocks.canAdmin = true;
    let pageNumber = 0;
    mocks.listMacros.mockImplementation(() => {
      pageNumber += 1;
      return Promise.resolve({
        data: {
          tenantId: TENANT_ID,
          items: [macroRecord(pageNumber)],
          page: {
            ...page,
            has_more: true,
            next_cursor: `macro-page-${pageNumber + 1}`,
          },
        },
      });
    });

    await renderAndSelect();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "macro list exceeded the bounded verification page limit",
      ),
    );
    expect(mocks.listMacros).toHaveBeenCalledTimes(20);
    expect(
      (
        labelledControl(
          "Insert macro text into internal note",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);

    mocks.listMacros.mockReset();
    mocks.listMacros.mockResolvedValue({
      data: {
        tenantId: TENANT_ID,
        items: [macroRecord(99, "Recovered complete macro")],
        page,
      },
    });
    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (candidate) => candidate.textContent === "Retry complete macro list",
    )!;
    act(() => retry.click());
    await vi.waitFor(() =>
      expect(
        Array.from(
          (
            labelledControl(
              "Insert macro text into internal note",
            ) as HTMLSelectElement
          ).options,
        ).map((option) => option.text),
      ).toContain("Recovered complete macro"),
    );
    expect(mocks.listMacros).toHaveBeenCalledTimes(1);
  });

  it("paginates tenant and conversation-bound tickets before presenting timing", async () => {
    mocks.canAdmin = true;
    const cursor = "ticket&cursor=private@example.test";
    const pageTwoTicket = ticketRecord(51);
    mocks.listTickets.mockImplementation(
      (options: {
        conversationId?: string;
        cursor?: string;
        signal?: AbortSignal;
      }) =>
        Promise.resolve({
          data: {
            tenantId: TENANT_ID,
            items: options.cursor ? [pageTwoTicket] : [],
            page: options.cursor
              ? page
              : { ...page, has_more: true, next_cursor: cursor },
          },
        }),
    );

    await renderAndSelect();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Recorded due in"),
    );
    expect(
      mocks.listTickets.mock.calls.some(
        ([options]) =>
          options?.conversationId === CONVERSATION_ID &&
          options?.cursor === cursor &&
          options?.limit === 100,
      ),
    ).toBe(true);
    expect(
      mocks.listTickets.mock.calls.some(
        ([options]) =>
          !options?.conversationId &&
          options?.cursor === cursor &&
          options?.limit === 100,
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain(
      "Ticket due-date coverage is partial",
    );
  });

  it.each([
    {
      name: "a cursor page changes windows",
      firstItems: [] as ServiceTicket[],
      secondItems: [ticketRecord(51)],
      secondPage: { ...page, as_of: "2026-08-24T00:00:01Z" },
      expected: "ticket cursor page changed its verified window",
      dueLabel: "Due date unverified",
    },
    {
      name: "a cursor page repeats a ticket",
      firstItems: [ticketRecord(1)],
      secondItems: [ticketRecord(1)],
      secondPage: page,
      expected: "ticket cursor page repeated a record",
      dueLabel: "1+ linked ticket records",
    },
  ])("marks ticket timing partial when $name", async (scenario) => {
    mocks.canAdmin = true;
    mocks.listTickets.mockImplementation((options: { cursor?: string }) =>
      Promise.resolve({
        data: {
          tenantId: TENANT_ID,
          items: options.cursor ? scenario.secondItems : scenario.firstItems,
          page: options.cursor
            ? scenario.secondPage
            : { ...page, has_more: true, next_cursor: "ticket-next" },
        },
      }),
    );

    await renderAndSelect();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(scenario.expected),
    );
    expect(document.body.textContent).toContain(
      "Current verification is partial",
    );
    expect(
      document.querySelector(".helpdesk-thread-due-date")?.textContent,
    ).toContain(scenario.dueLabel);
    expect(document.body.textContent).not.toContain("Recorded due in");
  });

  it("moves focus into a selected thread and restores the queue row on return", async () => {
    mocks.canAdmin = true;
    await renderAndSelect();

    const heading = Array.from(document.querySelectorAll("h2")).find(
      (candidate) => candidate.textContent === "reader@example.test",
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));

    const back = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.trim() === "← Queue");
    act(() => back?.click());

    const selectedRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) =>
      candidate.textContent?.includes("reader@example.test"),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(selectedRow));
  });

  it("refreshes a bounded latest window, keeps focus, and retains verified records on a partial refresh", async () => {
    mocks.canAdmin = true;
    const newest: ServiceMessage = {
      id: MESSAGE_ID,
      tenantId: TENANT_ID,
      tenant_id: TENANT_ID,
      conversation_id: CONVERSATION_ID,
      source_type: "web_chat",
      direction: "inbound",
      sender_type: "customer",
      sender: "Customer",
      body_text: "A newly recorded message",
      record_kind: "inbound_record",
      delivery_status: "received",
      attachment_count: 0,
      projection_truncated: false,
      sent_at: "2026-08-24T09:35:00Z",
      created_at: "2026-08-24T09:35:00Z",
    };
    await renderAndSelect();
    const refresh = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Refresh latest")!;
    mocks.listMessages.mockResolvedValueOnce({
      data: { tenantId: TENANT_ID, items: [newest], page: messagePage },
    });

    await act(async () => {
      refresh.focus();
      refresh.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("A newly recorded message"),
    );
    expect(document.activeElement).toBe(refresh);
    expect(mocks.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );

    mocks.listMessages.mockResolvedValueOnce({
      error: { kind: "network", message: "refresh interrupted" },
    });
    await act(async () => {
      refresh.focus();
      refresh.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Latest window is partial"),
    );
    expect(document.body.textContent).toContain("A newly recorded message");
    expect(document.activeElement).toBe(refresh);
  });

  it("reuses the reviewed encrypted note key and holds a 410 result indefinitely", async () => {
    mocks.canAdmin = true;
    mocks.noteHeld.mockResolvedValue("held");
    mocks.noteReviewExactReplay.mockResolvedValue({
      status: "ready",
      signature: "prior-signature",
      idempotencyKey: "original-note-key",
    });
    mocks.noteOutcomeUnknown.mockReturnValue(true);
    mocks.postInternalNote.mockResolvedValue({
      error: {
        kind: "http",
        status: 410,
        code: "internal_note_result_unavailable",
        message: "result erased",
      },
    });
    await renderAndSelect();
    const review = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Review same-key replay")!;
    act(() => review.click());

    const note = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(note, "Exact prior confidential note");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const reconcile = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Reconcile internal note")!;
    act(() => reconcile.click());

    await vi.waitFor(() =>
      expect(mocks.postInternalNote).toHaveBeenCalledWith(
        CONVERSATION_ID,
        { body_text: "Exact prior confidential note" },
        "original-note-key",
      ),
    );
    expect(mocks.notePrepare).not.toHaveBeenCalled();
    expect(mocks.noteMarkUnknown).toHaveBeenCalledWith(
      testRecoveryAuthority().scope,
      "prior-signature",
    );
    expect(mocks.noteSettle).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Automatic retry and replacement keys are blocked",
      ),
    );
  });

  it("retains the original key when a 2xx note response cannot be parsed", async () => {
    mocks.canAdmin = true;
    mocks.noteOutcomeUnknown.mockImplementation(
      (error: { kind?: string }) => error.kind === "parse",
    );
    mocks.postInternalNote.mockResolvedValue({
      error: { kind: "parse", message: "invalid JSON" },
    });
    await renderAndSelect();
    const note = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(note, "Commit-ambiguous private note");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent === "Add internal note")
        ?.click(),
    );

    await vi.waitFor(() =>
      expect(mocks.noteMarkUnknown).toHaveBeenCalledWith(
        testRecoveryAuthority().scope,
        "signature",
      ),
    );
    expect(mocks.noteSettle).not.toHaveBeenCalled();
    expect(mocks.postInternalNote).toHaveBeenCalledTimes(1);
  });

  it("labels a successful reviewed replay as confirmation, never a newly added note", async () => {
    mocks.canAdmin = true;
    mocks.noteHeld.mockResolvedValue("held");
    mocks.noteReviewExactReplay.mockResolvedValue({
      status: "ready",
      signature: "prior-signature",
      idempotencyKey: "original-note-key",
    });
    mocks.postInternalNote.mockResolvedValue({
      data: {
        id: MESSAGE_ID,
        tenantId: TENANT_ID,
        tenant_id: TENANT_ID,
        conversation_id: CONVERSATION_ID,
        source_type: "manual",
        direction: "internal",
        sender_type: "agent",
        body_text: "Exact prior confidential note",
        record_kind: "internal_note",
        delivery_status: "not_applicable",
        attachment_count: 0,
        projection_truncated: false,
        sent_at: "2026-08-24T09:35:00Z",
        created_at: "2026-08-24T09:35:00Z",
      },
    });
    await renderAndSelect();
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent === "Review same-key replay")
        ?.click(),
    );
    const note = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(note, "Exact prior confidential note");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find(
          (candidate) => candidate.textContent === "Reconcile internal note",
        )
        ?.click(),
    );

    await vi.waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Earlier internal note confirmed — customer delivery was not attempted",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining("Internal note added"),
    );
  });

  it("requires a cancel-first keyboard review before a terminal status change", async () => {
    mocks.canAdmin = true;
    const nextVersion = "2026-08-24T00:00:01Z";
    mocks.setStatus.mockResolvedValue({
      data: {
        ...conversation,
        status: "closed",
        version: nextVersion,
        updated_at: nextVersion,
      },
    });
    await renderAndSelect();
    const status = labelledControl("Conversation status") as HTMLSelectElement;
    const chooseClosed = (): void => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set?.call(status, "closed");
      status.dispatchEvent(new Event("change", { bubbles: true }));
    };

    act(chooseClosed);
    const review = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(review?.textContent).toContain("Open → Closed");
    expect(review?.getAttribute("aria-modal")).toBe("true");
    expect(mocks.setStatus).not.toHaveBeenCalled();
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Cancel")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(cancel));
    const backgroundActionRow = status.closest<HTMLElement>(
      ".helpdesk-action-row",
    )!;
    await vi.waitFor(() => expect(backgroundActionRow.inert).toBe(true));
    expect(backgroundActionRow.getAttribute("aria-hidden")).toBe("true");
    const confirmBeforeCancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Confirm status change")!;
    const close = review?.querySelector<HTMLButtonElement>(".modal-close");
    act(() => {
      confirmBeforeCancel.focus();
      confirmBeforeCancel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(close);
    act(() => cancel.focus());
    await act(async () => {
      cancel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(status));
    expect(backgroundActionRow.inert).toBe(false);
    expect(backgroundActionRow.hasAttribute("aria-hidden")).toBe(false);
    expect(mocks.setStatus).not.toHaveBeenCalled();

    act(chooseClosed);
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Confirm status change")!;
    act(() => {
      confirm.click();
      confirm.click();
    });
    await vi.waitFor(() => expect(mocks.setStatus).toHaveBeenCalledTimes(1));
    expect(mocks.setStatus).toHaveBeenCalledWith(
      CONVERSATION_ID,
      "closed",
      VERSION,
    );
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("requires explicit review before removing a verified assignment", async () => {
    mocks.canAdmin = true;
    const assignedUserId = "55555555-5555-4555-8555-555555555555";
    const assigned = {
      ...conversation,
      assignment_state: "tenant_active_user" as const,
      assigned_to: assignedUserId,
      assigned_to_user_id: assignedUserId,
    };
    const nextVersion = "2026-08-24T00:00:01Z";
    mocks.listConversations.mockResolvedValue({
      data: { tenantId: TENANT_ID, items: [assigned], page },
    });
    mocks.getConversation.mockResolvedValue({ data: assigned });
    mocks.assign.mockResolvedValue({
      data: {
        ...conversation,
        version: nextVersion,
        updated_at: nextVersion,
      },
    });
    await renderAndSelect();
    const unassign = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Unassign")!;
    act(() => unassign.click());
    expect(document.body.textContent).toContain(
      `verified tenant user ${assignedUserId}`,
    );
    expect(mocks.assign).not.toHaveBeenCalled();

    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Confirm unassign")!;
    act(() => {
      confirm.click();
      confirm.click();
    });
    await vi.waitFor(() => expect(mocks.assign).toHaveBeenCalledTimes(1));
    expect(mocks.assign).toHaveBeenCalledWith(
      CONVERSATION_ID,
      { action: "unassign" },
      VERSION,
    );
  });

  it("keeps durable note recovery on the stable principal scope across epoch and role refresh", async () => {
    mocks.canAdmin = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    let rotateContext = (): void => undefined;
    function Host() {
      const [selected, setSelected] = useState<string | null>(null);
      const [context, setContext] = useState("admin:epoch-1");
      rotateContext = () => setContext("owner:epoch-2");
      return (
        <HelpdeskInbox
          catalog={catalog}
          tenantId={TENANT_ID}
          identityScope={`${TENANT_ID}:user-1:${context}`}
          noteRecoveryAuthority={testRecoveryAuthority()}
          accessAllowed
          catalogVerified
          selectedConversationId={selected}
          statusFilter={null}
          onSelectedConversationChange={setSelected}
          onStatusFilterChange={() => undefined}
        />
      );
    }
    act(() => root?.render(<Host />));
    await settle();
    const selectConversation = (): void => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) =>
          candidate.textContent?.includes("reader@example.test"),
        )
        ?.click();
    };
    act(selectConversation);
    await settle();
    await vi.waitFor(() => expect(mocks.noteHeld).toHaveBeenCalled());
    const priorTicketSignal = mocks.listTickets.mock.calls[0]?.[0]
      ?.signal as AbortSignal;

    act(rotateContext);
    await settle();
    await settle();
    act(selectConversation);
    await settle();
    await vi.waitFor(() => expect(mocks.noteHeld).toHaveBeenCalledTimes(2));

    expect(mocks.noteHeld.mock.calls.map((call) => call[0])).toEqual([
      testRecoveryAuthority().scope,
      testRecoveryAuthority().scope,
    ]);
    expect(priorTicketSignal.aborted).toBe(true);
  });

  it("keeps API-key provenance read-only when no stable note principal exists", async () => {
    mocks.canAdmin = true;
    await renderAndSelect(null);

    expect(document.body.textContent).toContain(
      "Adding an internal note requires a signed-in user session with a stable recovery principal.",
    );
    expect(document.body.textContent).toContain(
      "API-key sessions remain read and record-management only; no note request can start.",
    );
    const reply = labelledControl("Internal note") as HTMLTextAreaElement;
    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Add internal note")!;
    expect(reply.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    act(() => save.click());
    expect(mocks.noteHeld).not.toHaveBeenCalled();
    expect(mocks.postInternalNote).not.toHaveBeenCalled();
  });

  it("retains a prepared checkpoint and sends nothing after a direct API-base change", async () => {
    mocks.canAdmin = true;
    let releasePrepare!: (value: {
      status: "ready";
      signature: string;
      idempotencyKey: string;
    }) => void;
    mocks.notePrepare.mockReturnValue(
      new Promise((resolve) => {
        releasePrepare = resolve;
      }),
    );
    await renderAndSelect();
    const reply = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(reply, "Authority-bound private note");
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Add internal note")!;
    act(() => save.click());
    await vi.waitFor(() => expect(mocks.notePrepare).toHaveBeenCalledTimes(1));

    // Settings can update the active endpoint without changing the mounted
    // React props first. The pre-transport authority reader must still stop it.
    mocks.apiBaseUrl = "https://other.example.test/gateway";
    await act(async () => {
      releasePrepare({
        status: "ready",
        signature: "prepared-on-original-base",
        idempotencyKey: "original-base-key",
      });
      await Promise.resolve();
    });

    expect(mocks.postInternalNote).not.toHaveBeenCalled();
    expect(mocks.noteMarkUnknown).not.toHaveBeenCalled();
    expect(mocks.noteSettle).not.toHaveBeenCalled();
    expect(mocks.notePrepare).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("API workspace changed"),
    );
  });

  it("retains a prepared checkpoint and sends nothing after a same-base credential boundary", async () => {
    mocks.canAdmin = true;
    let releasePrepare!: (value: {
      status: "ready";
      signature: string;
      idempotencyKey: string;
    }) => void;
    mocks.notePrepare.mockReturnValue(
      new Promise((resolve) => {
        releasePrepare = resolve;
      }),
    );
    await renderAndSelect();
    const reply = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(reply, "Same-base credential-bound private note");
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent === "Add internal note")
        ?.click(),
    );
    await vi.waitFor(() => expect(mocks.notePrepare).toHaveBeenCalledOnce());

    const transition = beginApiIdentityTransition();
    releaseApiIdentityTransition(transition);
    await act(async () => {
      releasePrepare({
        status: "ready",
        signature: "prepared-before-key-replacement",
        idempotencyKey: "original-credential-key",
      });
      await Promise.resolve();
    });

    expect(mocks.postInternalNote).not.toHaveBeenCalled();
    expect(mocks.noteMarkUnknown).not.toHaveBeenCalled();
    expect(mocks.noteSettle).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("API workspace changed"),
    );
  });

  it("invalidates delayed note preparation across a workspace authority remount", async () => {
    mocks.canAdmin = true;
    let releasePrepare!: (value: {
      status: "ready";
      signature: string;
      idempotencyKey: string;
    }) => void;
    mocks.notePrepare.mockReturnValue(
      new Promise((resolve) => {
        releasePrepare = resolve;
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const originalAuthority = testRecoveryAuthority();
    const nextApiBase = "https://staging.example.test/path-gateway";
    const nextAuthority = testRecoveryAuthority(nextApiBase);
    let switchAuthority = (): void => undefined;
    function Host() {
      const [selected, setSelected] = useState<string | null>(null);
      const [authority, setAuthority] = useState(originalAuthority);
      switchAuthority = () => setAuthority(nextAuthority);
      return (
        <HelpdeskInbox
          catalog={catalog}
          tenantId={TENANT_ID}
          identityScope={`${TENANT_ID}:user-1:admin:epoch-1`}
          noteRecoveryAuthority={authority}
          accessAllowed
          catalogVerified
          selectedConversationId={selected}
          statusFilter={null}
          onSelectedConversationChange={setSelected}
          onStatusFilterChange={() => undefined}
        />
      );
    }
    act(() => root?.render(<Host />));
    await settle();
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) =>
          candidate.textContent?.includes("reader@example.test"),
        )
        ?.click(),
    );
    await settle();
    await settle();
    const reply = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(reply, "Workspace A private note");
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent === "Add internal note")
        ?.click(),
    );
    await vi.waitFor(() => expect(mocks.notePrepare).toHaveBeenCalledTimes(1));

    act(() => {
      mocks.apiBaseUrl = nextApiBase;
      mocks.notePrincipal = {
        apiBaseUrl: nextApiBase,
        apiIdentityGeneration: 0,
        user: SESSION_USER_ID,
        tenant: TENANT_ID,
      };
      switchAuthority();
    });
    await settle();
    await act(async () => {
      releasePrepare({
        status: "ready",
        signature: "prepared-in-workspace-a",
        idempotencyKey: "workspace-a-key",
      });
      await Promise.resolve();
    });

    expect(mocks.postInternalNote).not.toHaveBeenCalled();
    expect(mocks.noteMarkUnknown).not.toHaveBeenCalled();
    expect(mocks.noteSettle).not.toHaveBeenCalled();
    expect(mocks.notePrepare).toHaveBeenCalledTimes(1);
  });

  it("gives one same-tick owner to a reply save", async () => {
    mocks.canAdmin = true;
    let resolve!: (value: { data: ServiceMessage }) => void;
    mocks.postInternalNote.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderAndSelect();
    expect(document.body.textContent).toContain(
      "It cannot currently be edited or deleted through Helpdesk, and its complete privacy lifecycle remains held.",
    );
    expect(document.body.textContent).toContain(
      "Delivery is not applicable and no customer channel is contacted.",
    );
    const reply = labelledControl("Internal note") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(reply, "Internal follow-up");
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Add internal note")!;
    act(() => {
      save.click();
      save.click();
    });
    await vi.waitFor(() =>
      expect(mocks.postInternalNote).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      resolve({
        data: {
          id: MESSAGE_ID,
          tenantId: TENANT_ID,
          tenant_id: TENANT_ID,
          conversation_id: CONVERSATION_ID,
          source_type: "manual",
          direction: "internal",
          sender_type: "agent",
          body_text: "Internal follow-up",
          record_kind: "internal_note",
          delivery_status: "not_applicable",
          attachment_count: 0,
          projection_truncated: false,
          sent_at: "2026-08-24T09:35:00Z",
          created_at: "2026-08-24T09:35:00Z",
        },
      });
      await Promise.resolve();
    });
    expect(
      (labelledControl("Internal note") as HTMLTextAreaElement).value,
    ).toBe("");
  });
});
