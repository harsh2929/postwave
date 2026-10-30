/**
 * Feature-flag override authoring — the render contract for the sheet. The
 * transport seam is pinned in src/api/featureFlagOverrides.test.ts; what is
 * pinned here is what makes an override from a phone not a mis-tap:
 *
 *  1. THE FORM REFUSES WHAT THE SERVER WOULD 400, with the field named, and
 *     sends the trimmed body the server would store.
 *  2. THE KEY IS FIXED WHEN EDITING: shown verbatim, not typed.
 *  3. BOTH DESTRUCTIVE VERBS ARE GATED. Removing an override parks on the
 *     confirm sheet with desktop's consequence sentence; closing a dirty
 *     draft parks on desktop's discard confirm. A cancel sends nothing.
 *
 * A platform-default row opens with no note (the platform's reason is not the
 * workspace's) and no Remove. Below admin the fields read only.
 *
 * `useFeatureFlagOverrides` is mocked explicitly: both exports are mutations,
 * which the queryHooks proxy would hand back in the query shape.
 *
 * The sheet's own footer buttons ("Create override", "Save override",
 * "Remove override", "Close feature flag") never share a label with the
 * ConfirmSheet's ("Cancel", "Remove", "Discard draft"), so every
 * getByLabelText below is unambiguous by construction.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ADMIN_ONLY_NOTE } from "@/hooks/usePlatformConfigRole";
import {
  DEFAULT_ROW_NOTE,
  overrideRemovalConsequence,
} from "@/lib/featureFlagOverrides";
import type { FeatureFlagView } from "@/lib/platformConfig";
import * as AuthStore from "@/store/auth";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const OVERRIDE: FeatureFlagView = {
  key: "new_composer",
  value: "on",
  note: "Beta cohort",
  enabled: true,
  isDefault: false,
};

const DEFAULT: FeatureFlagView = {
  key: "new_composer",
  value: "off",
  note: "Platform-wide until GA",
  enabled: true,
  isDefault: true,
};

const mockUpsertCalls: unknown[] = [];
const mockRemoveCalls: unknown[] = [];
const mockUpsert = {
  isPending: false,
  mutate: (
    vars: { key: string; value: string; note: string },
    opts?: { onSuccess?: (r: { id: string; key: string; value: string }) => void },
  ) => {
    mockUpsertCalls.push(vars);
    opts?.onSuccess?.({ id: "f1", key: vars.key, value: vars.value });
  },
};
const mockRemove = {
  isPending: false,
  mutate: (key: string, opts?: { onSuccess?: () => void }) => {
    mockRemoveCalls.push(key);
    opts?.onSuccess?.();
  },
};

jest.mock("@/hooks/useFeatureFlagOverrides", () => ({
  useUpsertFeatureFlag: () => mockUpsert,
  useDeleteFeatureFlagOverride: () => mockRemove,
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import {
  DISCARD_DRAFT_CONFIRM,
  FeatureFlagSheet,
} from "@/components/settings/platform-config/FeatureFlagSheet";

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

async function renderSheet(
  flag: FeatureFlagView | null,
  onClose: () => void = jest.fn(),
) {
  await render(<FeatureFlagSheet visible flag={flag} onClose={onClose} />, {
    wrapper,
  });
  return onClose;
}

/** Let React commit what the last interaction queued (macrotask, not microtask). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  authHarness.__resetAuthStateForTests();
  mockUpsertCalls.length = 0;
  mockRemoveCalls.length = 0;
  mockUpsert.isPending = false;
  mockRemove.isPending = false;
});

describe("FeatureFlagSheet", () => {
  it("refuses a draft the server would 400, naming the field, then sends a trimmed one", async () => {
    const onClose = jest.fn();
    await renderSheet(null, onClose);
    // Untouched form: no wall of red yet.
    expect(screen.queryByText("Flag key is required.")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Create override"));
    expect(mockUpsertCalls).toEqual([]);
    expect(screen.getByText("Flag key is required.")).toBeTruthy();
    expect(
      screen.getByText("A value is required — “on” or “off” for a simple switch."),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Key"), " new composer ");
    await fireEvent.changeText(screen.getByLabelText("Value"), " on ");
    await fireEvent.press(screen.getByLabelText("Create override"));
    expect(screen.getByText("Flag key can’t contain spaces.")).toBeTruthy();
    expect(mockUpsertCalls).toEqual([]);
    await fireEvent.changeText(screen.getByLabelText("Key"), " new_composer ");
    await fireEvent.changeText(screen.getByLabelText("Note"), " beta ");
    await fireEvent.press(screen.getByLabelText("Create override"));
    expect(mockUpsertCalls).toEqual([
      { key: "new_composer", value: "on", note: "beta" },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing row's key fixed and saves only once something changed", async () => {
    await renderSheet(OVERRIDE);
    expect(screen.getByText("new_composer")).toBeTruthy();
    expect(screen.queryByLabelText("Key")).toBeNull();
    expect(screen.getByLabelText("Note").props.value).toBe("Beta cohort");
    expect(
      screen.getByLabelText("Save override").props.accessibilityState?.disabled,
    ).toBe(true);
    await fireEvent.changeText(screen.getByLabelText("Value"), "off");
    expect(
      screen.getByLabelText("Save override").props.accessibilityState?.disabled,
    ).toBe(false);
    await fireEvent.press(screen.getByLabelText("Save override"));
    expect(mockUpsertCalls).toEqual([
      { key: "new_composer", value: "off", note: "Beta cohort" },
    ]);
  });

  it("gates removal behind desktop's consequence sentence; cancel sends nothing", async () => {
    const onClose = jest.fn();
    await renderSheet(OVERRIDE, onClose);
    await fireEvent.press(screen.getByLabelText("Remove override"));
    await flush();
    expect(screen.getByText(overrideRemovalConsequence("new_composer"))).toBeTruthy();
    expect(mockRemoveCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    expect(mockRemoveCalls).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Remove override"));
    await flush();
    await fireEvent.press(screen.getByLabelText("Remove"));
    await flush();
    expect(mockRemoveCalls).toEqual(["new_composer"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a platform default with no note and no Remove, and explains the override", async () => {
    await renderSheet(DEFAULT);
    expect(screen.getByLabelText("Note").props.value).toBe("");
    expect(screen.getByLabelText("Value").props.value).toBe("off");
    expect(screen.getByText(DEFAULT_ROW_NOTE)).toBeTruthy();
    expect(screen.queryByLabelText("Remove override")).toBeNull();
  });

  it("closes a clean sheet at once but parks a dirty one on the discard confirm", async () => {
    const onClose = jest.fn();
    await renderSheet(OVERRIDE, onClose);
    await fireEvent.press(screen.getByLabelText("Close feature flag"));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(screen.getByLabelText("Value"), "off");
    await fireEvent.press(screen.getByLabelText("Close feature flag"));
    await flush();
    expect(screen.getByText(DISCARD_DRAFT_CONFIRM.title)).toBeTruthy();
    expect(screen.getByText(DISCARD_DRAFT_CONFIRM.message)).toBeTruthy();
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText(DISCARD_DRAFT_CONFIRM.confirmLabel));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mockUpsertCalls).toEqual([]);
  });

  it("keeps a dirty draft when the discard is cancelled", async () => {
    const onClose = jest.fn();
    await renderSheet(OVERRIDE, onClose);
    await fireEvent.changeText(screen.getByLabelText("Value"), "off");
    await fireEvent.press(screen.getByLabelText("Close feature flag"));
    await flush();
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Value").props.value).toBe("off");
  });

  it("lets a viewer read the row but type nothing and offers no write", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "viewer", effectiveRole: "viewer" },
    });
    await renderSheet(OVERRIDE);
    expect(screen.getByText(ADMIN_ONLY_NOTE)).toBeTruthy();
    expect(screen.getByLabelText("Value").props.editable).toBe(false);
    expect(screen.getByLabelText("Value").props.value).toBe("on");
    expect(screen.queryByLabelText("Save override")).toBeNull();
    expect(screen.queryByLabelText("Remove override")).toBeNull();
  });
});
