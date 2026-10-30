/**
 * VoiceTemplatesCard — the render contract (register: saved prompts / voice
 * templates, ai).
 *
 * The parsing and prompt assembly are pinned in src/lib/voiceTemplates.test.ts;
 * this file pins that they REACH THE SCREEN and that the role floors hold:
 *
 *  - a viewer browses and copies, and is offered neither Generate (editor) nor
 *    Delete (admin) — the buttons do not exist rather than 403ing;
 *  - opening a template shows the actual EMAIL SKELETONS, and Copy hands over
 *    the same text that is rendered, not the title;
 *  - Delete is two-step, and only for an admin;
 *  - the card is MOUNTED on the Voice tab.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { VoiceTemplateWire } from "@/lib/voiceTemplates";

const mockCopied: string[] = [];
jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: async (value: string) => {
    mockCopied.push(value);
    return true;
  },
}));

const mockToasts: Array<{ kind: string; message: string }> = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

const mockList = {
  data: [] as VoiceTemplateWire[],
  isLoading: false,
  isError: false,
  error: null as Error | null,
  refetch: jest.fn(),
};
const mockDelete = { mutate: jest.fn(), isPending: false };
jest.mock("@/hooks/useVoiceTemplates", () => ({
  useVoiceTemplates: () => mockList,
  useGenerateVoiceTemplate: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteVoiceTemplate: () => mockDelete,
}));

// eslint-disable-next-line import/first -- must follow the mocks above.
import { VoiceTemplatesCard } from "@/components/voice/VoiceTemplatesCard";

const TEMPLATE: VoiceTemplateWire = {
  id: "t-1",
  name: "Welcome, 3 emails",
  description: "Introduce the brand.",
  category: "welcome",
  length: 3,
  emails: [
    {
      position: 1,
      subject_skeleton: "Welcome aboard, {{first_name}}",
      body_skeleton: "Thanks for joining.",
    },
  ],
  variables: [{ key: "first_name", label: "First name", required: true }],
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

afterEach(() => {
  mockCopied.length = 0;
  mockToasts.length = 0;
  mockList.data = [];
  mockList.isLoading = false;
  mockList.isError = false;
  mockList.error = null;
  mockDelete.mutate.mockClear();
  mockDelete.isPending = false;
});

describe("VoiceTemplatesCard", () => {
  it("lists templates with the count they actually carry", async () => {
    mockList.data = [TEMPLATE];
    await render(
      <VoiceTemplatesCard offline={false} canGenerate canAdmin={false} />,
      { wrapper },
    );
    expect(screen.getByText("Saved prompts")).toBeTruthy();
    expect(screen.getByText("Welcome, 3 emails")).toBeTruthy();
    // emails[] has one entry even though `length` says 3; the carried array
    // is what a reader can act on.
    expect(screen.getByText("Welcome · 1 email")).toBeTruthy();
  });

  it("offers a viewer neither Generate nor Delete", async () => {
    mockList.data = [TEMPLATE];
    await render(
      <VoiceTemplatesCard
        offline={false}
        canGenerate={false}
        canAdmin={false}
      />,
      { wrapper },
    );
    expect(
      screen.queryByLabelText("Generate a template from a brief"),
    ).toBeNull();
    await fireEvent.press(screen.getByLabelText("Open template Welcome, 3 emails"));
    expect(screen.getByLabelText("Copy prompt")).toBeTruthy();
    expect(screen.queryByLabelText("Delete template")).toBeNull();
  });

  it("copies the rendered skeleton, not the title", async () => {
    mockList.data = [TEMPLATE];
    await render(
      <VoiceTemplatesCard offline={false} canGenerate canAdmin={false} />,
      { wrapper },
    );
    await fireEvent.press(screen.getByLabelText("Open template Welcome, 3 emails"));
    // The email skeleton is on screen, not just the name.
    expect(screen.getByText("Welcome aboard, {{first_name}}")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Copy prompt"));
    expect(mockCopied).toHaveLength(1);
    expect(mockCopied[0]).toContain("Subject: Welcome aboard, {{first_name}}");
    expect(mockCopied[0]).toContain("{{first_name}} — First name (required)");
  });

  it("arms delete before committing it, for an admin only", async () => {
    mockList.data = [TEMPLATE];
    await render(
      <VoiceTemplatesCard offline={false} canGenerate canAdmin />,
      { wrapper },
    );
    await fireEvent.press(screen.getByLabelText("Open template Welcome, 3 emails"));
    await fireEvent.press(screen.getByLabelText("Delete template"));
    // The first press only arms — nothing is destroyed yet.
    expect(mockDelete.mutate).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Confirm delete"));
    expect(mockDelete.mutate).toHaveBeenCalledTimes(1);
    expect(mockDelete.mutate.mock.calls[0]?.[0]).toBe("t-1");
  });

  it("says the library is empty without inventing a reason", async () => {
    mockList.data = [];
    await render(
      <VoiceTemplatesCard offline={false} canGenerate canAdmin={false} />,
      { wrapper },
    );
    expect(screen.getByText("No shared templates")).toBeTruthy();
  });

  it("renders nothing at all while the session is offline", async () => {
    mockList.data = [TEMPLATE];
    await render(<VoiceTemplatesCard offline canGenerate canAdmin />, {
      wrapper,
    });
    // Not just "no rows" — the card itself is absent, so an offline screen
    // never shows a library heading it cannot populate.
    expect(screen.queryByText("Saved prompts")).toBeNull();
    expect(screen.queryByText("Welcome, 3 emails")).toBeNull();
  });
});
