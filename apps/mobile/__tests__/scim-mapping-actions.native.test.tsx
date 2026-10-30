/**
 * SCIM role-mapping WRITE verbs on app/(tabs)/scim.tsx — upsert through the
 * MappingEditSheet, delete through a destructive confirm.
 *
 * What these tests pin, and why:
 *  - LOCAL REFUSAL FIRST — a draft the server would 400 (empty group name)
 *    never leaves the phone.
 *  - THE CONFIRM IS PART OF THE VERB — a wrong mapping over-grants a role to
 *    a whole IdP group; deleting one is destructive and a declined confirm
 *    must stop the mutation entirely.
 *  - THE UPSERT SENDS THE NORMALISED DRAFT — trimmed group, parsed
 *    precedence — because the server upserts on (tenant, group_name) and a
 *    padded name would silently create a second rule.
 *  - THE VERBS CAN BE HIT AND REACHED (A11Y-7) — Edit, Delete and Add mapping
 *    were bare 13pt `<Text onPress>` with no target, and the card was ONE
 *    accessibility element, so VoiceOver could not focus Delete at all.
 *
 * A separate suite from scim-screen.native.test.tsx so that file's read-path
 * assertions keep running against the REAL useScimMappingOps module graph.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as ScimHooks from "@/hooks/useScimOps";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";

import Scim from "../app/(tabs)/scim";

jest.mock("@/hooks/useScimMappingOps", () =>
  require("./mocks/queryHooks.cjs"),
);

// The confirm sheet, controllable: resolves the queued answer and records
// what the operator was actually asked.
const mockConfirmCalls: Record<string, unknown>[] = [];
let mockConfirmAnswer = true;
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => async (options: Record<string, unknown>) => {
    mockConfirmCalls.push(options);
    return mockConfirmAnswer;
  },
}));

const harness = ScimHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

function loaded(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    dataUpdatedAt: Date.now(),
    refetch: async () => ({ data }),
  };
}

function mutationResult(mutate: unknown) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate,
    mutateAsync: jest.fn(async () => ({})),
    reset: jest.fn(),
    variables: undefined,
  };
}

const MAPPING = {
  id: "m1",
  group_name: "Engineering",
  role: "editor",
  precedence: 10,
};

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

async function renderScim(upsertMutate = jest.fn(), deleteMutate = jest.fn()) {
  harness.__setHookResultForTests("useMobileScimTokens", loaded([]));
  harness.__setHookResultForTests(
    "useMobileScimRoleMappings",
    loaded([MAPPING]),
  );
  harness.__setHookResultForTests(
    "useUpsertScimMapping",
    mutationResult(upsertMutate),
  );
  harness.__setHookResultForTests(
    "useDeleteScimMapping",
    mutationResult(deleteMutate),
  );
  await render(<Scim />, { wrapper });
  return { upsertMutate, deleteMutate };
}

afterEach(() => {
  harness.__resetOnlineGateForTests();
  harness.__resetHookResultsForTests();
  mockConfirmCalls.length = 0;
  mockConfirmAnswer = true;
});

describe("role-mapping delete", () => {
  it("deletes through a destructive confirm that names the group and role", async () => {
    const { deleteMutate } = await renderScim();
    await fireEvent.press(
      screen.getByLabelText("Delete the mapping for Engineering"),
    );
    await Promise.resolve();
    expect(mockConfirmCalls).toHaveLength(1);
    expect(mockConfirmCalls[0]?.destructive).toBe(true);
    expect(String(mockConfirmCalls[0]?.title)).toMatch(/“Engineering”/);
    expect(deleteMutate).toHaveBeenCalledWith("m1", expect.anything());
  });

  it("a declined confirm stops the delete entirely", async () => {
    mockConfirmAnswer = false;
    const { deleteMutate } = await renderScim();
    await fireEvent.press(
      screen.getByLabelText("Delete the mapping for Engineering"),
    );
    await Promise.resolve();
    expect(mockConfirmCalls).toHaveLength(1);
    expect(deleteMutate).not.toHaveBeenCalled();
  });
});

describe("role-mapping upsert sheet", () => {
  it("refuses an empty group name locally — nothing leaves the phone", async () => {
    const { upsertMutate } = await renderScim();
    await fireEvent.press(screen.getByLabelText("Add a role mapping"));
    await fireEvent.press(screen.getByLabelText("Save role mapping"));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText("An IdP group name is required ('*' is the catch-all)."),
    ).toBeTruthy();
  });

  it("speaks the refusal on iOS and marks it an alert for Android (A11Y-3)", async () => {
    // jest-expo renders as iOS, where only announce() is heard (lib/a11y.ts);
    // Android's screen readers need the alert role and live region instead.
    const spoken = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    try {
      const { upsertMutate } = await renderScim();
      await fireEvent.press(screen.getByLabelText("Add a role mapping"));
      spoken.mockClear();
      await fireEvent.press(screen.getByLabelText("Save role mapping"));
      const refusal =
        "An IdP group name is required ('*' is the catch-all).";
      expect(upsertMutate).not.toHaveBeenCalled();
      expect(spoken).toHaveBeenCalledWith(refusal);
      expect(screen.getByText(refusal).props).toMatchObject({
        accessibilityRole: "alert",
        accessibilityLiveRegion: "assertive",
      });
    } finally {
      spoken.mockRestore();
    }
  });

  it("saves a new mapping with the normalised draft", async () => {
    const { upsertMutate } = await renderScim();
    await fireEvent.press(screen.getByLabelText("Add a role mapping"));
    await fireEvent.changeText(
      screen.getByLabelText("IdP group name"),
      "  Support  ",
    );
    await fireEvent.press(screen.getByLabelText("Role admin"));
    await fireEvent.changeText(
      screen.getByLabelText("Precedence, 0 to 1000, lower wins"),
      "20",
    );
    await fireEvent.press(screen.getByLabelText("Save role mapping"));
    expect(upsertMutate).toHaveBeenCalledWith(
      { groupName: "Support", role: "admin", precedence: 20 },
      expect.anything(),
    );
  });

  it("edit pre-fills the sheet from the row it was opened for", async () => {
    await renderScim();
    await fireEvent.press(
      screen.getByLabelText("Edit the mapping for Engineering"),
    );
    expect(screen.getByLabelText("IdP group name").props.value).toBe(
      "Engineering",
    );
    expect(
      screen.getByLabelText("Precedence, 0 to 1000, lower wins").props.value,
    ).toBe("10");
  });
});

type Host = ReturnType<typeof screen.getByLabelText>;

/** The nearest host ancestor that makes itself ONE iOS accessibility element —
 * which hides every button inside it from VoiceOver's swipe order. */
