/**
 * Article50ReadinessCard — the AIVS inspector-bundle export flow.
 *
 * What these tests pin, and why:
 *  - LOCAL REFUSAL FIRST — a session id the server could only 404 never
 *    leaves the phone.
 *  - THE FILE, NOT THE URL — the share sheet receives a file:// uri whose
 *    bytes were fetched through the authenticated session and written to the
 *    app cache. Handing the OS a session-streamed https URL is the exact
 *    defect the AuditExportSheet doctrine exists to prevent.
 *  - A 403 READS AS A PERMISSION RULE, and a failed fetch never opens the
 *    share sheet.
 *  - Below admin the card renders nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { Share } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Article50ReadinessCard } from "../src/components/compliance/Article50ReadinessCard";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useComplianceEvidence", () =>
  require("./mocks/queryHooks.cjs"),
);

const mockFetchAivsBundle = jest.fn<
  (sessionId: string) => Promise<{ bytes: Uint8Array; filename: string }>
>();
jest.mock("@/api/complianceEvidence", () => ({
  fetchAivsBundle: (sessionId: string) => mockFetchAivsBundle(sessionId),
}));

// The new expo-file-system object API, capturing what gets written where.
const mockFileWrites: { uri: string; bytes: Uint8Array }[] = [];
jest.mock("expo-file-system", () => ({
  Paths: { cache: "file:///caches/" },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join("");
    }
    create() {}
    write(bytes: Uint8Array) {
      mockFileWrites.push({ uri: this.uri, bytes });
    }
  },
}));

// jest.routes.config.cjs sets restoreMocks, so the spy must be installed
// per test — a module-scope spy silently reverts to the REAL native Share
// (which throws) after the first test.
let shareSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  shareSpy = jest
    .spyOn(Share, "share")
    .mockResolvedValue({ action: "sharedAction" } as never);
});

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function renderCard(allowed = true) {
  queryHooks.__setHookResultForTests(
    "useAgentEventWindow",
    queryResult({ data: 3 }),
  );
  return render(<Article50ReadinessCard allowed={allowed} />, {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  mockFetchAivsBundle.mockReset();
  mockFileWrites.length = 0;
  /* restoreMocks handles the share spy */
});

describe("AIVS bundle export", () => {
  it("renders nothing at all below admin", async () => {
    const result = await renderCard(false);
    expect(result.queryByText("AI transparency")).toBeNull();
    expect(result.queryByLabelText("AI session id")).toBeNull();
  });

  it("refuses an empty session id locally — nothing leaves the phone", async () => {
    const result = await renderCard();
    await fireEvent.press(
      result.getByLabelText("Fetch and share the AIVS inspector bundle"),
    );
    expect(mockFetchAivsBundle).not.toHaveBeenCalled();
    expect(
      result.getByText("Paste the session id from an agent audit row first."),
    ).toBeTruthy();
  });

  it("fetches, writes the CACHE FILE, and hands the file uri to the share sheet", async () => {
    mockFetchAivsBundle.mockResolvedValue({
      bytes: new Uint8Array([7, 7, 7]),
      filename: "aivs-sess-1.tar.gz",
    });
    const result = await renderCard();
    await fireEvent.changeText(
      result.getByLabelText("AI session id"),
      "sess-1",
    );
    await fireEvent.press(
      result.getByLabelText("Fetch and share the AIVS inspector bundle"),
    );
    expect(await result.findByText(/handed it to the share sheet/)).toBeTruthy();
    expect(mockFetchAivsBundle).toHaveBeenCalledWith("sess-1");
    expect(mockFileWrites).toHaveLength(1);
    expect(mockFileWrites[0]?.uri).toBe("file:///caches/aivs-sess-1.tar.gz");
    expect(Array.from(mockFileWrites[0]?.bytes ?? [])).toEqual([7, 7, 7]);
    expect(shareSpy).toHaveBeenCalledWith({
      url: "file:///caches/aivs-sess-1.tar.gz",
      title: "aivs-sess-1.tar.gz",
    });
  });

  it("shows the permission sentence on a 403 and never opens the sheet", async () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    mockFetchAivsBundle.mockRejectedValue(err);
    const result = await renderCard();
    await fireEvent.changeText(
      result.getByLabelText("AI session id"),
      "sess-1",
    );
    await fireEvent.press(
      result.getByLabelText("Fetch and share the AIVS inspector bundle"),
    );
    expect(await result.findByText(/permission rule/)).toBeTruthy();
    expect(mockFileWrites).toHaveLength(0);
    expect(shareSpy).not.toHaveBeenCalled();
  });

  it("names a session with no agent events in the server's own terms", async () => {
    const err = Object.assign(new Error("none"), {
      status: 404,
      code: "no_agent_events",
    });
    mockFetchAivsBundle.mockRejectedValue(err);
    const result = await renderCard();
    await fireEvent.changeText(
      result.getByLabelText("AI session id"),
      "sess-9",
    );
    await fireEvent.press(
      result.getByLabelText("Fetch and share the AIVS inspector bundle"),
    );
    expect(
      await result.findByText("No AI agent events found for this session id."),
    ).toBeTruthy();
    expect(shareSpy).not.toHaveBeenCalled();
  });
});
