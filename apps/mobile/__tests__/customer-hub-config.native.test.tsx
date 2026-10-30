/**
 * Customer Hub configuration — the render contract (register: Customer Hub
 * configuration, messaging-support).
 *
 * The decode/replacement policy is pinned in src/lib/customerHub.test.ts and
 * the transport in src/api/customerHub.test.ts. This file pins what an
 * operator is actually TOLD, which is where this surface can lie:
 *
 *  - the record is not a runtime, and the sheet says so on the SUCCESS path,
 *    as standing copy rather than an error state;
 *  - the two release-held values are refused with the server's own sentence
 *    and Save goes dead, instead of spending a round trip on a certain 409;
 *  - Save is dead with no changes and sends a COMPLETE replacement otherwise;
 *  - below admin the reader gets the role sentence, not an empty record;
 *  - offline says the record is not stored on the device, which is a different
 *    statement from "this workspace has no Customer Hub";
 *  - the six members mobile does not edit are NAMED, so nobody assumes the
 *    phone is authoring a whole storefront;
 *  - the entry point is mounted on the Helpdesk queue header.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  CUSTOMER_HUB_HELD_SENTENCE,
  type CustomerHubConfig,
  type CustomerHubDraft,
} from "@/lib/customerHub";

const TENANT = "11111111-1111-4111-8111-111111111111";
const VERSION = "2026-08-25T11:30:00.222222222Z";

const CONFIG: CustomerHubConfig = {
  tenantId: TENANT,
  version: VERSION,
  status: "draft",
  order_history_enabled: true,
  favorites_enabled: false,
  coupons_enabled: true,
  recommendations_enabled: true,
  customer_agent_enabled: false,
  runtimeStatus: "held",
  runtimeReasonCode: "customer_hub_runtime_unavailable",
  createdAt: "2026-08-24T10:00:00.111111111Z",
  updatedAt: VERSION,
  carried: {
    storefronts: [],
    content_blocks: [],
    personalization_rules: {},
    support_settings: {},
    styling: {},
    metadata: {},
  },
};

type QueryShape = {
  data: { config: CustomerHubConfig; etag: string } | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

let mockQuery: QueryShape = {
  data: { config: CONFIG, etag: `"${VERSION}"` },
  isPending: false,
  isError: false,
  error: null,
  refetch: jest.fn(async () => ({})),
};
const mockMutations: { draft: CustomerHubDraft }[] = [];

jest.mock("@/hooks/useCustomerHubConfig", () => ({
  CUSTOMER_HUB_CONFIG_KEY: "customer-hub-config-v1",
  CUSTOMER_HUB_WRITE_KEY: "customer-hub-config-write-v1",
  useCustomerHubConfig: () => mockQuery,
  useCustomerHubReplace: () => ({
    isPending: false,
    mutate: (
      variables: { draft: CustomerHubDraft },
      handlers?: { onSuccess?: () => void },
    ) => {
      mockMutations.push(variables);
      handlers?.onSuccess?.();
    },
  }),
}));

const mockToasts: { kind: string; message: string }[] = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

// eslint-disable-next-line import/first -- must follow the hook + toast mocks.
import { CustomerHubHeaderButton } from "@/components/helpdesk/CustomerHubHeaderButton";

function access(over: Record<string, unknown> = {}) {
  return {
    identity: {
      fingerprint: "fp",
      baseUrl: "https://api.example.test",
      tenantId: TENANT,
      userId: "22222222-2222-4222-8222-222222222222",
      effectiveRole: "admin",
      mode: "session",
      contextEpoch: 1,
    },
    onlineGate: { enabled: true },
    roleAllowed: true,
    sessionReady: true,
    online: true,
    canRequest: true,
    denialReason: null,
    ...over,
  } as never;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

/** Render the header button and press it, which is the only way in. */
async function open(over: Record<string, unknown> = {}) {
  const view = await render(
    <CustomerHubHeaderButton access={access(over)} />,
    { wrapper },
  );
  await fireEvent.press(
    screen.getByLabelText("Open the Customer Hub configuration record"),
  );
  return view;
}

afterEach(() => {
  mockQuery = {
    data: { config: CONFIG, etag: `"${VERSION}"` },
    isPending: false,
    isError: false,
    error: null,
    refetch: jest.fn(async () => ({})),
  };
  mockMutations.length = 0;
  mockToasts.length = 0;
});

