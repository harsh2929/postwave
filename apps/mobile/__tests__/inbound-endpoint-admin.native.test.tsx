/**
 * Inbound endpoint lifecycle — the render contract for the three verbs the
 * phone did not have: CREATE (with the shown-once signing secret), RENAME and
 * DELETE.
 *
 * What is pinned here is the set of ways this surface could be quietly wrong:
 *
 *  1. THE SECRET IS SHOWN ONCE. The create sheet must SAY so before the
 *     operator commits, and the value must be handed to the caller (which
 *     stashes it in process memory) in the same tick it arrives — this file
 *     asserts the hand-off happens, and that nothing is issued when the form
 *     is not sendable.
 *  2. DELETE IS DESTRUCTIVE AND CASCADES INTO RETENTION. It must park behind
 *     the ConfirmSheet, show the server's own consequence sentence, and issue
 *     NOTHING until the phrase is typed — a delete one tap away from a list
 *     row would be the worst control in the app.
 *  3. NEITHER VERB MAY BE OFFERED OFFLINE, where it cannot be queued
 *     honestly, and neither may be offered below admin, where the route can
 *     only answer 403.
 *  4. THE SECRET MUST ACTUALLY BE DRAWN, AND SAY THE RIGHT THING. The last
 *     block renders the whole route, because both ways this could fail live
 *     at the screen rather than in a component: the reveal was gated on the
 *     endpoint being in the LIST (a just-created one is not, until a refetch
 *     that may never land), and the card's words came from state that
 *     defaulted to the ROTATION sentence (a 24-hour grace window a brand-new
 *     endpoint does not have).
 *
 * The mutations are mocked so the assertions are about what this UI ISSUES;
 * the transport itself is api/inboundEndpointAdmin's contract.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import {
  INBOUND_ENDPOINT_CREATE_NAME_MAX,
  inboundEndpointDeleteConfirmCopy,
} from "@/lib/inboundEndpointAdmin";

const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const ENDPOINT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Stripe live",
  slug: "stripe-live-payments-eu",
};

const mockCreateCalls: string[] = [];
const mockRenameCalls: unknown[] = [];
const mockRemoveCalls: string[] = [];
const mockPending = { create: false, rename: false, remove: false };
/** What the mocked mutation answers with; an Error routes to onError. */
const mockAnswer: {
  create: unknown;
  rename: unknown;
  remove: unknown;
} = {
  create: {
    endpointId: ENDPOINT.id,
    slug: ENDPOINT.slug,
    name: ENDPOINT.name,
    secret: "whsec_test_value",
  },
  rename: "Stripe live EU",
  remove: undefined,
};

type Callbacks = {
  onSuccess?: (data: never) => void;
  onError?: (error: unknown) => void;
};

function mockSettle(kind: "create" | "rename" | "remove", opts?: Callbacks) {
  const answer = mockAnswer[kind];
  if (answer instanceof Error) opts?.onError?.(answer);
  else opts?.onSuccess?.(answer as never);
}

jest.mock("@/hooks/useInboundEndpointAdmin", () => ({
  useInboundEndpointAdminActions: () => ({
    create: {
      get isPending() {
        return mockPending.create;
      },
      mutate: (name: string, opts?: Callbacks) => {
        mockCreateCalls.push(name);
        mockSettle("create", opts);
      },
    },
    rename: {
      get isPending() {
        return mockPending.rename;
      },
      mutate: (vars: unknown, opts?: Callbacks) => {
        mockRenameCalls.push(vars);
        mockSettle("rename", opts);
      },
    },
    remove: {
      get isPending() {
        return mockPending.remove;
      },
      mutate: (id: string, opts?: Callbacks) => {
        mockRemoveCalls.push(id);
        mockSettle("remove", opts);
      },
    },
  }),
}));

// The endpoint LIST only. `useInboundWebhookActions` stays REAL, as the
// sibling route suite keeps it: the toggle and rotate controls this screen
// still ships must be driven by the code that ships.
const mockEndpoints: { current: unknown } = { current: undefined };
jest.mock("@/hooks/useInboundWebhookOps", () => ({
  ...(jest.requireActual("@/hooks/useInboundWebhookOps") as object),
  useInboundWebhooks: () => mockEndpoints.current,
}));

/* eslint-disable import/first -- must follow the hook mocks. */
import InboundWebhooksRoute from "../app/(tabs)/inbound-webhooks";
import { ToastProvider } from "@/components/Toast";
import { InboundEndpointAdminActions } from "@/components/inbound-webhooks/InboundEndpointAdminActions";
import { InboundEndpointCreateControl } from "@/components/inbound-webhooks/InboundEndpointCreateControl";
import {
  __resetInboundSecretMintForTests,
  noteInboundSecretMinted,
} from "@/lib/inboundSecretReveal";
import { clearSecret, stashSecret } from "@/lib/revealOnceSecret";
/* eslint-enable import/first */

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>{children}</ConfirmProvider>
    </SafeAreaProvider>
  );
}

const created: { endpointId: string; secret: string }[] = [];

async function renderCreate() {
  return render(
    <InboundEndpointCreateControl
      onCreated={(result) => created.push(result)}
    />,
    { wrapper },
  );
}

