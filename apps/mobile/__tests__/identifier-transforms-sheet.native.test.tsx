/**
 * Identifier-transforms editor — the render contract for the sheet. The
 * transport seam is pinned in src/api/identifierTransformsEdit.test.ts; what
 * is pinned here is the register's two conditions for letting a phone edit
 * workspace-wide rewrite rules:
 *
 *  1. THE PREVIEW SHOWS THE UNSAVED DRAFT. Flipping a rule changes the
 *     `overrides` the preview hook is asked for, and a failed preview says so
 *     instead of rendering an empty, reassuring one.
 *  2. THE SAVE IS GATED. Under the real ConfirmProvider the press parks on the
 *     confirm sheet, shows the scope sentence and the changed rule, and sends
 *     NOTHING until "Save" is pressed — and then sends ONLY the changed field.
 *
 * Below admin the switches are disabled, the rule is stated, and no Save
 * button exists to 403.
 *
 * `useIdentifierTransformsEdit` is mocked explicitly: it exports a mutation
 * and a preview query, which the queryHooks proxy would hand back in one
 * shape.
 *
 * The sheet's footer ("Save rules", "Close identifier transforms") never
 * shares a label with the ConfirmSheet's ("Cancel", "Save"), so every
 * getByLabelText below is unambiguous.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ADMIN_ONLY_NOTE } from "@/hooks/usePlatformConfigRole";
import {
  normalizeTransformPreview,
  TRANSFORM_SCOPE_SENTENCE,
} from "@/lib/identifierTransformsEdit";
import type { IdentifierTransformsView } from "@/lib/platformConfig";
import * as AuthStore from "@/store/auth";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const SERVER: IdentifierTransformsView = {
  emailNormalizeDots: false,
  emailNormalizePlus: true,
  phoneE164Format: false,
  phoneDefaultRegion: "",
};

const PREVIEW = normalizeTransformPreview({
  email_input: "J.o.h.n+promo@Gmail.com",
  email_output: "john@gmail.com",
  email_changed: true,
  phones: [
    {
      key: "phone",
      input: "(202) 555-0147",
      output: "+12025550147",
      changed: true,
    },
  ],
});

type Query = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
  isFetching: boolean;
};

function query(data: unknown, over: Partial<Query> = {}): Query {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isFetching: false,
    ...over,
  };
}

const mockPreview: { current: Query } = { current: query(PREVIEW) };
const mockPreviewCalls: unknown[] = [];
const mockSaveCalls: unknown[] = [];
const mockSave = {
  isPending: false,
  mutate: (vars: unknown, opts?: { onSuccess?: () => void }) => {
    mockSaveCalls.push(vars);
    opts?.onSuccess?.();
  },
};

jest.mock("@/hooks/useIdentifierTransformsEdit", () => ({
  useUpdateIdentifierTransforms: () => mockSave,
  useIdentifierTransformPreview: (body: unknown) => {
    mockPreviewCalls.push(body);
    return mockPreview.current;
  },
}));

// eslint-disable-next-line import/first -- must follow the hook mock.
import { IdentifierTransformsSheet } from "@/components/settings/platform-config/IdentifierTransformsSheet";

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

const noop = () => undefined;

async function renderSheet(
  server: IdentifierTransformsView = SERVER,
  onClose: () => void = noop,
) {
  await render(
    <IdentifierTransformsSheet visible server={server} onClose={onClose} />,
    { wrapper },
  );
}

/** Let React commit what the last interaction queued (macrotask, not microtask). */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function lastPreviewBody() {
  return mockPreviewCalls[mockPreviewCalls.length - 1] as {
    email: string;
    custom_fields: Record<string, string>;
    overrides: Record<string, unknown>;
  } | null;
}

afterEach(() => {
  authHarness.__resetAuthStateForTests();
  mockPreview.current = query(PREVIEW);
  mockPreviewCalls.length = 0;
  mockSaveCalls.length = 0;
  mockSave.isPending = false;
});

