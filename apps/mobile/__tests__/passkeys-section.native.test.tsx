/**
 * PasskeysSection — the rename verb the section claimed and never offered.
 *
 * The transport (src/api/passkeys.ts renamePasskey), the mutation
 * (src/hooks/usePasskeys.ts useRenamePasskey) and the server route
 * (PATCH /api/v1/auth/webauthn/credentials/{id}) all shipped; nothing rendered
 * a way to reach them, so every row offered exactly one verb and it was
 * Delete. On a list whose rows read "Unnamed passkey · Not used yet" twice,
 * naming a credential is the only way to know which one Delete removes.
 *
 * What is pinned here:
 *   - a row offers Rename as well as Delete;
 *   - the editor cannot submit a name that is blank or unchanged, because the
 *     server silently rewrites a blank one to the literal word "Passkey";
 *   - saving calls the rename mutation with the row id and the TRIMMED name.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PasskeysSection } from "@/components/settings/PasskeysSection";

// The two mutations are stubbed at the HOOK boundary rather than the transport
// because the suite's react-query mock never runs a mutationFn — so a stub one
// layer lower could not observe the call the section is being tested for.
jest.mock("@/hooks/usePasskeys", () => {
  const rename = jest.fn(async () => undefined);
  const remove = jest.fn(async () => undefined);
  return {
    __esModule: true,
    PASSKEYS_QUERY_KEY: "auth-passkeys",
    __renameMutateAsync: rename,
    __deleteMutateAsync: remove,
    usePasskeys: () =>
      (
        jest.requireActual("@tanstack/react-query") as typeof ReactQuery
      ).useQuery({ queryKey: ["auth-passkeys"] }),
    useDeletePasskey: () => ({ isPending: false, mutateAsync: remove }),
    useRenamePasskey: () => ({ isPending: false, mutateAsync: rename }),
  };
});

const passkeysHarness = jest.requireMock("@/hooks/usePasskeys") as {
  __renameMutateAsync: jest.Mock;
  __deleteMutateAsync: jest.Mock;
};

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
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

function loadedWith(items: unknown[]) {
  queryHarness.__setQueryResultForTests({
    data: items,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: items })),
  });
}

const ROW = {
  id: "pk-1",
  name: "MacBook",
  created_at: "2026-08-01T10:00:00Z",
};

describe("the passkeys section", () => {
  it("offers rename beside delete on every row", async () => {
    loadedWith([ROW]);

    await render(<PasskeysSection />, { wrapper });

    expect(screen.getByLabelText("Rename MacBook")).toBeTruthy();
    expect(screen.getByLabelText("Delete MacBook")).toBeTruthy();
  });

  it("refuses to save a blank or unchanged name", async () => {
    loadedWith([ROW]);

    await render(<PasskeysSection />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Rename MacBook"));

    // Opened with the current name in the field: saving now would be a no-op
    // round trip, so the control says so rather than firing one.
    const save = screen.getByLabelText("Save the new name for MacBook");
    expect(save.props.accessibilityState.disabled).toBe(true);

    // Blank is not "clear the name" — the server rewrites it to the literal
    // word "Passkey" (clampPasskeyName), which is not what emptying a field
    // means to anyone.
    await fireEvent.changeText(screen.getByLabelText("Passkey name"), "   ");
    expect(
      screen.getByLabelText("Save the new name for MacBook").props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(passkeysHarness.__renameMutateAsync).not.toHaveBeenCalled();
  });

  it("saves the trimmed name against the row id", async () => {
    loadedWith([ROW]);

    await render(<PasskeysSection />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Rename MacBook"));
    await fireEvent.changeText(
      screen.getByLabelText("Passkey name"),
      "  Work laptop ",
    );
    await fireEvent.press(
      screen.getByLabelText("Save the new name for MacBook"),
    );

    expect(passkeysHarness.__renameMutateAsync).toHaveBeenCalledWith({
      id: "pk-1",
      name: "Work laptop",
    });
    // Renaming must never be able to reach the destructive sibling.
    expect(passkeysHarness.__deleteMutateAsync).not.toHaveBeenCalled();
  });

  it("names an unnamed row in its own affordance labels", async () => {
    loadedWith([{ id: "pk-2", created_at: "2026-08-02T10:00:00Z" }]);

    await render(<PasskeysSection />, { wrapper });

    expect(screen.getByText("Unnamed passkey")).toBeTruthy();
    expect(screen.getByLabelText("Rename passkey")).toBeTruthy();
  });
});
