/**
 * SubscriberEmailsCard — what only a rendered test can pin:
 *
 *  - each address states consent + suppression + primary identity honestly;
 *  - the PRIMARY address has no Remove verb (identity edits stay on web);
 *  - a viewer gets NO verbs — absent, not disabled;
 *  - a consent change goes THROUGH the evidence review and submits the
 *    row's own version token with the desktop-mirrored patch body.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("@/hooks/useSubscriberEmails", () => {
  const actual = jest.requireActual(
    "@/hooks/useSubscriberEmails",
  ) as Record<string, unknown>;
  const update = jest.fn();
  return {
    ...actual,
    __update: update,
    useSubscriberEmailWrites: () => ({
      add: { isPending: false, error: null, mutate: jest.fn() },
      update: { isPending: false, error: null, mutate: update },
      remove: { isPending: false, error: null, mutate: jest.fn() },
    }),
  };
});

import { SubscriberEmailsCard } from "@/components/subscriber/sections/SubscriberEmailsCard";

const writeHarness = jest.requireMock("@/hooks/useSubscriberEmails") as {
  __update: jest.Mock;
};
const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  writeHarness.__update.mockClear();
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

function loaded() {
  queryHarness.__setQueryResultForTests({
    data: [
      {
        id: "em-1",
        email: "ada@acme.dev",
        isPrimary: true,
        consentStatus: "subscribed",
        suppressed: false,
        version: '"a1"',
      },
      {
        id: "em-2",
        email: "work@acme.dev",
        isPrimary: false,
        consentStatus: "never_subscribed",
        suppressed: true,
        version: '"a7"',
      },
    ],
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

async function draw(canMutate: boolean) {
  loaded();
  await render(
    <SubscriberEmailsCard subscriberId="sub-1" canMutate={canMutate} />,
    { wrapper },
  );
  await act(async () => {
    fireEvent.press(screen.getByA11yHint(/Alternate addresses/));
  });
}

describe("the profile's addresses card", () => {
  it("states each address's consent, suppression and identity honestly", async () => {
    await draw(false);
    expect(screen.getByText(/ada@acme\.dev\s+· Primary/)).toBeTruthy();
    expect(
      screen.getByText(/Never subscribed · Suppressed/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Identity changes happen in the web editor/),
    ).toBeTruthy();
  });

  it("gives a viewer NO verbs and no add field — absent, not disabled", async () => {
    await draw(false);
    expect(screen.queryByText("Review opt-in")).toBeNull();
    expect(screen.queryByText("Suppress")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByLabelText("New alternate address")).toBeNull();
  });

  it("offers Remove only on non-primary addresses", async () => {
    await draw(true);
    expect(screen.getAllByText(/Review opt-/)).toHaveLength(2);
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(
      screen.getByLabelText("Remove work@acme.dev from this profile"),
    ).toBeTruthy();
  });

  it("routes a consent grant through the evidence review and binds it to the row's version", async () => {
    await draw(true);
    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Review consent for work@acme.dev"),
      );
    });
    expect(screen.getByText("Opt in: work@acme.dev")).toBeTruthy();
    await act(async () => {
      fireEvent.press(
        screen.getByLabelText("Evidence source: Preference center"),
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Legal basis: Consent"));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Jurisdiction"), "EU");
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Reason"),
        "Asked to add the work address",
      );
    });
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Policy version"), "2026-05");
    });
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText(/Evidence reference/),
        "ticket #812",
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByText("Record opt-in"));
    });
    expect(writeHarness.__update).toHaveBeenCalledTimes(1);
    const [vars] = writeHarness.__update.mock.calls[0] as [
      {
        emailId: string;
        version: string;
        body: Record<string, string>;
      },
    ];
    expect(vars.emailId).toBe("em-2");
    expect(vars.version).toBe('"a7"');
    expect(vars.body.consent_status).toBe("subscribed");
    expect(vars.body.jurisdiction).toBe("EU");
  });
});
