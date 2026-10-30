/**
 * Tag creation — the render contract for the "+ New" path.
 *
 * The policy (validation, palette, body shape, invalidation prefix) is
 * pinned in src/lib/tagCreateDraft.test.ts and the transport in
 * src/api/tags.test.ts. This file pins what a person actually meets:
 *
 *  - the affordance is role-gated by OMISSION: an editor sees "+ New", a
 *    viewer sees nothing (not a disabled ghost);
 *  - the sheet opens, collects a draft, and hands it to the mutation;
 *  - an exact taxonomy match becomes the dedup sentence BEFORE submit.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const authStore = require("./mocks/authStore.cjs");

const mockTags = {
  data: { rows: [], fromSnapshot: false, capturedAt: null },
  error: null,
  isError: false,
  isLoading: false,
  isRefetching: false,
  dataUpdatedAt: 0,
  refetch: jest.fn(async () => undefined),
};

jest.mock("@/hooks/useTagCatalogue", () => ({
  useTagCatalogue: () => mockTags,
  useTagGroups: () => ({ data: [], isLoading: false, isError: false }),
}));

const mockMutate = jest.fn();
jest.mock("@/hooks/useTagCreate", () => ({
  useTagCreate: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

let mockSuggestions: { tag: string; subscribers: number }[] = [];
jest.mock("@/hooks/useTagSuggestions", () => ({
  useTagSuggestions: () => ({ data: mockSuggestions }),
}));

// eslint-disable-next-line import/first -- must follow the hook mocks.
import Tags from "../app/(tabs)/tags";

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

afterEach(() => {
  authStore.__resetAuthStateForTests();
  mockMutate.mockClear();
  mockSuggestions = [];
});

describe("tags — creating a tag ahead of use", () => {
  it("offers '+ New' to an editor-or-better session", async () => {
    await render(<Tags />, { wrapper });
    expect(screen.getByLabelText("Create a tag")).toBeTruthy();
  });

  it("OMITS the affordance for a viewer — not a disabled ghost", async () => {
    authStore.__setAuthStateForTests({
      session: { effectiveRole: "viewer", role: "viewer" },
    });
    await render(<Tags />, { wrapper });
    expect(screen.queryByLabelText("Create a tag")).toBeNull();
  });

  it("opens the sheet and hands the typed draft to the mutation", async () => {
    await render(<Tags />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Create a tag"));
    expect(screen.getByText("New tag")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Tag name"), "vip");
    await fireEvent.press(screen.getByLabelText("Colour Teal"));
    await fireEvent.changeText(
      screen.getByLabelText("Tag description"),
      "Top accounts",
    );
    await fireEvent.press(screen.getByLabelText("Create tag"));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0]?.[0]).toEqual({
      name: "vip",
      color: "teal",
      description: "Top accounts",
      groupId: "",
    });
  });

  it("refuses an empty draft instead of posting it", async () => {
    await render(<Tags />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Create a tag"));
    await fireEvent.press(screen.getByLabelText("Create tag"));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("shows the dedup sentence when the name already exists in the taxonomy", async () => {
    mockSuggestions = [{ tag: "VIP", subscribers: 41 }];
    await render(<Tags />, { wrapper });
    await fireEvent.press(screen.getByLabelText("Create a tag"));
    await fireEvent.changeText(screen.getByLabelText("Tag name"), "vip");
    expect(screen.getByText(/41 subscribers already carry/)).toBeTruthy();
  });
});