describe("IdentifierTransformsSheet", () => {
  it("opens on the saved rules and previews the sample against them", async () => {
    await renderSheet();
    expect(screen.getByLabelText("Drop “+tag” sub-addresses").props.value).toBe(true);
    expect(screen.getByLabelText("Remove dots from the local-part").props.value).toBe(false);
    // The default sample rides in the body, the draft as `overrides`.
    expect(lastPreviewBody()).toEqual({
      email: "J.o.h.n+promo@Gmail.com",
      custom_fields: { phone: "(202) 555-0147" },
      overrides: {
        email_normalize_dots: false,
        email_normalize_plus: true,
        phone_e164_format: false,
        phone_default_region: "",
      },
    });
    expect(screen.getByText("J.o.h.n+promo@Gmail.com → john@gmail.com")).toBeTruthy();
    expect(screen.getByText("(202) 555-0147 → +12025550147")).toBeTruthy();
    // Nothing changed yet, so there is nothing to save.
    expect(
      screen.getByLabelText("Save rules").props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("re-asks the preview with the UNSAVED draft the moment a rule flips", async () => {
    await renderSheet();
    await fireEvent(screen.getByLabelText("Drop “+tag” sub-addresses"), "valueChange", false);
    expect(lastPreviewBody()?.overrides.email_normalize_plus).toBe(false);
    expect(
      screen.getByLabelText("Save rules").props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it("asks no preview for an empty sample, and says so", async () => {
    await renderSheet();
    await fireEvent.changeText(screen.getByLabelText("Sample email"), "  ");
    await fireEvent.changeText(screen.getByLabelText("Sample phone"), "");
    expect(lastPreviewBody()).toBeNull();
    expect(
      screen.getByText("Type a sample email or phone to preview the rules."),
    ).toBeTruthy();
  });

  it("says a failed preview FAILED rather than rendering an empty one", async () => {
    mockPreview.current = query(undefined, {
      isError: true,
      error: Object.assign(new Error("HTTP 500"), { status: 500 }),
    });
    await renderSheet();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/no change/u)).toBeNull();
    expect(screen.queryByText(/nothing is stored/u)).toBeNull();
  });

  it("parks the save on the confirm sheet and a cancel sends nothing", async () => {
    await renderSheet();
    await fireEvent(screen.getByLabelText("Drop “+tag” sub-addresses"), "valueChange", false);
    await fireEvent.press(screen.getByLabelText("Save rules"));
    await flush();
    expect(screen.getByText(TRANSFORM_SCOPE_SENTENCE)).toBeTruthy();
    expect(screen.getByText("“+tag” sub-addresses will be kept")).toBeTruthy();
    expect(mockSaveCalls).toEqual([]);
    await fireEvent.press(screen.getByLabelText("Cancel"));
    await flush();
    expect(mockSaveCalls).toEqual([]);
  });

  it("sends ONLY the changed field once confirmed, then closes", async () => {
    const onClose = jest.fn();
    await renderSheet(SERVER, onClose);
    await fireEvent(screen.getByLabelText("Drop “+tag” sub-addresses"), "valueChange", false);
    await fireEvent.press(screen.getByLabelText("Save rules"));
    await flush();
    await fireEvent.press(screen.getByLabelText("Save"));
    await flush();
    expect(mockSaveCalls).toEqual([{ email_normalize_plus: false }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the region only under E.164 and sends the region change alone", async () => {
    await renderSheet({ ...SERVER, phoneE164Format: true });
    // The empty code is named by the list's own entry, not a bare "None".
    const NONE = "Default region: None (international numbers only)";
    expect(screen.getByLabelText(NONE)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(NONE));
    await fireEvent.press(screen.getByLabelText("United Kingdom (+44)"));
    expect(screen.getByLabelText("Default region: United Kingdom (+44)")).toBeTruthy();
    expect(lastPreviewBody()?.overrides.phone_default_region).toBe("GB");
    await fireEvent.press(screen.getByLabelText("Save rules"));
    await flush();
    expect(screen.getByText("National-format numbers will default to GB")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Save"));
    await flush();
    expect(mockSaveCalls).toEqual([{ phone_default_region: "GB" }]);
  });

  it("hides the region row while E.164 is off", async () => {
    await renderSheet();
    expect(screen.queryByLabelText(/^Default region:/u)).toBeNull();
  });

  it("lets a viewer see the rules, disabled, and offers no Save", async () => {
    authHarness.__setAuthStateForTests({
      mode: "session",
      session: { role: "viewer", effectiveRole: "viewer" },
    });
    await renderSheet();
    expect(screen.getByText(ADMIN_ONLY_NOTE)).toBeTruthy();
    expect(
      screen.getByLabelText("Drop “+tag” sub-addresses").props.accessibilityState
        ?.disabled,
    ).toBe(true);
    expect(screen.queryByLabelText("Save rules")).toBeNull();
    // The state is still visible — a viewer came to SEE it.
    expect(screen.getByLabelText("Drop “+tag” sub-addresses").props.value).toBe(true);
  });
});