function accessibleAncestor(node: Host): Host | null {
  for (let at = node.parent; at; at = at.parent) {
    if (typeof at.type === "string" && at.props.accessible === true) return at;
  }
  return null;
}

describe("role-mapping verbs are reachable (A11Y-7)", () => {
  const VERBS = [
    "Edit the mapping for Engineering",
    "Delete the mapping for Engineering",
    "Add a role mapping",
  ];

  it("each verb is a button with a 44pt target and a hit slop", async () => {
    await renderScim();
    for (const label of VERBS) {
      const node = screen.getByLabelText(label);
      expect({ label, role: node.props.accessibilityRole }).toEqual({
        label,
        role: "button",
      });
      const minHeight = StyleSheet.flatten(node.props.style)?.minHeight;
      expect({ label, minHeight }).toEqual({
        label,
        minHeight: expect.any(Number),
      });
      expect(minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect({ label, hitSlop: node.props.hitSlop }).toEqual({
        label,
        hitSlop: 8,
      });
    }
  });

  it("Edit and Delete are separately focusable, and the row still speaks its summary", async () => {
    await renderScim();
    for (const label of VERBS.slice(0, 2)) {
      expect({
        label,
        swallowedBy:
          accessibleAncestor(screen.getByLabelText(label))?.props
            .accessibilityLabel ?? null,
      }).toEqual({ label, swallowedBy: null });
    }
    // Moving `accessible` off the Card must not lose the one-swipe summary.
    const summary = screen.getByLabelText(
      "Engineering, role editor, precedence 10.",
    );
    expect(summary.props.accessible).toBe(true);
    expect(accessibleAncestor(summary)).toBeNull();
  });

  it("Delete says it opens a confirmation, not that it deletes on tap", async () => {
    await renderScim();
    expect(
      screen.getByLabelText("Delete the mapping for Engineering").props
        .accessibilityHint,
    ).toBe("Opens a confirmation");
  });

  it("offline, Edit and Delete stay visible but inert — and say so", async () => {
    harness.__setOnlineGateForTests({ enabled: false });
    const { deleteMutate } = await renderScim();
    const del = screen.getByLabelText("Delete the mapping for Engineering");
    const edit = screen.getByLabelText("Edit the mapping for Engineering");
    expect(del.props.accessibilityState).toEqual({ disabled: true });
    expect(edit.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(del);
    await fireEvent.press(edit);
    await Promise.resolve();
    expect(mockConfirmCalls).toHaveLength(0);
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("IdP group name")).toBeNull();
    // Creating a mapping is not offered at all while the gate is closed.
    expect(screen.queryByLabelText("Add a role mapping")).toBeNull();
  });
});