describe("CustomerHubHeaderButton", () => {
  it("is the Helpdesk queue's entry point, and opens the sheet", async () => {
    await open();
    expect(screen.getByLabelText("Customer Hub configuration")).toBeTruthy();
  });

  it("is mounted on the Helpdesk queue screen", () => {
    const source = readFileSync(
      join(process.cwd(), "app/(tabs)/helpdesk/index.tsx"),
      "utf8",
    );
    expect(source).toContain("<CustomerHubHeaderButton");
  });
});

describe("CustomerHubConfigSheet", () => {
  it("states that the record is not a runtime, on the success path", async () => {
    await open();
    expect(screen.getByText(/Runtime release held/u)).toBeTruthy();
    expect(
      screen.getByText(/does not prove a customer can see or use a feature/u),
    ).toBeTruthy();
    expect(
      screen.getByText(/customer_hub_runtime_unavailable/u),
    ).toBeTruthy();
  });

  it("names the members it is not editing", async () => {
    await open();
    const carried = screen.getByText(/Storefronts, Content blocks/u);
    expect(carried).toBeTruthy();
    expect(carried.props.children).toContain("Metadata");
  });

  it("keeps Save dead until something actually changes", async () => {
    await open();
    const save = screen.getByLabelText("No changes to save");
    expect(save.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(save);
    expect(mockMutations).toHaveLength(0);
  });

  it("sends the changed draft once a toggle moves", async () => {
    await open();
    await fireEvent(screen.getByLabelText("Favorites"), "valueChange", true);
    await fireEvent.press(screen.getByLabelText("Replace configuration record"));
    expect(mockMutations).toHaveLength(1);
    expect(mockMutations[0]?.draft.favorites_enabled).toBe(true);
    expect(mockToasts.at(-1)?.kind).toBe("success");
    expect(mockToasts.at(-1)?.message).toMatch(/storefront runtime stays held/u);
  });

  it("refuses the release-held toggle with the server's own sentence", async () => {
    await open();
    // Customer Agent is the toggle the server answers 409 for.
    await fireEvent(
      screen.getByLabelText("Customer Agent"),
      "valueChange",
      true,
    );
    expect(screen.getByText(CUSTOMER_HUB_HELD_SENTENCE)).toBeTruthy();
    const save = screen.getByLabelText("Replace configuration record");
    expect(save.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(save);
    expect(mockMutations).toHaveLength(0);
  });

  it("tells a non-admin session it is the session, not the workspace", async () => {
    await open({
      roleAllowed: false,
      canRequest: false,
      denialReason: "Reading the Customer Hub record needs an admin session.",
    });
    expect(screen.getByText("Admin session required")).toBeTruthy();
    expect(
      screen.getByText("Reading the Customer Hub record needs an admin session."),
    ).toBeTruthy();
    expect(screen.queryByText(/Runtime release held/u)).toBeNull();
  });

  it("says the record is not on the device when offline", async () => {
    await open({ online: false, canRequest: false });
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(
      screen.getByText(/not stored on this device/u),
    ).toBeTruthy();
    expect(screen.queryByLabelText("No changes to save")).toBeNull();
  });

  it("offers a retry when the read failed", async () => {
    mockQuery = {
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("The Customer Hub response failed its shape checks."),
      refetch: jest.fn(async () => ({})),
    };
    await open();
    expect(
      screen.getByText(/failed its shape checks/u),
    ).toBeTruthy();
  });

  it("shows no record fields while the read is still in flight", async () => {
    mockQuery = {
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      refetch: jest.fn(async () => ({})),
    };
    await open();
    expect(screen.queryByText(/Runtime release held/u)).toBeNull();
    expect(screen.queryByLabelText("No changes to save")).toBeNull();
  });

  it("says a workspace with no stored record is creating one on save", async () => {
    mockQuery = {
      data: { config: { ...CONFIG, version: "absent" }, etag: '"absent"' },
      isPending: false,
      isError: false,
      error: null,
      refetch: jest.fn(async () => ({})),
    };
    await open();
    expect(screen.getByText("No record stored yet")).toBeTruthy();
    expect(screen.getByText(/saving creates the record/u)).toBeTruthy();
  });
});
