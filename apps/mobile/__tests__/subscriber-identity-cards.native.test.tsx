/**
 * The profile's account-link and federated-identity cards — what only a
 * rendered test can pin:
 *
 *  - the account card states the current link (or its absence) and submits
 *    the FK change bound to the detail row's version;
 *  - unlink sends an explicit null;
 *  - the federation card names each link's provenance and gives a viewer
 *    NO verbs — absent, not disabled.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("@/hooks/useSubscriberAccount", () => {
  const actual = jest.requireActual(
    "@/hooks/useSubscriberAccount",
  ) as Record<string, unknown>;
  const setAccount = jest.fn();
  return {
    ...actual,
    __setAccount: setAccount,
    useSubscriberAccountWrites: () => ({
      setAccount: { isPending: false, error: null, mutate: setAccount },
      createAndLink: { isPending: false, error: null, mutate: jest.fn() },
    }),
  };
});

import { SubscriberAccountCard } from "@/components/subscriber/sections/SubscriberAccountCard";
import { SubscriberFederatedLinksCard } from "@/components/subscriber/sections/SubscriberFederatedLinksCard";

const accountHarness = jest.requireMock("@/hooks/useSubscriberAccount") as {
  __setAccount: jest.Mock;
};
const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  accountHarness.__setAccount.mockClear();
  queryHarness.__resetQueryResultForTests();
});

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

function loaded(data: unknown) {
  queryHarness.__setQueryResultForTests({
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

const DIRECTORY = [
  { id: "acc-1", name: "Acme AB", industry: "Manufacturing" },
  { id: "acc-2", name: "Globex", industry: "" },
];

describe("company-account card", () => {
  it("states the current link and relinks bound to the row version", async () => {
    loaded(DIRECTORY);
    await render(
      <SubscriberAccountCard
        subscriberId="sub-1"
        accountId="acc-1"
        version={'"v4"'}
        canMutate
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/B2B account/));
    });
    expect(screen.getByText("Acme AB · Manufacturing")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Link this contact to Globex"));
    });
    expect(accountHarness.__setAccount).toHaveBeenCalledTimes(1);
    expect(accountHarness.__setAccount.mock.calls[0]![0]).toEqual({
      accountId: "acc-2",
      version: '"v4"',
    });
  });

  it("unlink submits an explicit null", async () => {
    loaded(DIRECTORY);
    await render(
      <SubscriberAccountCard
        subscriberId="sub-1"
        accountId="acc-1"
        version={'"v4"'}
        canMutate
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/B2B account/));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Remove the account link"));
    });
    expect(accountHarness.__setAccount.mock.calls[0]![0]).toEqual({
      accountId: null,
      version: '"v4"',
    });
  });

  it("shows a viewer the state with no verbs", async () => {
    loaded(DIRECTORY);
    await render(
      <SubscriberAccountCard
        subscriberId="sub-1"
        accountId={null}
        version={'"v4"'}
        canMutate={false}
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/B2B account/));
    });
    expect(screen.getByText("Not linked to any account.")).toBeTruthy();
    expect(screen.queryByLabelText("Link this contact to Globex")).toBeNull();
    expect(screen.queryByLabelText("New company name")).toBeNull();
  });
});

describe("federated-identities card", () => {
  it("names each link's provenance; a viewer gets no Unlink and no form", async () => {
    loaded({
      links: [
        {
          id: "fl-1",
          parentTenantId: "tenant-9",
          masterSubscriberId: "master-1",
          matchType: "email",
          matchKey: "ada@acme.dev",
          createdAt: "2026-08-01T00:00:00Z",
        },
      ],
      subscriberVersion: '"v9"',
    });
    await render(
      <SubscriberFederatedLinksCard subscriberId="sub-1" canMutate={false} />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.press(screen.getByA11yHint(/master identities/));
    });
    expect(screen.getByText("master-1")).toBeTruthy();
    expect(
      screen.getByText(/Matched by email · ada@acme\.dev/),
    ).toBeTruthy();
    expect(screen.queryByText("Unlink")).toBeNull();
    expect(screen.queryByLabelText("Parent workspace id")).toBeNull();
  });
});