async function renderRowActions() {
  return render(<InboundEndpointAdminActions endpoint={ENDPOINT} />, {
    wrapper,
  });
}

/** Let React commit what the last interaction queued. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockCreateCalls.length = 0;
  mockRenameCalls.length = 0;
  mockRemoveCalls.length = 0;
  created.length = 0;
  mockPending.create = false;
  mockPending.rename = false;
  mockPending.remove = false;
  mockAnswer.create = {
    endpointId: ENDPOINT.id,
    slug: ENDPOINT.slug,
    name: ENDPOINT.name,
    secret: "whsec_test_value",
  };
  mockAnswer.rename = "Stripe live EU";
  mockAnswer.remove = undefined;
  mockEndpoints.current = undefined;
  clearSecret();
  __resetInboundSecretMintForTests();
});

describe("InboundEndpointCreateControl", () => {
  it("withholds the control below admin, where the route can only answer 403", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "member" });
    await renderCreate();
    expect(screen.queryByLabelText("New")).toBeNull();
  });

  it("warns BEFORE the secret exists that it is shown once and unrecoverable", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderCreate();
    await fireEvent.press(screen.getByLabelText("New"));
    await flush();
    expect(screen.getByText("New inbound endpoint")).toBeTruthy();
    expect(
      screen.getByText(/shown once.*cannot be retrieved later/s),
    ).toBeTruthy();
  });

  it("issues nothing for an empty name and says what is missing", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderCreate();
    await fireEvent.press(screen.getByLabelText("New"));
    await fireEvent.press(screen.getByLabelText("Create endpoint"));
    await flush();
    expect(mockCreateCalls).toEqual([]);
    expect(
      screen.getByText("Enter a name so you can recognise this endpoint later."),
    ).toBeTruthy();
  });

  it("sends the TRIMMED name and hands the one-time secret straight on", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderCreate();
    await fireEvent.press(screen.getByLabelText("New"));
    await fireEvent.changeText(
      screen.getByLabelText("Endpoint name"),
      "  Stripe live  ",
    );
    await fireEvent.press(screen.getByLabelText("Create endpoint"));
    await flush();
    expect(mockCreateCalls).toEqual(["Stripe live"]);
    expect(created).toEqual([
      { endpointId: ENDPOINT.id, secret: "whsec_test_value" },
    ]);
    // The sheet closes on success; the secret is the caller's now.
    expect(screen.queryByText("New inbound endpoint")).toBeNull();
  });

  it("refuses to open while a shown-once secret is still uncaptured", async () => {
    // The reveal-once stash holds ONE secret and replaces it on the next
    // write, so a second create would destroy a value the server will never
    // show again. Desktop refuses identically.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await render(
      <InboundEndpointCreateControl onCreated={() => undefined} secretShown />,
      { wrapper },
    );
    await fireEvent.press(screen.getByLabelText("New"));
    await flush();
    expect(screen.queryByText("New inbound endpoint")).toBeNull();
    expect(mockCreateCalls).toEqual([]);
  });

  it("refuses to create offline, and says why rather than dimming in silence", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
    });
    await renderCreate();
    await fireEvent.press(screen.getByLabelText("New"));
    await flush();
    expect(screen.getByText(/cannot be queued for later/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Create endpoint"));
    await flush();
    expect(mockCreateCalls).toEqual([]);
  });

  it("does not let the field's UTF-16 clamp cut a name the validator allows", async () => {
    // A prop assertion, deliberately: RNTL's changeText calls onChangeText
    // directly and never applies the native clamp, so the clamp itself cannot
    // be exercised here — but a revert of `max * 2` to `max` is exactly the
    // silent truncation this pins. `maxLength` counts UTF-16 units and the
    // stated cap counts code points, so an emoji-bearing label pasted at the
    // cap lost its tail with nothing said.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderCreate();
    await fireEvent.press(screen.getByLabelText("New"));
    await flush();
    const field = screen.getByLabelText("Endpoint name");
    expect(field.props.maxLength).toBeGreaterThanOrEqual(
      INBOUND_ENDPOINT_CREATE_NAME_MAX * 2,
    );
  });
});

describe("InboundEndpointAdminActions", () => {
  it("withholds rename and delete below admin", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "member" });
    await renderRowActions();
    expect(screen.queryByLabelText(`Delete ${ENDPOINT.name}`)).toBeNull();
    expect(screen.queryByLabelText(`Rename ${ENDPOINT.name}`)).toBeNull();
  });

  it("parks delete on the confirm with the server's own consequence", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderRowActions();
    const copy = inboundEndpointDeleteConfirmCopy(ENDPOINT);
    // NOT awaited: the handler is parked on `await confirm(...)`.
    const pending = fireEvent.press(
      screen.getByLabelText(`Delete ${ENDPOINT.name}`),
    ) as unknown as Promise<unknown>;
    await flush();
    expect(screen.getByText(copy.title)).toBeTruthy();
    expect(screen.getByText(copy.message)).toBeTruthy();
    expect(mockRemoveCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;
    expect(mockRemoveCalls).toEqual([]);
  });

  it("issues the DELETE only after the phrase is typed", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderRowActions();
    const copy = inboundEndpointDeleteConfirmCopy(ENDPOINT);
    const pending = fireEvent.press(
      screen.getByLabelText(`Delete ${ENDPOINT.name}`),
    ) as unknown as Promise<unknown>;
    await flush();
    // The confirming button is inert until the phrase matches.
    await fireEvent.press(screen.getByLabelText(copy.confirmLabel));
    await flush();
    expect(mockRemoveCalls).toEqual([]);
    await fireEvent.changeText(
      screen.getByLabelText(`Type ${copy.confirmPhrase} to confirm`),
      copy.confirmPhrase,
    );
    await fireEvent.press(screen.getByLabelText(copy.confirmLabel));
    await flush();
    await pending;
    expect(mockRemoveCalls).toEqual([ENDPOINT.id]);
  });

  it("offers neither verb offline, with the reason spoken", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "admin",
      enabled: false,
    });
    await renderRowActions();
    expect(
      screen.getByText("Offline — renaming and deleting need a connection."),
    ).toBeTruthy();
    for (const label of [`Rename ${ENDPOINT.name}`, `Delete ${ENDPOINT.name}`]) {
      const control = screen.getByLabelText(label);
      expect(control.props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(control);
    }
    await flush();
    expect(mockRemoveCalls).toEqual([]);
    expect(screen.queryByText("Rename endpoint")).toBeNull();
  });

  it("seeds rename from the stored name and refuses an unchanged one", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderRowActions();
    await fireEvent.press(screen.getByLabelText(`Rename ${ENDPOINT.name}`));
    await flush();
    expect(screen.getByLabelText("Endpoint name").props.value).toBe(
      ENDPOINT.name,
    );
    // Only the label changes — the sheet says so before anything is sent.
    expect(screen.getByText(/Only the label changes/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Save name"));
    await flush();
    expect(mockRenameCalls).toEqual([]);
  });

  it("sends the new name against this endpoint's id", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    await renderRowActions();
    await fireEvent.press(screen.getByLabelText(`Rename ${ENDPOINT.name}`));
    await fireEvent.changeText(
      screen.getByLabelText("Endpoint name"),
      " Stripe live EU ",
    );
    await fireEvent.press(screen.getByLabelText("Save name"));
    await flush();
    expect(mockRenameCalls).toEqual([
      { id: ENDPOINT.id, name: "Stripe live EU" },
    ]);
    expect(screen.queryByText("Rename endpoint")).toBeNull();
  });
});

/**
 * The whole route, because the shown-once secret is drawn by the SCREEN and
 * both failure modes live there rather than in any component.
 */
