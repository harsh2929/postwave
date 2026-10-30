/**
 * TrackingKeysPanel — the destructive-confirm gate in front of the revoke.
 *
 * Mounted UNDER the real `ConfirmProvider`, as app/_layout mounts it for every
 * real session. `useConfirm()` outside a provider resolves true, which is what
 * lets the sibling list suite assert "the button is wired"; the cost is that
 * those renders cannot see the gate at all — deleting the `await confirm(...)`
 * leaves every one of them green. These cases are the only ones that can fail
 * when the gate goes away.
 *
 * The hook module is replaced with the queryHooks proxy so the test owns the
 * `mutate` it asserts on. (The transport behind it is covered in
 * src/api/trackingKeys.test.ts.)
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { TrackingKeysPanel } from "@/components/conversions/TrackingKeysPanel";
import type { TrackingKey } from "@/lib/trackingKeys";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useTrackingKeys", () => require("./mocks/queryHooks.cjs"));

const LIVE: TrackingKey = {
  id: "3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c",
  label: "Production storefront",
  prefix: "pk_live_ab12",
  createdAt: "2026-08-30T10:00:00Z",
  revokedAt: "",
};
const SECOND_LIVE: TrackingKey = {
  id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  label: "Staging storefront",
  prefix: "pk_live_st01",
  createdAt: "2026-08-15T10:00:00Z",
  revokedAt: "",
};

const REVOKE_LABEL = "Revoke the site tracking key Production storefront";

function wrapper({ children }: { children: ReactNode }) {
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

function load(keys: TrackingKey[]) {
  queryHooks.__setHookResultForTests("useTrackingKeys", {
    data: keys,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: keys })),
  });
  const mutate = jest.fn();
  queryHooks.__setHookResultForTests("useRevokeTrackingKey", {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate,
    mutateAsync: jest.fn(async () => undefined),
    reset: jest.fn(),
    variables: undefined,
  });
  return mutate;
}

/**
 * Press Revoke and hand back the PENDING press. The handler is parked on
 * `await confirm(...)` until the sheet is settled, so awaiting the press here
 * would wait for an answer only the assertions below can give.
 */
function openConfirm(): Promise<unknown> {
  return fireEvent.press(screen.getByLabelText(REVOKE_LABEL)) as Promise<unknown>;
}

/** Let React commit what the last interaction queued (a macrotask, not a tick). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("the confirm gate", () => {
  it("opens a destructive confirm that names the key and both consequences, and does nothing until answered", async () => {
    const mutate = load([LIVE, SECOND_LIVE]);
    await render(<TrackingKeysPanel />, { wrapper });

    const pending = openConfirm();
    await flush();

    expect(screen.getByText("Revoke Production storefront?")).toBeTruthy();
    expect(screen.getByText(/stop being recorded immediately/u)).toBeTruthy();
    expect(screen.getByText(/your own pages/u)).toBeTruthy();
    expect(screen.getByLabelText("Revoke key")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Revoke Production storefront?")).toBeNull();
  });

  it("revokes exactly the confirmed key once the sheet is confirmed", async () => {
    const mutate = load([LIVE, SECOND_LIVE]);
    await render(<TrackingKeysPanel />, { wrapper });

    const pending = openConfirm();
    await flush();
    await fireEvent.press(screen.getByLabelText("Revoke key"));
    await flush();
    await pending;

    expect(mutate).toHaveBeenCalledTimes(1);
    const [id, handlers] = mutate.mock.calls[0] as [
      string,
      { onSuccess?: unknown; onError?: unknown },
    ];
    expect(id).toBe(LIVE.id);
    expect(typeof handlers.onSuccess).toBe("function");
    expect(typeof handlers.onError).toBe("function");
  });

  it("warns when the key is the last live one, and only then", async () => {
    load([LIVE]);
    await render(<TrackingKeysPanel />, { wrapper });
    const pending = openConfirm();
    await flush();
    expect(screen.getByText(/last live site key/u)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;
  });

  it("does not warn about the last live key while another is still live", async () => {
    load([LIVE, SECOND_LIVE]);
    await render(<TrackingKeysPanel />, { wrapper });
    const pending = openConfirm();
    await flush();
    expect(screen.getByText("Revoke Production storefront?")).toBeTruthy();
    expect(screen.queryByText(/last live site key/u)).toBeNull();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    await pending;
  });

  it("disables the verb while a revoke is in flight", async () => {
    load([LIVE]);
    queryHooks.__setHookResultForTests("useRevokeTrackingKey", {
      data: undefined,
      error: null,
      isError: false,
      isPending: true,
      mutate: jest.fn(),
      mutateAsync: jest.fn(async () => undefined),
      reset: jest.fn(),
      variables: LIVE.id,
    });
    await render(<TrackingKeysPanel />, { wrapper });
    expect(screen.getByText("Revoking…")).toBeTruthy();
    expect(screen.getByLabelText(REVOKE_LABEL).props.accessibilityState).toEqual(
      { disabled: true },
    );
  });
});