describe("the inbound-webhooks screen after a create", () => {
  const NEW_ID = "44444444-4444-4444-8444-444444444444";

  function queryResult(over: Record<string, unknown>) {
    return {
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isRefetching: false,
      isSuccess: true,
      refetch: async () => ({ data: undefined }),
      ...over,
    };
  }

  async function renderRoute() {
    return render(
      <ToastProvider>
        <InboundWebhooksRoute />
      </ToastProvider>,
      { wrapper },
    );
  }

  it("draws the secret for an endpoint the LIST does not have yet", async () => {
    // The exact state one tick after a 201: the secret is stashed, the list
    // query has been invalidated, and its refetch has not landed (or failed).
    // Gating the card on list membership meant the operator got a toast
    // saying "save the signing secret now" over a screen that never drew it —
    // and the server does not produce it a second time.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockEndpoints.current = queryResult({ data: [] });
    noteInboundSecretMinted(NEW_ID, "create");
    stashSecret(NEW_ID, "whsec_freshly_minted");
    await renderRoute();
    expect(screen.getByText("Signing secret (shown once)")).toBeTruthy();
    expect(screen.getByLabelText(/Shown once; save it before dismissing/)).toBeTruthy();
  });

  it("never promises a rotation grace window for a secret that was CREATED", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockEndpoints.current = queryResult({ data: [] });
    noteInboundSecretMinted(NEW_ID, "create");
    stashSecret(NEW_ID, "whsec_freshly_minted");
    await renderRoute();
    expect(screen.getByText(/cannot be retrieved later/)).toBeTruthy();
    expect(screen.queryByText(/previous secret keeps verifying/)).toBeNull();
  });

  it("still refuses a secret this screen never minted, from the shared stash", async () => {
    // One process-wide stash serves the outbound webhooks screen too. Its
    // secret's id is not an inbound endpoint and was never noted here, so
    // neither the note nor list membership admits it.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockEndpoints.current = queryResult({ data: [] });
    stashSecret("outbound-endpoint-id", "whsec_not_ours");
    await renderRoute();
    expect(screen.queryByText(/Signing secret \(shown once\)/)).toBeNull();
  });

  it("tells an empty tenant that an admin can mint one HERE, not on the web", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
    mockEndpoints.current = queryResult({ data: [] });
    await renderRoute();
    expect(screen.getByText("No inbound endpoints")).toBeTruthy();
    expect(screen.getByText(/An admin can mint one here with New/)).toBeTruthy();
  });
});
